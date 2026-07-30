import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';

const dispatchMocks = vi.hoisted(() => {
  class DuplicateDispatchError extends Error {
    readonly statusCode = 409;
    readonly errorCode = 'DUPLICATE_DISPATCH';

    constructor() {
      super('DUPLICATE_DISPATCH: a dispatch has already been committed for this job.');
      this.name = 'DuplicateDispatchError';
    }
  }

  return {
    DuplicateDispatchError,
    dispatchJobToContractor: vi.fn(),
  };
});

vi.mock('../../src/modules/jobs/job.repository', () => ({
  getJobById: vi.fn(),
  getJobByKey: vi.fn(),
  getJobByPublicPayToken: vi.fn(),
  searchJobs: vi.fn(),
  updateJobStatus: vi.fn(),
}));

vi.mock('../../src/db/pool', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../../src/modules/payments/payment.service', () => ({
  getPaymentsByJobId: vi.fn(),
  createJobCheckoutSession: vi.fn(),
}));

vi.mock('../../src/modules/audit/audit.service', () => ({
  recordAuditEvent: vi.fn(),
  getAuditEvents: vi.fn(),
}));

vi.mock('../../src/modules/airtable-sync/airtableSync.queue', () => ({
  enqueueAirtableSync: vi.fn(),
}));

vi.mock('../../src/modules/dispatch/dispatch.service', () => ({
  DuplicateDispatchError: dispatchMocks.DuplicateDispatchError,
  dispatchJobToContractor: dispatchMocks.dispatchJobToContractor,
  cancelContractorAssignment: vi.fn(),
  cancelJob: vi.fn(),
}));

vi.mock('../../src/modules/dispatch/dispatchConflict', () => ({
  checkContractorAvailability: vi.fn(),
}));

vi.mock('../../src/modules/sms/quo.adapter', () => ({
  sendSms: vi.fn(),
}));

vi.mock('../../src/modules/pricing/pricing.service', () => ({
  calculatePricing: vi.fn(),
}));

vi.mock('../../src/modules/email/email.service', () => ({
  sendCustomerCompletionEmail: vi.fn(),
}));

vi.mock('../../src/common/middleware/auth', () => ({
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../src/common/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { jobsRouter } from '../../src/modules/jobs/jobs.routes';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const CONTRACTOR_ID = '22222222-2222-4222-8222-222222222222';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.correlationId = 'corr-route';
    next();
  });
  app.use('/jobs', jobsRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  });
  return app;
}

async function dispatchRequest() {
  return request(buildApp())
    .post(`/jobs/${JOB_ID}/dispatch`)
    .send({ contractorId: CONTRACTOR_ID });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /jobs/:jobId/dispatch response contract', () => {
  it('returns the exact DUPLICATE_DISPATCH contract for the typed winner error', async () => {
    dispatchMocks.dispatchJobToContractor.mockRejectedValue(
      new dispatchMocks.DuplicateDispatchError(),
    );

    const response = await dispatchRequest();

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'DUPLICATE_DISPATCH',
      detail: 'DUPLICATE_DISPATCH',
      message: 'DUPLICATE_DISPATCH: a dispatch has already been committed for this job.',
    });
  });

  it.each([
    [
      'generic stale status',
      Object.assign(
        new Error('Job must be at ready_for_dispatch to dispatch (current: assigned)'),
        { statusCode: 409 },
      ),
      'CONFLICT',
    ],
    [
      'cancelled job',
      Object.assign(
        new Error('Job must be at ready_for_dispatch to dispatch (current: cancelled)'),
        { statusCode: 409 },
      ),
      'CONFLICT',
    ],
    [
      'schedule conflict',
      Object.assign(
        new Error('Contractor is already scheduled during this appointment window.'),
        { statusCode: 409, errorCode: 'CONTRACTOR_SCHEDULE_CONFLICT' },
      ),
      'CONTRACTOR_SCHEDULE_CONFLICT',
    ],
    [
      'inactive contractor',
      Object.assign(new Error('Contractor is not active'), { statusCode: 409 }),
      'CONFLICT',
    ],
    [
      'malformed schedule',
      Object.assign(
        new Error('Dispatch cannot proceed without a valid appointment schedule.'),
        { statusCode: 409, errorCode: 'SCHEDULE_PARSE_FAILED' },
      ),
      'SCHEDULE_PARSE_FAILED',
    ],
  ])('keeps %s on the established non-duplicate 409 contract', async (
    _label,
    error,
    expectedCode,
  ) => {
    dispatchMocks.dispatchJobToContractor.mockRejectedValue(error);

    const response = await dispatchRequest();

    expect(response.status).toBe(409);
    expect(response.body.error).toBe(expectedCode);
    expect(response.body).not.toHaveProperty('detail');
    expect(JSON.stringify(response.body)).not.toContain('DUPLICATE_DISPATCH');
  });

  it('preserves the HTTP 201 success body and Make-mapped dispatch identifiers', async () => {
    dispatchMocks.dispatchJobToContractor.mockResolvedValue({
      dispatchId: '44444444-4444-4444-8444-444444444444',
      assignmentId: '55555555-5555-4555-8555-555555555555',
      contractorId: CONTRACTOR_ID,
      jobId: JOB_ID,
      smsSent: true,
    });

    const response = await dispatchRequest();
    const responseData = response.body;

    expect(response.status).toBe(201);
    expect(responseData).toEqual({
      message: 'Dispatch sent',
      dispatchId: '44444444-4444-4444-8444-444444444444',
      assignmentId: '55555555-5555-4555-8555-555555555555',
      contractorId: CONTRACTOR_ID,
      jobId: JOB_ID,
      smsSent: true,
    });
    expect(responseData.dispatchId).toBeTypeOf('string');
    expect(responseData.assignmentId).toBeTypeOf('string');
    expect(responseData).not.toHaveProperty('data');
  });
});
