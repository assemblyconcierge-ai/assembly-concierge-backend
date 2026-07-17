import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { config } from '../../src/common/config';
import { logger } from '../../src/common/logger';
import { processIntake } from '../../src/modules/intake/intake.service';
import {
  createIntakeSubmission,
  findByIdempotencyKey,
} from '../../src/modules/intake/intake.repository';
import { processOnboardingSubmission } from '../../src/modules/onboarding/onboarding.service';

// Mock all DB and service dependencies
vi.mock('../../src/db/pool', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTransaction: vi.fn(async (fn: any) => {
    const client = { query: vi.fn(async () => ({ rows: [] })) };
    return fn(client);
  }),
  getPool: vi.fn(() => ({ query: vi.fn(async () => ({ rows: [] })) })),
  closePool: vi.fn(),
}));

vi.mock('../../src/modules/airtable-sync/airtableSync.queue', () => ({
  enqueueAirtableSync: vi.fn(async () => {}),
}));

vi.mock('../../src/common/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

vi.mock('../../src/modules/intake/intake.service', () => ({
  processIntake: vi.fn(async () => ({
    jobId: 'job-123',
    jobKey: 'AC-2024-TEST',
    status: 'awaiting_payment',
    serviceAreaStatus: 'in_area',
    totalAmountCents: 10900,
    checkoutRequired: true,
  })),
}));

vi.mock('../../src/modules/onboarding/onboarding.service', () => ({
  processOnboardingSubmission: vi.fn(),
}));

vi.mock('../../src/modules/intake/intake.repository', () => ({
  findByIdempotencyKey: vi.fn(async () => null),
  createIntakeSubmission: vi.fn(async () => ({
    id: 'sub-123',
    source: 'jotform',
    external_submission_id: 'SUB-001',
    processing_status: 'received',
    idempotency_key: 'jotform:SUB-001',
    correlation_id: 'corr-123',
  })),
  markProcessing: vi.fn(async () => {}),
  markProcessed: vi.fn(async () => {}),
  markFailed: vi.fn(async () => {}),
  markDuplicate: vi.fn(async () => {}),
}));

const app = createApp();
const originalNodeEnv = config.NODE_ENV;
const originalOnboardingToken = config.JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(config, {
    NODE_ENV: originalNodeEnv,
    JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN: originalOnboardingToken,
  });
});

afterEach(() => {
  Object.assign(config, {
    NODE_ENV: originalNodeEnv,
    JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN: originalOnboardingToken,
  });
});

describe('POST /webhooks/jotform', () => {
  const validPayload = {
    submissionID: 'SUB-001',
    'q3_name[first]': 'Jane',
    'q3_name[last]': 'Smith',
    q4_email: 'jane@example.com',
    q5_phone: '4045551234',
    q7_city: 'Hampton',
    q8_serviceType: 'Small Assembly',
    q9_rush: 'No',
  };

  it('returns 404 in production before parsing or processing customer intake', async () => {
    Object.assign(config, { NODE_ENV: 'production' });

    const res = await request(app)
      .post('/webhooks/jotform')
      .set('Content-Type', 'application/json')
      .send('{"rawRequest":')
      .expect(404);

    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Route not found' });
    expect(findByIdempotencyKey).not.toHaveBeenCalled();
    expect(createIntakeSubmission).not.toHaveBeenCalled();
    expect(processIntake).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain('[JotformParser]');
  });

  it('keeps contractor onboarding available in production', async () => {
    const token = 'contractor-onboarding-test-token';
    Object.assign(config, {
      NODE_ENV: 'production',
      JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN: token,
    });
    vi.mocked(processOnboardingSubmission).mockResolvedValueOnce({
      status: 'processed',
      submissionId: 'onboarding-submission-1',
      contractorId: 'contractor-123',
      airtableRecordId: 'airtable-record-123',
      submittedAt: '2026-07-17T12:00:00.000Z',
      documents: [],
      overallDocumentStatus: 'Submitted - Docs Complete',
      documentStatus: 'Submitted - Docs Complete',
      processedFiles: [],
      processingErrors: [],
      errors: [],
    });

    const res = await request(app)
      .post(`/webhooks/jotform/contractor-onboarding?token=${token}`)
      .send({ formID: '261801729818060', submissionID: 'onboarding-submission-1' })
      .expect(200);

    expect(res.body.status).toBe('processed');
    expect(processOnboardingSubmission).toHaveBeenCalledOnce();
  });

  it('returns 202 for a valid new submission', async () => {
    const res = await request(app)
      .post('/webhooks/jotform')
      .send(validPayload)
      .expect(202);

    expect(res.body.status).toBe('received');
    expect(res.body.submissionId).toBe('sub-123');
    expect(res.body.correlationId).toBeDefined();
  });

  it('returns 200 with status=duplicate for repeated submission', async () => {
    const { findByIdempotencyKey } = await import('../../src/modules/intake/intake.repository');
    vi.mocked(findByIdempotencyKey).mockResolvedValueOnce({
      id: 'sub-existing',
      source: 'jotform',
      external_submission_id: 'SUB-001',
      raw_payload_json: {},
      normalized_payload_json: null,
      received_at: new Date(),
      processed_at: null,
      processing_status: 'processed',
      idempotency_key: 'jotform:SUB-001',
      correlation_id: 'corr-old',
      error_message: null,
    });

    const res = await request(app)
      .post('/webhooks/jotform')
      .send(validPayload)
      .expect(200);

    expect(res.body.status).toBe('duplicate');
  });

  it('accepts payload without submissionID (generates one)', async () => {
    const { findByIdempotencyKey } = await import('../../src/modules/intake/intake.repository');
    vi.mocked(findByIdempotencyKey).mockResolvedValueOnce(null);

    const noIdPayload = { ...validPayload };
    delete (noIdPayload as any).submissionID;

    const res = await request(app)
      .post('/webhooks/jotform')
      .send(noIdPayload)
      .expect(202);

    expect(res.body.status).toBe('received');
  });

  it('does not log request-body values when rawRequest parsing fails', async () => {
    const sensitiveValue = 'private-customer-value';
    await request(app)
      .post('/webhooks/jotform')
      .send({ submissionID: 'SUB-BAD-JSON', rawRequest: '{bad-json', q4_email: sensitiveValue })
      .expect(202);

    const childResults = vi.mocked(logger.child).mock.results;
    const loggedCalls = childResults.flatMap((result) => {
      const child = result.value as { warn: ReturnType<typeof vi.fn> };
      return child?.warn?.mock.calls ?? [];
    });
    expect(JSON.stringify(loggedCalls)).not.toContain(sensitiveValue);
    expect(JSON.stringify(loggedCalls)).not.toContain('{bad-json');
  });
});

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe('2.0.0');
  });
});

describe('POST /webhooks/dispatch-response', () => {
  it('returns 200 stub response', async () => {
    const res = await request(app)
      .post('/webhooks/dispatch-response')
      .send({ dispatchId: 'disp-1', response: 'accepted' })
      .expect(200);

    expect(res.body.status).toBe('received');
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain('disp-1');
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain('accepted');
  });
});
