/**
 * Unit tests for contractor admin endpoints:
 *   POST /contractors:
 *   - phone normalization (normalizePhone utility)
 *   - flexible phone field names (phoneE164 / phone / phoneNumber)
 *   - duplicate phone 409
 *   - missing phone 400
 *   - invalid/short phone 400
 *   - happy path 201 with normalized phone_e164, is_active=false
 *   - audit event fired (fire-and-forget)
 *
 *   POST /contractors/:id/activate:
 *   - 200 + is_active=true on success
 *   - 404 for unknown contractor
 *   - 409 ALREADY_ACTIVE when contractor is already active
 *   - audit event contractor.activated fired (fire-and-forget)
 *
 * Strategy: test normalizePhone directly (pure function), then test route
 * handlers via supertest against a minimal Express app that mounts adminRouter
 * with the DB pool mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist mock variables ──────────────────────────────────────────────────────
const { mockQuery, mockRecordAuditEvent, mockLoggerWarn } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockRecordAuditEvent: vi.fn().mockResolvedValue(undefined),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('../../src/db/pool', () => ({
  query: mockQuery,
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../../src/modules/audit/audit.service', () => ({
  recordAuditEvent: mockRecordAuditEvent,
}));

// Mock requireAdmin to be a pass-through in tests
vi.mock('../../src/common/middleware/auth', () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Mock pricing/service-area imports used by adminRouter (not under test)
vi.mock('../../src/modules/pricing/pricing.service', () => ({
  getAllPricingRules: vi.fn(),
  upsertPricingRule: vi.fn(),
}));
vi.mock('../../src/modules/service-areas/serviceArea.service', () => ({
  getAllServiceAreas: vi.fn(),
  upsertServiceArea: vi.fn(),
}));

vi.mock('../../src/common/logger', () => ({
  logger: {
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() }),
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import express from 'express';
import request from 'supertest';
import { normalizePhone, strictNormalizePhone } from '../../src/common/utils';
import { adminRouter } from '../../src/modules/admin/admin.routes';
import { globalErrorHandler } from '../../src/common/errors/errorHandler';

// ── Build a minimal test app ──────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  // Attach correlationId so globalErrorHandler can reference it
  app.use((req: any, _res: any, next: any) => { req.correlationId = 'test-correlation-id'; next(); });
  app.use('/admin', adminRouter);
  app.use(globalErrorHandler);
  return app;
}
// ── normalizePhone unit tests (lenient — original behavior preserved) ───────────────────
describe('normalizePhone() — lenient (existing callers unaffected)', () => {
  it('normalizes a raw 10-digit number', () => {
    expect(normalizePhone('4044256394')).toBe('+14044256394');
  });

  it('normalizes a formatted number with dashes', () => {
    expect(normalizePhone('404-425-6394')).toBe('+14044256394');
  });

  it('normalizes a formatted number with parentheses and spaces', () => {
    expect(normalizePhone('(404) 425-6394')).toBe('+14044256394');
  });

  it('normalizes an 11-digit number with leading 1', () => {
    expect(normalizePhone('14044256394')).toBe('+14044256394');
  });

  it('normalizes a +1 formatted number with spaces', () => {
    expect(normalizePhone('+1 404 425 6394')).toBe('+14044256394');
  });

  it('normalizes an already-E.164 number', () => {
    expect(normalizePhone('+14044256394')).toBe('+14044256394');
  });

  it('does NOT throw for a short/malformed number — returns best-effort E.164', () => {
    // Original lenient behavior: silently prefixes whatever digits are present
    expect(() => normalizePhone('12345')).not.toThrow();
    expect(normalizePhone('12345')).toBe('+12345');
  });

  it('does NOT throw for an empty string — returns +', () => {
    expect(() => normalizePhone('')).not.toThrow();
    expect(normalizePhone('')).toBe('+');
  });
});

// ── strictNormalizePhone unit tests (strict — used only in POST /contractors) ────────────
describe('strictNormalizePhone() — strict (contractor creation only)', () => {
  it('normalizes a raw 10-digit number', () => {
    expect(strictNormalizePhone('4044256394')).toBe('+14044256394');
  });

  it('normalizes a formatted number with dashes', () => {
    expect(strictNormalizePhone('404-425-6394')).toBe('+14044256394');
  });

  it('normalizes a formatted number with parentheses and spaces', () => {
    expect(strictNormalizePhone('(404) 425-6394')).toBe('+14044256394');
  });

  it('normalizes an 11-digit number with leading 1', () => {
    expect(strictNormalizePhone('14044256394')).toBe('+14044256394');
  });

  it('normalizes a +1 formatted number with spaces', () => {
    expect(strictNormalizePhone('+1 404 425 6394')).toBe('+14044256394');
  });

  it('normalizes an already-E.164 number', () => {
    expect(strictNormalizePhone('+14044256394')).toBe('+14044256394');
  });

  it('throws TypeError for a short/malformed number (5 digits)', () => {
    expect(() => strictNormalizePhone('12345')).toThrow(TypeError);
    expect(() => strictNormalizePhone('12345')).toThrow(/too short/);
  });

  it('throws TypeError for an empty string', () => {
    expect(() => strictNormalizePhone('')).toThrow(TypeError);
    expect(() => strictNormalizePhone('')).toThrow(/too short/);
  });

  it('throws TypeError for a number that is too long (12 digits)', () => {
    expect(() => strictNormalizePhone('123456789012')).toThrow(TypeError);
    expect(() => strictNormalizePhone('123456789012')).toThrow(/too long/);
  });

  it('throws TypeError for 11 digits not starting with 1', () => {
    expect(() => strictNormalizePhone('24044256394')).toThrow(TypeError);
    expect(() => strictNormalizePhone('24044256394')).toThrow(/country code 1/);
  });
});

// ── POST /admin/contractors route tests ───────────────────────────────────────
describe('POST /admin/contractors', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordAuditEvent.mockResolvedValue(undefined);
  });

  it('returns 201 and stores normalized phone_e164 for a 10-digit raw phone via phoneE164 field', async () => {
    // First query: duplicate check → no conflict
    mockQuery.mockResolvedValueOnce([]);
    // Second query: INSERT RETURNING * — is_active is FALSE (inactive by default)
    mockQuery.mockResolvedValueOnce([{
      id: 'contractor-uuid-1',
      full_name: 'Test Contractor',
      phone_e164: '+14044256394',
      email: null,
      city: 'Hampton',
      notes: null,
      is_active: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);

    const res = await request(app)
      .post('/admin/contractors')
      .send({ fullName: 'Test Contractor', phoneE164: '4044256394', city: 'Hampton' });

    expect(res.status).toBe(201);
    expect(res.body.contractor.phone_e164).toBe('+14044256394');
    // Contractor is created inactive by default
    expect(res.body.contractor.is_active).toBe(false);
    // Confirm duplicate check was called with normalized value
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT id FROM contractors WHERE phone_e164 = $1',
      ['+14044256394'],
    );
  });

  it('returns 201 when phone is provided via the "phone" field (Make/Airtable raw format)', async () => {
    mockQuery.mockResolvedValueOnce([]); // no conflict
    mockQuery.mockResolvedValueOnce([{
      id: 'contractor-uuid-2',
      full_name: 'Another Contractor',
      phone_e164: '+14044256394',
      email: null,
      city: null,
      notes: null,
      is_active: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);

    const res = await request(app)
      .post('/admin/contractors')
      .send({ fullName: 'Another Contractor', phone: '(404) 425-6394' });

    expect(res.status).toBe(201);
    expect(res.body.contractor.phone_e164).toBe('+14044256394');
    expect(res.body.contractor.is_active).toBe(false);
  });

  it('returns 201 when phone is provided via the "phoneNumber" field', async () => {
    mockQuery.mockResolvedValueOnce([]); // no conflict
    mockQuery.mockResolvedValueOnce([{
      id: 'contractor-uuid-3',
      full_name: 'Third Contractor',
      phone_e164: '+14044256394',
      email: null,
      city: null,
      notes: null,
      is_active: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);

    const res = await request(app)
      .post('/admin/contractors')
      .send({ fullName: 'Third Contractor', phoneNumber: '+1 404 425 6394' });

    expect(res.status).toBe(201);
    expect(res.body.contractor.phone_e164).toBe('+14044256394');
    expect(res.body.contractor.is_active).toBe(false);
  });

  it('returns 400 when fullName is missing', async () => {
    const res = await request(app)
      .post('/admin/contractors')
      .send({ phoneE164: '4044256394' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when no phone field is provided', async () => {
    const res = await request(app)
      .post('/admin/contractors')
      .send({ fullName: 'Test Contractor' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_PHONE');
  });

  it('returns 400 with INVALID_PHONE for a short/malformed phone number', async () => {
    const res = await request(app)
      .post('/admin/contractors')
      .send({ fullName: 'Test Contractor', phone: '12345' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PHONE');
    expect(res.body.message).toMatch(/too short/);
  });

  it('returns 409 PHONE_IN_USE when normalized phone already exists', async () => {
    // Duplicate check returns a conflict row
    mockQuery.mockResolvedValueOnce([{ id: 'existing-contractor-uuid' }]);

    const res = await request(app)
      .post('/admin/contractors')
      .send({ fullName: 'Duplicate Contractor', phone: '4044256394' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PHONE_IN_USE');
  });

  it('fires audit event after successful contractor creation', async () => {
    mockQuery.mockResolvedValueOnce([]); // no conflict
    mockQuery.mockResolvedValueOnce([{
      id: 'contractor-uuid-audit',
      full_name: 'Audit Test',
      phone_e164: '+14044256394',
      email: null,
      city: null,
      notes: null,
      is_active: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);

    await request(app)
      .post('/admin/contractors')
      .send({ fullName: 'Audit Test', phone: '4044256394' });

    // Give the fire-and-forget a tick to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateType: 'contractor',
        eventType: 'contractor.created',
        actorType: 'admin',
        payload: expect.objectContaining({ phoneE164: '+14044256394' }),
      }),
    );
  });
});

// ── POST /admin/contractors/:id/activate route tests ──────────────────────────
describe('POST /admin/contractors/:id/activate', () => {
  const app = buildApp();
  const CONTRACTOR_ID = 'contractor-uuid-activate';

  /** All 11 required readiness fields set to true (Phase 3 adds onboardingDocumentsAccepted). */
  const FULL_READINESS_PAYLOAD = {
    activationRequested:          true,
    onboardingComplete:           true,
    activationReady:              true,
    agreementReceived:            true,
    w9Received:                   true,
    paymentSetupComplete:         true,
    smsConsentConfirmed:          true,
    toolsTransportationConfirmed: true,
    handbookAcknowledged:         true,
    photoIdReceived:              true,
    onboardingDocumentsAccepted:  true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordAuditEvent.mockResolvedValue(undefined);
  });

  // ── Happy path ─────────────────────────────────────────────────────────────────

  it('returns 200 Activated with structured envelope when all readiness fields are true', async () => {
    // SELECT → contractor exists, inactive
    mockQuery.mockResolvedValueOnce([{ id: CONTRACTOR_ID, is_active: false }]);
    // UPDATE (no RETURNING needed — response is built from input)
    mockQuery.mockResolvedValueOnce([]);

    const res = await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send(FULL_READINESS_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      activationStatus: 'Activated',
      contractorId: CONTRACTOR_ID,
      isActive: true,
      missingRequirements: [],
    });
  });

  it('accepts backendContractorId when it matches :id', async () => {
    mockQuery.mockResolvedValueOnce([{ id: CONTRACTOR_ID, is_active: false }]);
    mockQuery.mockResolvedValueOnce([]);

    const res = await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send({ ...FULL_READINESS_PAYLOAD, backendContractorId: CONTRACTOR_ID });

    expect(res.status).toBe(200);
    expect(res.body.activationStatus).toBe('Activated');
  });

  it('does not block when backendContractorId is absent', async () => {
    mockQuery.mockResolvedValueOnce([{ id: CONTRACTOR_ID, is_active: false }]);
    mockQuery.mockResolvedValueOnce([]);

    const res = await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send(FULL_READINESS_PAYLOAD); // no backendContractorId key

    expect(res.status).toBe(200);
    expect(res.body.activationStatus).toBe('Activated');
  });

  // ── Readiness validation ───────────────────────────────────────────────────────

  it('returns 422 Blocked when one required field is missing (absent = not true)', async () => {
    const { w9Received: _omit, ...payloadMissingW9 } = FULL_READINESS_PAYLOAD;

    const res = await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send(payloadMissingW9);

    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.activationStatus).toBe('Blocked - Missing Info');
    expect(res.body.missingRequirements).toContain('w9Received');
    // DB must not have been queried at all
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 422 Blocked when one required field is explicitly false', async () => {
    const res = await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send({ ...FULL_READINESS_PAYLOAD, handbookAcknowledged: false });

    expect(res.status).toBe(422);
    expect(res.body.missingRequirements).toContain('handbookAcknowledged');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 422 with all missing fields when multiple are absent or false', async () => {
    const partialPayload = {
      activationRequested: true,
      onboardingComplete:  true,
      // remaining 8 fields absent
    };

    const res = await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send(partialPayload);

    expect(res.status).toBe(422);
    // 9 fields missing: the original 8 plus onboardingDocumentsAccepted (Phase 3)
    expect(res.body.missingRequirements).toHaveLength(9);
    expect(res.body.missingRequirements).toContain('activationReady');
    expect(res.body.missingRequirements).toContain('agreementReceived');
    expect(res.body.missingRequirements).toContain('w9Received');
    expect(res.body.missingRequirements).toContain('paymentSetupComplete');
    expect(res.body.missingRequirements).toContain('smsConsentConfirmed');
    expect(res.body.missingRequirements).toContain('toolsTransportationConfirmed');
    expect(res.body.missingRequirements).toContain('handbookAcknowledged');
    expect(res.body.missingRequirements).toContain('photoIdReceived');
    expect(res.body.missingRequirements).toContain('onboardingDocumentsAccepted');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 422 with backendContractorIdMismatch when backendContractorId does not match :id', async () => {
    const res = await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send({ ...FULL_READINESS_PAYLOAD, backendContractorId: 'wrong-id-999' });

    expect(res.status).toBe(422);
    expect(res.body.missingRequirements).toContain('backendContractorIdMismatch');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ── Already active ──────────────────────────────────────────────────────────────

  it('returns 200 Already Active (Make-friendly idempotent) when contractor is already active', async () => {
    // SELECT → contractor exists, already active
    mockQuery.mockResolvedValueOnce([{ id: CONTRACTOR_ID, is_active: true }]);

    const res = await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send(FULL_READINESS_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      activationStatus: 'Already Active',
      contractorId: CONTRACTOR_ID,
      isActive: true,
      missingRequirements: [],
    });
    // UPDATE must not have been called
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // ── Not found ───────────────────────────────────────────────────────────────────

  it('returns 404 Not Found with structured envelope when contractor does not exist', async () => {
    // SELECT → empty
    mockQuery.mockResolvedValueOnce([]);

    const res = await request(app)
      .post(`/admin/contractors/nonexistent-id/activate`)
      .send(FULL_READINESS_PAYLOAD);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      ok: false,
      activationStatus: 'Not Found',
      missingRequirements: ['contractor'],
    });
    // UPDATE must not have been called
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // ── Audit event ──────────────────────────────────────────────────────────────────

  it('fires contractor.activated audit event after successful activation', async () => {
    mockQuery.mockResolvedValueOnce([{ id: CONTRACTOR_ID, is_active: false }]);
    mockQuery.mockResolvedValueOnce([]);

    await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send(FULL_READINESS_PAYLOAD);

    // Give the fire-and-forget a tick to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateType: 'contractor',
        aggregateId: CONTRACTOR_ID,
        eventType: 'contractor.activated',
        actorType: 'admin',
      }),
    );
  });

  // ── Phase 3 — onboardingDocumentsAccepted gate ──────────────────────────────────

  it('Phase 3: returns 422 Blocked when onboardingDocumentsAccepted is missing', async () => {
    const { onboardingDocumentsAccepted: _omit, ...payloadWithout } = FULL_READINESS_PAYLOAD;

    const res = await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send(payloadWithout);

    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.activationStatus).toBe('Blocked - Missing Info');
    expect(res.body.missingRequirements).toContain('onboardingDocumentsAccepted');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('Phase 3: returns 422 Blocked when onboardingDocumentsAccepted is false', async () => {
    const res = await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send({ ...FULL_READINESS_PAYLOAD, onboardingDocumentsAccepted: false });

    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.activationStatus).toBe('Blocked - Missing Info');
    expect(res.body.missingRequirements).toContain('onboardingDocumentsAccepted');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('Phase 3: activation succeeds when all 11 fields are true including onboardingDocumentsAccepted', async () => {
    mockQuery.mockResolvedValueOnce([{ id: CONTRACTOR_ID, is_active: false }]);
    mockQuery.mockResolvedValueOnce([]);

    const res = await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send(FULL_READINESS_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.activationStatus).toBe('Activated');
    expect(res.body.isActive).toBe(true);
    expect(res.body.missingRequirements).toHaveLength(0);
  });

  it('Phase 3: failed activation (missing onboardingDocumentsAccepted) does not set contractor active', async () => {
    const { onboardingDocumentsAccepted: _omit, ...payloadWithout } = FULL_READINESS_PAYLOAD;

    const res = await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send(payloadWithout);

    expect(res.status).toBe(422);
    // DB must never have been queried — no SELECT, no UPDATE
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('Phase 3: failed activation (onboardingDocumentsAccepted=false) does not set active contractor status', async () => {
    const res = await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send({ ...FULL_READINESS_PAYLOAD, onboardingDocumentsAccepted: false });

    expect(res.status).toBe(422);
    expect(res.body.isActive).toBeUndefined();
    // No UPDATE issued
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('Phase 3: existing activation failure behavior still works for other missing fields (w9Received)', async () => {
    const { w9Received: _omit, ...payloadMissingW9 } = FULL_READINESS_PAYLOAD;

    const res = await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send(payloadMissingW9);

    expect(res.status).toBe(422);
    expect(res.body.missingRequirements).toContain('w9Received');
    expect(res.body.missingRequirements).not.toContain('onboardingDocumentsAccepted');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ── SQL correctness ──────────────────────────────────────────────────────────────

  it('issues UPDATE with only is_active=TRUE and updated_at — no other fields mutated', async () => {
    mockQuery.mockResolvedValueOnce([{ id: CONTRACTOR_ID, is_active: false }]);
    mockQuery.mockResolvedValueOnce([]);

    await request(app)
      .post(`/admin/contractors/${CONTRACTOR_ID}/activate`)
      .send(FULL_READINESS_PAYLOAD);

    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE contractors SET is_active = TRUE, updated_at = NOW\(\)/);
    expect(updateCall[0]).toMatch(/WHERE id = \$1/);
    // Only one parameter: the contractor id
    expect(updateCall[1]).toEqual([CONTRACTOR_ID]);
    // No RETURNING — response is built from known values, not DB row
    expect(updateCall[0]).not.toMatch(/RETURNING/);
  });
});
