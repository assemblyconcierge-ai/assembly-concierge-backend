/**
 * Integration tests for POST /webhooks/jotform/contractor-onboarding
 *
 * Tests cover:
 *  - Missing or invalid token → 401
 *  - Token check skipped when env var not set
 *  - Wrong formID → 400
 *  - Missing contractorRecord → 422
 *  - Missing backendContractor → 422
 *  - Contractor not found → 404
 *  - Duplicate submission → 200 with status: duplicate
 *  - Successful processing → 200 with status: processed
 *  - rawRequest JSON envelope is parsed correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mock the onboarding service ───────────────────────────────────────────────
vi.mock('../../src/modules/onboarding/onboarding.service', () => ({
  processOnboardingSubmission: vi.fn(),
}));

// ── Mock config to control token ──────────────────────────────────────────────
vi.mock('../../src/common/config', () => ({
  config: {
    JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN: 'test-secret-token',
    JOTFORM_ONBOARDING_FORM_ID: '261801729818060',
    NODE_ENV: 'test',
  },
}));

import { processOnboardingSubmission } from '../../src/modules/onboarding/onboarding.service';
import { onboardingRouter } from '../../src/modules/onboarding/onboarding.routes';
import { config } from '../../src/common/config';
import { logger } from '../../src/common/logger';

const mockProcess = processOnboardingSubmission as ReturnType<typeof vi.fn>;

// Build a minimal test app
function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/', onboardingRouter);
  return app;
}

const VALID_TOKEN = 'test-secret-token';
const CONTRACTOR_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const AIRTABLE_RECORD_ID = 'recABC123';
const SUBMISSION_ID = 'sub_001';

const VALID_BODY = {
  formID: '261801729818060',
  submissionID: SUBMISSION_ID,
  q34_contractorRecord: AIRTABLE_RECORD_ID,
  q35_backendContractor: CONTRACTOR_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(config, {
    JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN: VALID_TOKEN,
    NODE_ENV: 'test',
  });
});

describe('POST /webhooks/jotform/contractor-onboarding', () => {
  it('returns 503 in production when the configured webhook token is absent', async () => {
    Object.assign(config, {
      JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN: undefined,
      NODE_ENV: 'production',
    });

    const res = await request(buildTestApp())
      .post('/webhooks/jotform/contractor-onboarding')
      .send(VALID_BODY);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('WEBHOOK_SECURITY_NOT_CONFIGURED');
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('returns 401 when token is missing', async () => {
    const app = buildTestApp();
    const res = await request(app)
      .post('/webhooks/jotform/contractor-onboarding')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('returns 401 when token is wrong', async () => {
    const app = buildTestApp();
    const res = await request(app)
      .post('/webhooks/jotform/contractor-onboarding?token=wrong-token')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 400 for wrong formID', async () => {
    mockProcess.mockRejectedValueOnce(
      Object.assign(new Error('Wrong formID'), { statusCode: 400, code: 'WRONG_FORM_ID' }),
    );
    const app = buildTestApp();
    const res = await request(app)
      .post(`/webhooks/jotform/contractor-onboarding?token=${VALID_TOKEN}`)
      .send({ ...VALID_BODY, formID: '999999' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('WRONG_FORM_ID');
  });

  it('returns 422 when contractorRecord is missing', async () => {
    mockProcess.mockRejectedValueOnce(
      Object.assign(new Error('Missing contractorRecord'), {
        statusCode: 422,
        code: 'MISSING_CONTRACTOR_RECORD',
      }),
    );
    const app = buildTestApp();
    const res = await request(app)
      .post(`/webhooks/jotform/contractor-onboarding?token=${VALID_TOKEN}`)
      .send({ ...VALID_BODY, q34_contractorRecord: '' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('MISSING_CONTRACTOR_RECORD');
  });

  it('returns 422 when backendContractor is missing', async () => {
    mockProcess.mockRejectedValueOnce(
      Object.assign(new Error('Missing backendContractor'), {
        statusCode: 422,
        code: 'MISSING_BACKEND_CONTRACTOR_ID',
      }),
    );
    const app = buildTestApp();
    const res = await request(app)
      .post(`/webhooks/jotform/contractor-onboarding?token=${VALID_TOKEN}`)
      .send({ ...VALID_BODY, q35_backendContractor: '' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('MISSING_BACKEND_CONTRACTOR_ID');
  });

  it('returns 404 when contractor not found', async () => {
    mockProcess.mockRejectedValueOnce(
      Object.assign(new Error('Contractor not found'), {
        statusCode: 404,
        code: 'CONTRACTOR_NOT_FOUND',
      }),
    );
    const app = buildTestApp();
    const res = await request(app)
      .post(`/webhooks/jotform/contractor-onboarding?token=${VALID_TOKEN}`)
      .send(VALID_BODY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CONTRACTOR_NOT_FOUND');
  });

  it('returns 200 with status duplicate for already-processed submission', async () => {
    mockProcess.mockResolvedValueOnce({
      status: 'duplicate',
      contractorId: CONTRACTOR_ID,
      documentStatus: 'Submitted - Docs Complete',
      processedFiles: [],
      errors: [],
    });
    const app = buildTestApp();
    const res = await request(app)
      .post(`/webhooks/jotform/contractor-onboarding?token=${VALID_TOKEN}`)
      .send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('duplicate');
    expect(res.body.documentStatus).toBe('Submitted - Docs Complete');
  });

  it('returns 200 with status processed on success', async () => {
    mockProcess.mockResolvedValueOnce({
      status: 'processed',
      contractorId: CONTRACTOR_ID,
      documentStatus: 'Submitted - Docs Complete',
      processedFiles: ['W-9', 'Photo ID'],
      errors: [],
    });
    const app = buildTestApp();
    const res = await request(app)
      .post(`/webhooks/jotform/contractor-onboarding?token=${VALID_TOKEN}`)
      .send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(res.body.processedFiles).toContain('W-9');
    expect(res.body.processedFiles).toContain('Photo ID');
    expect(res.body.errors).toHaveLength(0);
  });

  it('parses rawRequest JSON envelope correctly', async () => {
    mockProcess.mockResolvedValueOnce({
      status: 'processed',
      contractorId: CONTRACTOR_ID,
      documentStatus: 'Submitted - Missing Items',
      processedFiles: [],
      errors: [],
    });
    const app = buildTestApp();
    const rawBody = {
      formID: '261801729818060',
      submissionID: SUBMISSION_ID,
      rawRequest: JSON.stringify(VALID_BODY),
    };
    const res = await request(app)
      .post(`/webhooks/jotform/contractor-onboarding?token=${VALID_TOKEN}`)
      .send(rawBody);
    expect(res.status).toBe(200);
    // Verify the service was called with the parsed rawRequest fields
    const callArg = mockProcess.mock.calls[0][0];
    expect(callArg.q34_contractorRecord).toBe(AIRTABLE_RECORD_ID);
    expect(callArg.q35_backendContractor).toBe(CONTRACTOR_ID);
  });

  it('does not log request-body values when rawRequest parsing fails', async () => {
    const sensitiveValue = 'private-onboarding-value';
    mockProcess.mockResolvedValueOnce({
      status: 'processed',
      contractorId: CONTRACTOR_ID,
      documentStatus: 'Submitted - Missing Items',
      processedFiles: [],
      errors: [],
    });

    await request(buildTestApp())
      .post(`/webhooks/jotform/contractor-onboarding?token=${VALID_TOKEN}`)
      .send({ ...VALID_BODY, rawRequest: '{bad-json', q8_q8_email6: sensitiveValue })
      .expect(200);

    const childResults = vi.mocked(logger.child).mock.results;
    const loggedCalls = childResults.flatMap((result) => {
      const child = result.value as { warn: ReturnType<typeof vi.fn> };
      return child?.warn?.mock.calls ?? [];
    });
    expect(JSON.stringify(loggedCalls)).not.toContain(sensitiveValue);
    expect(JSON.stringify(loggedCalls)).not.toContain('{bad-json');
  });

  it('returns 200 with partial errors when some files fail', async () => {
    mockProcess.mockResolvedValueOnce({
      status: 'processed',
      contractorId: CONTRACTOR_ID,
      documentStatus: 'Submitted - Missing Items',
      processedFiles: ['W-9'],
      errors: ['Photo ID: Drive upload failed'],
    });
    const app = buildTestApp();
    const res = await request(app)
      .post(`/webhooks/jotform/contractor-onboarding?token=${VALID_TOKEN}`)
      .send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toContain('Photo ID');
  });
});
