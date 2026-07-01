/**
 * Tests for the approve-completion photo guard in POST /jobs/:jobId/approve-completion.
 *
 * Verifies:
 * - 422 COMPLETION_PHOTOS_REQUIRED when no confirmed completion photos and no adminOverrideReason
 * - Proceeds when at least one confirmed completion photo exists
 * - Proceeds when adminOverrideReason is provided (even with zero photos)
 * - adminOverrideReason included in audit payload when provided
 * - Status check still runs first (409 for wrong status)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

// ── Module mocks ──────────────────────────────────────────────────────────────
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

vi.mock('../../src/common/middleware/auth', () => ({
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../src/common/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/common/config', () => ({
  config: { NODE_ENV: 'test', ADMIN_JWT_SECRET: 'test-secret' },
}));

import { getJobById, updateJobStatus } from '../../src/modules/jobs/job.repository';
import { query } from '../../src/db/pool';
import { getPaymentsByJobId } from '../../src/modules/payments/payment.service';
import { recordAuditEvent } from '../../src/modules/audit/audit.service';
import { enqueueAirtableSync } from '../../src/modules/airtable-sync/airtableSync.queue';
import { jobsRouter } from '../../src/modules/jobs/jobs.routes';

// ── Test app ──────────────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).correlationId = 'test-corr';
    next();
  });
  app.use('/jobs', jobsRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  });
  return app;
}

const JOB_COMPLETION_REPORTED = {
  id: 'job-1',
  job_key: 'AC-2026-EPME',
  status: 'completion_reported',
  remainder_amount_cents: 0,
  customer_id: 'cust-1',
  address_id: 'addr-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(recordAuditEvent).mockResolvedValue(undefined as any);
  vi.mocked(enqueueAirtableSync).mockResolvedValue(undefined as any);
  vi.mocked(updateJobStatus).mockResolvedValue(undefined as any);
  vi.mocked(query).mockResolvedValue([]);
});

// ── Status gate ───────────────────────────────────────────────────────────────
describe('approve-completion status gate', () => {
  it('returns 404 when job not found', async () => {
    vi.mocked(getJobById).mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await request(app)
      .post('/jobs/job-1/approve-completion')
      .send({});
    expect(res.status).toBe(404);
  });

  it('returns 409 when job status is not completion_reported', async () => {
    vi.mocked(getJobById).mockResolvedValueOnce({ ...JOB_COMPLETION_REPORTED, status: 'assigned' } as any);
    const app = buildApp();
    const res = await request(app)
      .post('/jobs/job-1/approve-completion')
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONFLICT');
  });
});

// ── Photo guard ───────────────────────────────────────────────────────────────
describe('approve-completion photo guard', () => {
  it('returns 422 COMPLETION_PHOTOS_REQUIRED when no photos and no override', async () => {
    vi.mocked(getJobById).mockResolvedValueOnce(JOB_COMPLETION_REPORTED as any);
    vi.mocked(query).mockResolvedValueOnce([{ count: '0' }] as any); // photo count
    const app = buildApp();
    const res = await request(app)
      .post('/jobs/job-1/approve-completion')
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('COMPLETION_PHOTOS_REQUIRED');
    expect(res.body.missingRequirements).toContain('completionPhotos');
  });

  it('returns 422 when adminOverrideReason is empty string', async () => {
    vi.mocked(getJobById).mockResolvedValueOnce(JOB_COMPLETION_REPORTED as any);
    vi.mocked(query).mockResolvedValueOnce([{ count: '0' }] as any);
    const app = buildApp();
    const res = await request(app)
      .post('/jobs/job-1/approve-completion')
      .send({ adminOverrideReason: '' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('COMPLETION_PHOTOS_REQUIRED');
  });

  it('returns 422 when adminOverrideReason is whitespace only', async () => {
    vi.mocked(getJobById).mockResolvedValueOnce(JOB_COMPLETION_REPORTED as any);
    vi.mocked(query).mockResolvedValueOnce([{ count: '0' }] as any);
    const app = buildApp();
    const res = await request(app)
      .post('/jobs/job-1/approve-completion')
      .send({ adminOverrideReason: '   ' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('COMPLETION_PHOTOS_REQUIRED');
  });

  it('proceeds when at least one confirmed completion photo exists', async () => {
    vi.mocked(getJobById).mockResolvedValueOnce(JOB_COMPLETION_REPORTED as any);
    vi.mocked(query).mockResolvedValueOnce([{ count: '2' }] as any); // photo count
    vi.mocked(getPaymentsByJobId).mockResolvedValueOnce([]);
    vi.mocked(query).mockResolvedValueOnce([] as any); // closed_paid UPDATE
    const app = buildApp();
    const res = await request(app)
      .post('/jobs/job-1/approve-completion')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed_paid');
  });

  it('proceeds with adminOverrideReason even when zero photos', async () => {
    vi.mocked(getJobById).mockResolvedValueOnce(JOB_COMPLETION_REPORTED as any);
    vi.mocked(query).mockResolvedValueOnce([{ count: '0' }] as any); // photo count
    vi.mocked(getPaymentsByJobId).mockResolvedValueOnce([]);
    vi.mocked(query).mockResolvedValueOnce([] as any); // closed_paid UPDATE
    const app = buildApp();
    const res = await request(app)
      .post('/jobs/job-1/approve-completion')
      .send({ adminOverrideReason: 'Customer confirmed verbally' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed_paid');
  });

  it('includes adminOverrideReason in audit payload when provided', async () => {
    vi.mocked(getJobById).mockResolvedValueOnce(JOB_COMPLETION_REPORTED as any);
    vi.mocked(query).mockResolvedValueOnce([{ count: '0' }] as any);
    vi.mocked(getPaymentsByJobId).mockResolvedValueOnce([]);
    vi.mocked(query).mockResolvedValueOnce([] as any);
    const app = buildApp();
    await request(app)
      .post('/jobs/job-1/approve-completion')
      .send({ adminOverrideReason: 'Customer confirmed verbally' });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          adminOverrideReason: 'Customer confirmed verbally',
        }),
      }),
    );
  });

  it('does NOT include adminOverrideReason in audit payload when not provided', async () => {
    vi.mocked(getJobById).mockResolvedValueOnce(JOB_COMPLETION_REPORTED as any);
    vi.mocked(query).mockResolvedValueOnce([{ count: '3' }] as any);
    vi.mocked(getPaymentsByJobId).mockResolvedValueOnce([]);
    vi.mocked(query).mockResolvedValueOnce([] as any);
    const app = buildApp();
    await request(app)
      .post('/jobs/job-1/approve-completion')
      .send({});
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.not.objectContaining({
          adminOverrideReason: expect.anything(),
        }),
      }),
    );
  });

  it('photo count query filters by photo_type = completion and confirmed_at IS NOT NULL', async () => {
    vi.mocked(getJobById).mockResolvedValueOnce(JOB_COMPLETION_REPORTED as any);
    vi.mocked(query).mockResolvedValueOnce([{ count: '0' }] as any);
    const app = buildApp();
    await request(app)
      .post('/jobs/job-1/approve-completion')
      .send({});
    const countCall = vi.mocked(query).mock.calls[0];
    expect(countCall[0]).toContain("photo_type = 'completion'");
    expect(countCall[0]).toContain('confirmed_at IS NOT NULL');
  });
});
