import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publicBookingRouter } from '../../../src/modules/public-booking/publicBooking.routes';
import {
  createIntakeSubmission,
  markFailed,
  markProcessed,
  markProcessing,
} from '../../../src/modules/intake/intake.repository';
import { processIntake } from '../../../src/modules/intake/intake.service';

vi.mock('../../../src/modules/intake/intake.repository', () => ({
  createIntakeSubmission: vi.fn(),
  markProcessing: vi.fn(),
  markProcessed: vi.fn(),
  markFailed: vi.fn(),
}));

vi.mock('../../../src/modules/intake/intake.service', () => ({
  processIntake: vi.fn(),
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/public', publicBookingRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'TEST_ERROR', message: err.message });
  });
  return app;
}

const validPayload = {
  firstName: 'Jane',
  lastName: 'Smith',
  email: 'jane@example.com',
  phone: '(404) 555-1234',
  addressLine1: '123 Main St',
  city: 'Hampton',
  serviceType: 'small',
  appointmentWindow: 'Morning(8am-12pm)',
};

describe('POST /public/bookings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createIntakeSubmission).mockResolvedValue({
      id: 'sub-123',
      source: 'web',
      external_submission_id: 'web-external',
      raw_payload_json: {},
      normalized_payload_json: null,
      received_at: new Date(),
      processed_at: null,
      processing_status: 'received',
      idempotency_key: 'web:web-external',
      correlation_id: 'corr-123',
      error_message: null,
    });
    vi.mocked(markProcessing).mockResolvedValue();
    vi.mocked(markProcessed).mockResolvedValue();
    vi.mocked(markFailed).mockResolvedValue();
    vi.mocked(processIntake).mockResolvedValue({
      jobId: 'job-123',
      jobKey: 'AC-2026-TEST',
      publicPayToken: 'ppt_test',
      status: 'awaiting_payment',
      serviceAreaStatus: 'in_area',
      totalAmountCents: 10900,
      checkoutRequired: true,
    });
  });

  it('creates a web intake submission and returns the public payment payload', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/public/bookings')
      .send(validPayload)
      .expect(201);

    expect(res.body).toEqual({
      jobKey: 'AC-2026-TEST',
      publicPayToken: 'ppt_test',
      status: 'awaiting_payment',
      serviceAreaStatus: 'in_area',
      totalAmountCents: 10900,
      checkoutRequired: true,
    });

    const createArgs = vi.mocked(createIntakeSubmission).mock.calls[0][0];
    expect(createArgs.source).toBe('web');
    expect(createArgs.externalSubmissionId).toMatch(/^web-/);
    expect(createArgs.idempotencyKey).toBe(`web:${createArgs.externalSubmissionId}`);
    expect(createArgs.rawPayload).toEqual({
      ...validPayload,
      state: 'GA',
      rushType: 'No Rush',
      paymentType: 'deposit',
    });

    const [submissionId, intake, correlationId, opts] = vi.mocked(processIntake).mock.calls[0];
    expect(submissionId).toBe('sub-123');
    expect(correlationId).toEqual(expect.any(String));
    expect(opts).toEqual({ sourceChannel: 'web' });
    expect(intake).toMatchObject({
      externalSubmissionId: createArgs.externalSubmissionId,
      customer: {
        firstName: 'Jane',
        lastName: 'Smith',
        fullName: 'Jane Smith',
        email: 'jane@example.com',
        phone: '+14045551234',
      },
      address: {
        line1: '123 Main St',
        city: 'Hampton',
        state: 'GA',
      },
      service: {
        typeCode: 'small',
        rushRequested: false,
        rushType: 'No Rush',
      },
      appointment: {
        window: 'Morning(8am-12pm)',
      },
      financials: {
        paymentType: 'deposit',
      },
      media: [],
      source: {
        formName: 'web-booking',
        raw: createArgs.rawPayload,
      },
    });
    expect(intake.meta).toBeUndefined();
    expect(markProcessing).toHaveBeenCalledWith('sub-123');
    expect(markProcessed).toHaveBeenCalledWith('sub-123', intake);
  });

  it.each([
    ['custom'],
    ['fitness_equipment'],
  ])('rejects unsupported service type %s', async (serviceType) => {
    const app = createTestApp();

    const res = await request(app)
      .post('/public/bookings')
      .send({ ...validPayload, serviceType })
      .expect(400);

    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(createIntakeSubmission).not.toHaveBeenCalled();
  });

  it('rejects unknown fields', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/public/bookings')
      .send({ ...validPayload, meta: { areaTag: 'inside' } })
      .expect(400);

    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(createIntakeSubmission).not.toHaveBeenCalled();
  });

  it('marks the submission failed when processing fails after persistence', async () => {
    const app = createTestApp();
    vi.mocked(processIntake).mockRejectedValueOnce(new Error('processing failed'));

    const res = await request(app)
      .post('/public/bookings')
      .send(validPayload)
      .expect(500);

    expect(res.body.message).toBe('processing failed');
    expect(markFailed).toHaveBeenCalledWith('sub-123', 'processing failed');
  });
});
