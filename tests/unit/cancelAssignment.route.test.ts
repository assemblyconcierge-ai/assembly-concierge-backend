import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { NextFunction, Request, Response } from 'express';

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
  dispatchJobToContractor: vi.fn(),
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

import { enqueueAirtableSync } from '../../src/modules/airtable-sync/airtableSync.queue';
import { cancelContractorAssignment } from '../../src/modules/dispatch/dispatch.service';
import { jobsRouter } from '../../src/modules/jobs/jobs.routes';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const ASSIGNMENT_ID = '22222222-2222-4222-8222-222222222222';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.correlationId = 'corr-cancel-assignment';
    next();
  });
  app.use('/jobs', jobsRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  });
  return app;
}

describe('POST /jobs/:jobId/cancel-assignment Airtable enqueue', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(enqueueAirtableSync).mockResolvedValue(undefined);
  });

  it('enqueues Airtable sync after cancellation succeeds', async () => {
    vi.mocked(cancelContractorAssignment).mockResolvedValue({
      success: true,
      jobId: JOB_ID,
      cancelledAssignmentId: ASSIGNMENT_ID,
      previousContractorId: '33333333-3333-4333-8333-333333333333',
      jobStatus: 'ready_for_dispatch',
    });

    const response = await request(buildApp())
      .post(`/jobs/${JOB_ID}/cancel-assignment`)
      .send({ assignmentId: ASSIGNMENT_ID });

    expect(response.status).toBe(200);
    expect(cancelContractorAssignment).toHaveBeenCalledWith(
      JOB_ID,
      'corr-cancel-assignment',
      ASSIGNMENT_ID,
    );
    expect(enqueueAirtableSync).toHaveBeenCalledWith({
      jobId: JOB_ID,
      correlationId: 'corr-cancel-assignment',
    });
    expect(
      vi.mocked(cancelContractorAssignment).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(enqueueAirtableSync).mock.invocationCallOrder[0]);
  });

  it('does not enqueue when cancellation fails', async () => {
    vi.mocked(cancelContractorAssignment).mockRejectedValue(
      Object.assign(new Error('No active assignment'), {
        statusCode: 409,
        errorCode: 'NO_ACTIVE_ASSIGNMENT',
      }),
    );

    const response = await request(buildApp())
      .post(`/jobs/${JOB_ID}/cancel-assignment`)
      .send({});

    expect(response.status).toBe(409);
    expect(enqueueAirtableSync).not.toHaveBeenCalled();
  });
});
