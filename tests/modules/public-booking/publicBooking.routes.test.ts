import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../../../src/db/pool';
import { publicBookingRouter } from '../../../src/modules/public-booking/publicBooking.routes';
import {
  createIntakeSubmission,
  markFailed,
  markProcessed,
  markProcessing,
} from '../../../src/modules/intake/intake.repository';
import { processIntake } from '../../../src/modules/intake/intake.service';
import { classifyServiceArea } from '../../../src/modules/service-areas/serviceArea.service';

vi.mock('../../../src/modules/intake/intake.repository', () => ({
  createIntakeSubmission: vi.fn(),
  markProcessing: vi.fn(),
  markProcessed: vi.fn(),
  markFailed: vi.fn(),
}));

vi.mock('../../../src/modules/intake/intake.service', () => ({
  processIntake: vi.fn(),
}));

vi.mock('../../../src/modules/service-areas/serviceArea.service', () => ({
  classifyServiceArea: vi.fn(),
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
  appointmentDate: '2099-06-15',
  appointmentWindow: 'Morning(8am-12pm)',
};

const validReviewPayload = {
  ...validPayload,
  serviceType: 'small',
  details: 'The preferred window was full, but I would like the owner to review it.',
};

function capacityRows(...serviceCodes: Array<string | null>) {
  return serviceCodes.map((service_type_code) => ({ service_type_code }));
}

function expectRecoverableCapacityResponse(body: Record<string, unknown>) {
  expect(body).toMatchObject({
    error: 'APPOINTMENT_SLOT_UNAVAILABLE',
    recoverable: true,
    manualReviewAvailable: true,
    message: 'This window is full for instant booking. Please choose another window or request manual review.',
    correlationId: expect.any(String),
  });
}

describe('publicBookingRouter', () => {
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
    vi.mocked(classifyServiceArea).mockResolvedValue({
      status: 'in_area',
      city: 'Hampton',
      state: 'GA',
    });
    vi.mocked(query).mockResolvedValue([]);
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
        date: '2099-06-15',
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

  it('creates a manual review request and returns only the customer-safe payload', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/public/review-requests')
      .send(validReviewPayload)
      .expect(201);

    expect(res.body).toEqual({
      requestId: 'AC-2026-TEST',
      publicPayToken: 'ppt_test',
      status: 'received',
      message: 'Your request was received for manual review.',
      correlationId: expect.any(String),
    });
    expect(res.body).not.toHaveProperty('checkoutUrl');
    expect(res.body).not.toHaveProperty('paymentToken');
    expect(res.body).not.toHaveProperty('jobId');
    expect(res.body).not.toHaveProperty('totalAmountCents');
    expect(res.body).not.toHaveProperty('stripeCheckoutSessionId');
    expect(res.body).not.toHaveProperty('stripePaymentIntentId');

    const createArgs = vi.mocked(createIntakeSubmission).mock.calls[0][0];
    expect(createArgs.source).toBe('web');
    expect(createArgs.externalSubmissionId).toMatch(/^web-review-/);
    expect(createArgs.idempotencyKey).toBe(`web:${createArgs.externalSubmissionId}`);
    expect(createArgs.rawPayload).toMatchObject({
      ...validReviewPayload,
      state: 'GA',
      reviewReason: 'other_uncertain',
      rushType: 'No Rush',
      requestType: 'manual_review',
    });

    const [submissionId, intake, correlationId, opts] = vi.mocked(processIntake).mock.calls[0];
    expect(submissionId).toBe('sub-123');
    expect(correlationId).toEqual(expect.any(String));
    expect(opts).toEqual({ sourceChannel: 'web', forceReviewOnly: true });
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
        customJobDetails: `Review reason: other_uncertain\n${validReviewPayload.details}`,
      },
      appointment: {
        date: '2099-06-15',
        window: 'Morning(8am-12pm)',
      },
      source: {
        formName: 'web-review-request',
        raw: createArgs.rawPayload,
      },
    });
    expect(markProcessing).toHaveBeenCalledWith('sub-123');
    expect(markProcessed).toHaveBeenCalledWith('sub-123', intake);
  });

  it.each([
    ['custom'],
    ['fitness_equipment'],
    ['unknown'],
    ['uncertain'],
  ])('accepts review-only service type %s for manual review', async (serviceType) => {
    const app = createTestApp();

    await request(app)
      .post('/public/review-requests')
      .send({ ...validReviewPayload, serviceType })
      .expect(201);

    const [, intake, , opts] = vi.mocked(processIntake).mock.calls[0];
    expect(opts).toEqual({ sourceChannel: 'web', forceReviewOnly: true });
    expect(intake.service.typeCode).toBe(serviceType);
  });

  it.each([
    ['custom'],
    ['fitness_equipment'],
  ])('rejects quote-only service type %s before checkout', async (serviceType) => {
    const app = createTestApp();

    const res = await request(app)
      .post('/public/bookings')
      .send({ ...validPayload, serviceType })
      .expect(400);

    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(createIntakeSubmission).not.toHaveBeenCalled();
    expect(processIntake).not.toHaveBeenCalled();
  });

  it('rejects missing appointmentDate before persistence', async () => {
    const app = createTestApp();
    const { appointmentDate, ...payload } = validPayload;

    const res = await request(app)
      .post('/public/bookings')
      .send(payload)
      .expect(400);

    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(createIntakeSubmission).not.toHaveBeenCalled();
    expect(processIntake).not.toHaveBeenCalled();
  });

  it.each([
    ['not-a-date', 'VALIDATION_ERROR'],
    ['2026-02-30', 'INVALID_APPOINTMENT_DATE'],
  ])('rejects malformed or impossible appointmentDate %s', async (appointmentDate, expectedError) => {
    const app = createTestApp();

    const res = await request(app)
      .post('/public/bookings')
      .send({ ...validPayload, appointmentDate })
      .expect(400);

    expect(res.body.error).toBe(expectedError);
    expect(createIntakeSubmission).not.toHaveBeenCalled();
    expect(processIntake).not.toHaveBeenCalled();
  });

  it('rejects past appointmentDate before persistence', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/public/bookings')
      .send({ ...validPayload, appointmentDate: '2000-01-01' })
      .expect(400);

    expect(res.body.error).toBe('PAST_APPOINTMENT_DATE');
    expect(createIntakeSubmission).not.toHaveBeenCalled();
    expect(processIntake).not.toHaveBeenCalled();
  });

  it('rejects invalid appointmentWindow before persistence', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/public/bookings')
      .send({ ...validPayload, appointmentWindow: 'Late Night' })
      .expect(400);

    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(createIntakeSubmission).not.toHaveBeenCalled();
    expect(processIntake).not.toHaveBeenCalled();
  });

  it('rejects Same Day when the public launch flag is disabled', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/public/bookings')
      .send({ ...validPayload, rushType: 'Same-day (+30)' })
      .expect(422);

    expect(res.body.error).toBe('SAME_DAY_UNAVAILABLE');
    expect(createIntakeSubmission).not.toHaveBeenCalled();
    expect(processIntake).not.toHaveBeenCalled();
  });

  it('rejects unsupported service city before persistence', async () => {
    const app = createTestApp();
    vi.mocked(classifyServiceArea).mockResolvedValueOnce({
      status: 'quote_only',
      city: 'Atlanta',
      state: 'GA',
    });

    const res = await request(app)
      .post('/public/bookings')
      .send({ ...validPayload, city: 'Atlanta' })
      .expect(422);

    expect(res.body.error).toBe('UNSUPPORTED_SERVICE_AREA');
    expect(createIntakeSubmission).not.toHaveBeenCalled();
    expect(processIntake).not.toHaveBeenCalled();
  });

  it('allows existing small and medium jobs under configured unit capacity', async () => {
    const app = createTestApp();
    vi.mocked(query).mockResolvedValueOnce(capacityRows('small', 'medium'));

    await request(app)
      .post('/public/bookings')
      .send({ ...validPayload, serviceType: 'small' })
      .expect(201);

    expect(createIntakeSubmission).toHaveBeenCalled();
    expect(processIntake).toHaveBeenCalled();
  });

  it('allows large plus large to fill configured unit capacity exactly', async () => {
    const app = createTestApp();
    vi.mocked(query).mockResolvedValueOnce(capacityRows('large'));

    await request(app)
      .post('/public/bookings')
      .send({ ...validPayload, serviceType: 'large' })
      .expect(201);

    expect(createIntakeSubmission).toHaveBeenCalled();
    expect(processIntake).toHaveBeenCalled();
  });

  it('rejects large plus large plus small before checkout creation', async () => {
    const app = createTestApp();
    vi.mocked(query).mockResolvedValueOnce(capacityRows('large', 'large'));

    const res = await request(app)
      .post('/public/bookings')
      .send(validPayload)
      .expect(409);

    expectRecoverableCapacityResponse(res.body);
    expect(createIntakeSubmission).not.toHaveBeenCalled();
    expect(processIntake).not.toHaveBeenCalled();
  });

  it('rejects treadmill when existing jobs already use all configured units', async () => {
    const app = createTestApp();
    vi.mocked(query).mockResolvedValueOnce(capacityRows('treadmill', 'treadmill'));

    const res = await request(app)
      .post('/public/bookings')
      .send({ ...validPayload, serviceType: 'treadmill' })
      .expect(409);

    expectRecoverableCapacityResponse(res.body);
    expect(createIntakeSubmission).not.toHaveBeenCalled();
    expect(processIntake).not.toHaveBeenCalled();
  });

  it('counts awaiting_payment jobs in the capacity status filter', async () => {
    const app = createTestApp();
    vi.mocked(query).mockResolvedValueOnce(capacityRows('large', 'large'));

    const res = await request(app)
      .post('/public/bookings')
      .send(validPayload)
      .expect(409);

    expectRecoverableCapacityResponse(res.body);
    const statusParam = vi.mocked(query).mock.calls[0][1]?.[3];
    expect(statusParam).toContain('awaiting_payment');
    expect(createIntakeSubmission).not.toHaveBeenCalled();
    expect(processIntake).not.toHaveBeenCalled();
  });

  it('keeps cancelled and terminal jobs out of the capacity status filter', async () => {
    const app = createTestApp();

    await request(app)
      .post('/public/bookings')
      .send(validPayload)
      .expect(201);

    const statusParam = vi.mocked(query).mock.calls[0][1]?.[3];
    expect(statusParam).not.toEqual(expect.arrayContaining([
      'cancelled',
      'closed_paid',
      'work_completed',
      'error_review',
    ]));
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
