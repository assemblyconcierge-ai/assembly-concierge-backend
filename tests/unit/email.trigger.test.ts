/**
 * Phase 2B tests — email trigger wiring.
 *
 * 1. approve-completion Path B (closed_paid, no remainder) fires
 *    sendCustomerCompletionEmail fire-and-forget.
 * 2. stripe.webhook handleCheckoutSessionCompleted fires
 *    sendCustomerCompletionEmail for paymentType = 'remainder'.
 * 3. POST /admin/contractors/:id/send-onboarding-email:
 *    - 200 on success (log_only mode)
 *    - 200 alreadySent when email already sent and forceResend=false
 *    - 200 on forceResend=true
 *    - 404 for unknown contractor
 *    - 422 MISSING_EMAIL when contractor has no email
 *    - 409 AIRTABLE_RECORD_ID_MISMATCH when body ID conflicts with stored ID
 *    - persists airtableRecordId when not yet stored
 *    - does not activate contractor
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const {
  mockQuery,
  mockQueryOne,
  mockSendCustomerCompletionEmail,
  mockSendContractorOnboardingEmail,
  mockSendContractorMissingDocsEmail,
  mockSendContractorOnboardingAcceptedEmail,
  mockSendContractorActivatedEmail,
  mockRequireAdmin,
  mockRecordAuditEvent,
  mockGetJobById,
  mockGetPaymentsByJobId,
  mockEnqueueAirtableSync,
} = vi.hoisted(() => ({
  mockQuery:                        vi.fn(),
  mockQueryOne:                     vi.fn(),
  mockSendCustomerCompletionEmail:  vi.fn().mockResolvedValue({ eventId: 'evt-1', mode: 'log_only', alreadySent: false }),
  mockSendContractorOnboardingEmail: vi.fn().mockResolvedValue({ eventId: 'evt-2', mode: 'log_only', alreadySent: false, jotformUrl: 'https://form.jotform.com/test?contractorId=ctr-uuid-1' }),
  mockSendContractorMissingDocsEmail: vi.fn().mockResolvedValue({ eventId: 'evt-3', mode: 'log_only', alreadySent: false }),
  mockSendContractorOnboardingAcceptedEmail: vi.fn().mockResolvedValue({ eventId: 'evt-4', mode: 'log_only', alreadySent: false }),
  mockSendContractorActivatedEmail:          vi.fn().mockResolvedValue({ eventId: 'evt-5', mode: 'log_only', alreadySent: false }),
  mockRequireAdmin:                          vi.fn((_req: any, _res: any, next: any) => next()),
  mockRecordAuditEvent:             vi.fn().mockResolvedValue(undefined),
  mockGetJobById:                   vi.fn(),
  mockGetPaymentsByJobId:           vi.fn(),
  mockEnqueueAirtableSync:          vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/pool', () => ({
  query:           mockQuery,
  queryOne:        mockQueryOne,
  withTransaction: vi.fn(),
}));
vi.mock('../../src/modules/email/email.service', () => ({
  sendCustomerCompletionEmail:              mockSendCustomerCompletionEmail,
  sendContractorOnboardingEmail:            mockSendContractorOnboardingEmail,
  sendContractorMissingDocsEmail:           mockSendContractorMissingDocsEmail,
  sendContractorOnboardingAcceptedEmail:    mockSendContractorOnboardingAcceptedEmail,
  sendContractorActivatedEmail:             mockSendContractorActivatedEmail,
}));
vi.mock('../../src/modules/audit/audit.service', () => ({
  recordAuditEvent: mockRecordAuditEvent,
  getAuditEvents:   vi.fn(),
}));
vi.mock('../../src/modules/jobs/job.repository', () => ({
  getJobById:              mockGetJobById,
  getJobByKey:             vi.fn(),
  getJobByPublicPayToken:  vi.fn(),
  searchJobs:              vi.fn(),
  updateJobStatus:         vi.fn(),
}));
vi.mock('../../src/modules/payments/payment.service', () => ({
  getPaymentsByJobId:          mockGetPaymentsByJobId,
  createJobCheckoutSession:    vi.fn(),
}));
vi.mock('../../src/modules/airtable-sync/airtableSync.queue', () => ({
  enqueueAirtableSync: mockEnqueueAirtableSync,
}));
vi.mock('../../src/modules/dispatch/dispatch.service', () => ({
  dispatchJobToContractor:     vi.fn(),
  cancelContractorAssignment:  vi.fn(),
  cancelJob:                   vi.fn(),
}));
vi.mock('../../src/modules/dispatch/dispatchConflict', () => ({
  checkContractorAvailability: vi.fn(),
}));
vi.mock('../../src/modules/sms/quo.adapter', () => ({
  sendSms: vi.fn(),
}));
vi.mock('../../src/modules/pricing/pricing.service', () => ({
  calculatePricing:    vi.fn(),
  getAllPricingRules:   vi.fn(),
  upsertPricingRule:   vi.fn(),
}));
vi.mock('../../src/modules/service-areas/serviceArea.service', () => ({
  getAllServiceAreas: vi.fn(),
  upsertServiceArea:  vi.fn(),
}));
vi.mock('../../src/common/middleware/auth', () => ({
  requireAdmin: mockRequireAdmin,
  requireAuth:  (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../src/common/logger', () => ({
  logger: {
    child:  vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    info:   vi.fn(),
    warn:   vi.fn(),
    error:  vi.fn(),
  },
}));

import { jobsRouter }  from '../../src/modules/jobs/jobs.routes';
import { adminRouter } from '../../src/modules/admin/admin.routes';
import { globalErrorHandler } from '../../src/common/errors/errorHandler';

function buildJobsApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.correlationId = 'test-corr'; next(); });
  app.use('/jobs', jobsRouter);
  app.use(globalErrorHandler);
  return app;
}

function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.correlationId = 'test-corr'; next(); });
  app.use('/admin', adminRouter);
  app.use(globalErrorHandler);
  return app;
}

// ── Shared fixtures ───────────────────────────────────────────────────────────
const BASE_JOB = {
  id:                       'job-uuid-1',
  job_key:                  'AC-2026-TEST',
  status:                   'completion_reported',
  customer_id:              'cust-uuid-1',
  service_type_id:          'st-uuid-1',
  city_detected:            'McDonough',
  customer_name_snapshot:   'Kenneth Test',
  customer_email_snapshot:  'kenneth@example.com',
  customer_phone_snapshot:  '+14045550001',
  remainder_amount_cents:   0,
};

const BASE_CONTRACTOR = {
  id:                 'ctr-uuid-1',
  full_name:          'Marcus Johnson',
  email:              'marcus@example.com',
  phone_e164:         '+14045551234',
  airtable_record_id: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. approve-completion Path B — sendCustomerCompletionEmail is fired
// ─────────────────────────────────────────────────────────────────────────────
describe('approve-completion Path B — customer completion email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendCustomerCompletionEmail.mockResolvedValue({ eventId: 'evt-1', mode: 'log_only', alreadySent: false });
    mockEnqueueAirtableSync.mockResolvedValue(undefined);
    mockRecordAuditEvent.mockResolvedValue(undefined);
  });

  it('fires sendCustomerCompletionEmail after approve-completion closes job as closed_paid (no remainder)', async () => {
    // Job is in completion_reported status
    mockGetJobById.mockResolvedValue({ ...BASE_JOB, status: 'completion_reported' });
    // Photo count query uses query() (not queryOne) — returns array
    mockQuery.mockResolvedValueOnce([{ count: '1' }]);
    // Payments: no remainder (deposit covers full amount)
    mockGetPaymentsByJobId.mockResolvedValue([
      { id: 'pay-1', payment_type: 'deposit', amount_cents: 20000, status: 'succeeded' },
    ]);
    // Service type lookup (for email) uses queryOne
    mockQueryOne.mockResolvedValueOnce({ display_name: 'Treadmill Assembly', code: 'TREADMILL' });
    // UPDATE jobs SET status = 'closed_paid' and enqueueAirtableSync query calls
    mockQuery.mockResolvedValue([]);

    const app = buildJobsApp();
    const res = await request(app)
      .post('/jobs/job-uuid-1/approve-completion')
      .set('x-admin-key', 'test')
      .send({});

    expect(res.status).toBe(200);

    // Give setImmediate a tick to fire
    await new Promise(r => setImmediate(r));

    expect(mockSendCustomerCompletionEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId:         'job-uuid-1',
        jobKey:        'AC-2026-TEST',
        customerName:  'Kenneth Test',
        customerEmail: 'kenneth@example.com',
        serviceType:   'Treadmill Assembly',
        city:          'McDonough',
      }),
    );
  });

  it('does not fire sendCustomerCompletionEmail when job has remainder owed (Path A)', async () => {
    // remainder_amount_cents > 0 → route takes Path A (awaiting_remainder_payment)
    mockGetJobById.mockResolvedValue({ ...BASE_JOB, status: 'completion_reported', remainder_amount_cents: 15000 });
    // Photo count query uses query() — returns array
    mockQuery.mockResolvedValueOnce([{ count: '1' }]);
    // Payments: deposit only (no full payment)
    mockGetPaymentsByJobId.mockResolvedValue([
      { id: 'pay-1', payment_type: 'deposit', amount_cents: 5000, status: 'succeeded' },
    ]);

    mockQuery.mockResolvedValue([]);

    const app = buildJobsApp();
    await request(app)
      .post('/jobs/job-uuid-1/approve-completion')
      .set('x-admin-key', 'test')
      .send({});

    await new Promise(r => setImmediate(r));

    // Path A sends a payment link SMS, not a completion email
    expect(mockSendCustomerCompletionEmail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. POST /admin/contractors/:id/send-onboarding-email
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /admin/contractors/:id/send-onboarding-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // mockReset drains any unconsumed Once queues so tests don't bleed into each other
    mockQueryOne.mockReset();
    mockQuery.mockReset();
    mockSendContractorOnboardingEmail.mockReset();
    mockSendContractorOnboardingEmail.mockResolvedValue({ eventId: 'evt-2', mode: 'log_only', alreadySent: false, jotformUrl: 'https://form.jotform.com/test?contractorId=ctr-uuid-1' });
    mockQuery.mockResolvedValue([]);
    mockQueryOne.mockResolvedValue(null);
  });

  it('returns 200 and sends onboarding email (log_only mode)', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-onboarding-email')
      .send({ airtableRecordId: 'rec_AIRTABLE1' });

    expect(res.status).toBe(200);
    expect(res.body.alreadySent).toBe(false);
    expect(res.body.eventId).toBe('evt-2');
    expect(res.body.status).toMatch(/^(sent|logged)$/);
    expect(res.body.onboardingFormUrl).toBeTruthy();
    expect(res.body.onboardingFormUrl).toMatch(/^https:\/\/form\.jotform\.com\//);
    expect(mockSendContractorOnboardingEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        contractorId:    'ctr-uuid-1',
        contractorName:  'Marcus Johnson',
        contractorEmail: 'marcus@example.com',
        phoneE164:       '+14045551234',
        airtableRecordId: 'rec_AIRTABLE1',
        forceResend:     false,
      }),
    );
  });

  it('returns 200 alreadySent=true when email already sent and forceResend=false', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);
    mockSendContractorOnboardingEmail.mockResolvedValue({ eventId: 'evt-2', mode: 'log_only', alreadySent: true, jotformUrl: 'https://form.jotform.com/test?contractorId=ctr-uuid-1' });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-onboarding-email')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.alreadySent).toBe(true);
    expect(res.body.status).toBe('already_sent');
    expect(res.body.message).toMatch(/already sent/i);
    expect(res.body.onboardingFormUrl).toBeTruthy();
    expect(res.body.onboardingFormUrl).toMatch(/^https:\/\/form\.jotform\.com\//);
  });

  it('returns 200 and resends when forceResend=true', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);
    mockSendContractorOnboardingEmail.mockResolvedValue({ eventId: 'evt-3', mode: 'log_only', alreadySent: false });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-onboarding-email')
      .send({ forceResend: true });

    expect(res.status).toBe(200);
    expect(res.body.alreadySent).toBe(false);
    expect(mockSendContractorOnboardingEmail).toHaveBeenCalledWith(
      expect.objectContaining({ forceResend: true }),
    );
  });

  it('returns 404 for unknown contractor', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/unknown-id/send-onboarding-email')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('returns 422 MISSING_EMAIL when contractor has no email', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...BASE_CONTRACTOR, email: null });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-onboarding-email')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('MISSING_EMAIL');
    expect(mockSendContractorOnboardingEmail).not.toHaveBeenCalled();
  });

  it('returns 409 AIRTABLE_RECORD_ID_MISMATCH when body ID conflicts with stored ID', async () => {
    mockQueryOne.mockResolvedValueOnce({
      ...BASE_CONTRACTOR,
      airtable_record_id: 'rec_STORED',
    });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-onboarding-email')
      .send({ airtableRecordId: 'rec_DIFFERENT' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AIRTABLE_RECORD_ID_MISMATCH');
    expect(mockSendContractorOnboardingEmail).not.toHaveBeenCalled();
  });

  it('persists airtableRecordId when contractor has none stored', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...BASE_CONTRACTOR, airtable_record_id: null });
    // UPDATE contractors SET airtable_record_id ...
    mockQuery.mockResolvedValueOnce([]);

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-onboarding-email')
      .send({ airtableRecordId: 'rec_NEW' });

    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('airtable_record_id'),
      expect.arrayContaining(['ctr-uuid-1', 'rec_NEW']),
    );
    expect(mockSendContractorOnboardingEmail).toHaveBeenCalledWith(
      expect.objectContaining({ airtableRecordId: 'rec_NEW' }),
    );
  });

  it('does not activate contractor or change is_active', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);

    const app = buildAdminApp();
    await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-onboarding-email')
      .send({ airtableRecordId: 'rec_X' });

    // No UPDATE ... SET is_active should have been called
    const allQueryCalls = mockQuery.mock.calls.map((c: any[]) => String(c[0]));
    const activationCalls = allQueryCalls.filter((sql: string) => sql.includes('is_active'));
    expect(activationCalls).toHaveLength(0);
  });

  it('passes preferredName to sendContractorOnboardingEmail when provided', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-onboarding-email')
      .send({ preferredName: 'Marc' });

    expect(res.status).toBe(200);
    expect(mockSendContractorOnboardingEmail).toHaveBeenCalledWith(
      expect.objectContaining({ preferredName: 'Marc' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /admin/contractors/:id/send-missing-docs-email
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /admin/contractors/:id/send-missing-docs-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryOne.mockReset();
    mockQuery.mockReset();
    mockSendContractorMissingDocsEmail.mockReset();
    mockSendContractorMissingDocsEmail.mockResolvedValue({ eventId: 'evt-3', alreadySent: false });
    mockQuery.mockResolvedValue([]);
    mockQueryOne.mockResolvedValue(null);
  });

  it('returns 200 and sends missing-docs email (log_only mode)', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-missing-docs-email')
      .send({ missingOrCorrectionText: 'Your W-9 is missing a signature.' });

    expect(res.status).toBe(200);
    expect(res.body.alreadySent).toBe(false);
    expect(res.body.eventId).toBe('evt-3');
    expect(res.body.status).toMatch(/^(sent|logged)$/);
    expect(mockSendContractorMissingDocsEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        contractorId:            'ctr-uuid-1',
        contractorName:          'Marcus Johnson',
        contractorEmail:         'marcus@example.com',
        missingOrCorrectionText: 'Your W-9 is missing a signature.',
        forceResend:             false,
      }),
    );
  });

  it('returns 400 when missingOrCorrectionText is missing (Zod validation)', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-missing-docs-email')
      .send({});

    expect(res.status).toBe(400);
    expect(mockSendContractorMissingDocsEmail).not.toHaveBeenCalled();
  });

  it('returns 400 when missingOrCorrectionText is empty string (Zod validation)', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-missing-docs-email')
      .send({ missingOrCorrectionText: '' });

    expect(res.status).toBe(400);
    expect(mockSendContractorMissingDocsEmail).not.toHaveBeenCalled();
  });

  it('returns 200 alreadySent=true when email already sent and forceResend=false', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);
    mockSendContractorMissingDocsEmail.mockResolvedValue({ eventId: 'evt-3', alreadySent: true });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-missing-docs-email')
      .send({ missingOrCorrectionText: 'W-9 missing.' });

    expect(res.status).toBe(200);
    expect(res.body.alreadySent).toBe(true);
    expect(res.body.status).toBe('already_sent');
    expect(res.body.message).toMatch(/already sent/i);
  });

  it('returns 200 and resends when forceResend=true', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);
    mockSendContractorMissingDocsEmail.mockResolvedValue({ eventId: 'evt-3b', alreadySent: false });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-missing-docs-email')
      .send({ missingOrCorrectionText: 'W-9 missing.', forceResend: true });

    expect(res.status).toBe(200);
    expect(res.body.alreadySent).toBe(false);
    expect(mockSendContractorMissingDocsEmail).toHaveBeenCalledWith(
      expect.objectContaining({ forceResend: true }),
    );
  });

  it('returns 404 for unknown contractor', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/unknown-id/send-missing-docs-email')
      .send({ missingOrCorrectionText: 'W-9 missing.' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('returns 422 MISSING_EMAIL when contractor has no email', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...BASE_CONTRACTOR, email: null });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-missing-docs-email')
      .send({ missingOrCorrectionText: 'W-9 missing.' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('MISSING_EMAIL');
    expect(mockSendContractorMissingDocsEmail).not.toHaveBeenCalled();
  });

  it('does not activate contractor or change is_active', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);

    const app = buildAdminApp();
    await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-missing-docs-email')
      .send({ missingOrCorrectionText: 'W-9 missing.' });

    const allQueryCalls = mockQuery.mock.calls.map((c: any[]) => String(c[0]));
    const activationCalls = allQueryCalls.filter((sql: string) => sql.includes('is_active'));
    expect(activationCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. POST /admin/contractors/:id/send-onboarding-accepted-email
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /admin/contractors/:id/send-onboarding-accepted-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryOne.mockReset();
    mockQuery.mockReset();
    mockSendContractorOnboardingAcceptedEmail.mockReset();
    mockSendContractorOnboardingAcceptedEmail.mockResolvedValue({ eventId: 'evt-4', alreadySent: false });
    mockQuery.mockResolvedValue([]);
    mockQueryOne.mockResolvedValue(null);
  });

  it('returns 200 and sends accepted email (log_only mode)', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-onboarding-accepted-email')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.alreadySent).toBe(false);
    expect(res.body.eventId).toBe('evt-4');
    expect(res.body.status).toMatch(/^(sent|logged)$/);
    expect(mockSendContractorOnboardingAcceptedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        contractorId:    'ctr-uuid-1',
        contractorName:  'Marcus Johnson',
        contractorEmail: 'marcus@example.com',
        forceResend:     false,
      }),
    );
  });

  it('returns 200 alreadySent=true when email already sent and forceResend=false', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);
    mockSendContractorOnboardingAcceptedEmail.mockResolvedValue({ eventId: 'evt-4', alreadySent: true });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-onboarding-accepted-email')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.alreadySent).toBe(true);
    expect(res.body.status).toBe('already_sent');
    expect(res.body.message).toMatch(/already sent/i);
  });

  it('returns 200 and resends when forceResend=true', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);
    mockSendContractorOnboardingAcceptedEmail.mockResolvedValue({ eventId: 'evt-4b', alreadySent: false });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-onboarding-accepted-email')
      .send({ forceResend: true });

    expect(res.status).toBe(200);
    expect(res.body.alreadySent).toBe(false);
    expect(mockSendContractorOnboardingAcceptedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ forceResend: true }),
    );
  });

  it('returns 404 for unknown contractor', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/unknown-id/send-onboarding-accepted-email')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('returns 422 MISSING_EMAIL when contractor has no email', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...BASE_CONTRACTOR, email: null });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-onboarding-accepted-email')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('MISSING_EMAIL');
    expect(mockSendContractorOnboardingAcceptedEmail).not.toHaveBeenCalled();
  });

  it('does not activate contractor or change is_active', async () => {
    mockQueryOne.mockResolvedValueOnce(BASE_CONTRACTOR);

    const app = buildAdminApp();
    await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-onboarding-accepted-email')
      .send({});

    const allQueryCalls = mockQuery.mock.calls.map((c: any[]) => String(c[0]));
    const activationCalls = allQueryCalls.filter((sql: string) => sql.includes('is_active'));
    expect(activationCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. POST /admin/contractors/:id/send-activated-email
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /admin/contractors/:id/send-activated-email', () => {
  const ACTIVE_CONTRACTOR = { ...BASE_CONTRACTOR, is_active: true };

  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryOne.mockReset();
    mockQuery.mockReset();
    mockSendContractorActivatedEmail.mockReset();
    mockSendContractorActivatedEmail.mockResolvedValue({ eventId: 'evt-5', alreadySent: false });
    mockQuery.mockResolvedValue([]);
    mockQueryOne.mockResolvedValue(null);
    // Reset requireAdmin to pass-through by default
    mockRequireAdmin.mockImplementation((_req: any, _res: any, next: any) => next());
  });

  it('returns 200 and sends activated email (log_only mode)', async () => {
    mockQueryOne.mockResolvedValueOnce(ACTIVE_CONTRACTOR);

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-activated-email')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.alreadySent).toBe(false);
    expect(res.body.eventId).toBe('evt-5');
    expect(res.body.status).toMatch(/^(sent|logged)$/);
    expect(mockSendContractorActivatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        contractorId:    'ctr-uuid-1',
        contractorName:  'Marcus Johnson',
        contractorEmail: 'marcus@example.com',
        forceResend:     false,
      }),
    );
  });

  it('returns 200 alreadySent=true when email already sent and forceResend=false', async () => {
    mockQueryOne.mockResolvedValueOnce(ACTIVE_CONTRACTOR);
    mockSendContractorActivatedEmail.mockResolvedValue({ eventId: 'evt-5', alreadySent: true });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-activated-email')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.alreadySent).toBe(true);
    expect(res.body.status).toBe('already_sent');
    expect(res.body.message).toMatch(/already sent/i);
  });

  it('returns 200 and resends when forceResend=true', async () => {
    mockQueryOne.mockResolvedValueOnce(ACTIVE_CONTRACTOR);
    mockSendContractorActivatedEmail.mockResolvedValue({ eventId: 'evt-5b', alreadySent: false });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-activated-email')
      .send({ forceResend: true });

    expect(res.status).toBe(200);
    expect(res.body.alreadySent).toBe(false);
    expect(mockSendContractorActivatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ forceResend: true }),
    );
  });

  it('returns 422 NOT_ACTIVE when contractor is not active', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...BASE_CONTRACTOR, is_active: false });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-activated-email')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('NOT_ACTIVE');
    expect(mockSendContractorActivatedEmail).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown contractor', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/unknown-id/send-activated-email')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('returns 422 MISSING_EMAIL when contractor has no email', async () => {
    mockQueryOne.mockResolvedValueOnce({ ...ACTIVE_CONTRACTOR, email: null });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-activated-email')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('MISSING_EMAIL');
    expect(mockSendContractorActivatedEmail).not.toHaveBeenCalled();
  });

  it('returns 401 when no auth token is provided', async () => {
    mockRequireAdmin.mockImplementationOnce((_req: any, res: any, _next: any) => {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Admin authentication required' });
    });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-activated-email')
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(mockSendContractorActivatedEmail).not.toHaveBeenCalled();
  });

  it('returns 403 when wrong auth token is provided', async () => {
    mockRequireAdmin.mockImplementationOnce((_req: any, res: any, _next: any) => {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid admin token' });
    });

    const app = buildAdminApp();
    const res = await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-activated-email')
      .set('Authorization', 'Bearer wrong-token')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(mockSendContractorActivatedEmail).not.toHaveBeenCalled();
  });

  it('does not alter is_active when sending activated email', async () => {
    mockQueryOne.mockResolvedValueOnce(ACTIVE_CONTRACTOR);

    const app = buildAdminApp();
    await request(app)
      .post('/admin/contractors/ctr-uuid-1/send-activated-email')
      .send({});

    const allQueryCalls = mockQuery.mock.calls.map((c: any[]) => String(c[0]));
    const activationCalls = allQueryCalls.filter((sql: string) => sql.includes('is_active'));
    expect(activationCalls).toHaveLength(0);
  });
});
