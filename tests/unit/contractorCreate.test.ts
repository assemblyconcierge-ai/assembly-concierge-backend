/**
 * Unit tests for POST /contractors hardening:
 *   - phone normalization (normalizePhone utility)
 *   - flexible phone field names (phoneE164 / phone / phoneNumber)
 *   - duplicate phone 409
 *   - missing phone 400
 *   - invalid/short phone 400
 *   - happy path 201 with normalized phone_e164
 *   - audit event fired (fire-and-forget)
 *
 * Strategy: test normalizePhone directly (pure function), then test the route
 * handler via supertest against a minimal Express app that mounts adminRouter
 * with the DB pool mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist mock variables ──────────────────────────────────────────────────────
const { mockQuery, mockRecordAuditEvent } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockRecordAuditEvent: vi.fn().mockResolvedValue(undefined),
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
    // Second query: INSERT RETURNING *
    mockQuery.mockResolvedValueOnce([{
      id: 'contractor-uuid-1',
      full_name: 'Test Contractor',
      phone_e164: '+14044256394',
      email: null,
      city: 'Hampton',
      notes: null,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);

    const res = await request(app)
      .post('/admin/contractors')
      .send({ fullName: 'Test Contractor', phoneE164: '4044256394', city: 'Hampton' });

    expect(res.status).toBe(201);
    expect(res.body.contractor.phone_e164).toBe('+14044256394');
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
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);

    const res = await request(app)
      .post('/admin/contractors')
      .send({ fullName: 'Another Contractor', phone: '(404) 425-6394' });

    expect(res.status).toBe(201);
    expect(res.body.contractor.phone_e164).toBe('+14044256394');
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
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);

    const res = await request(app)
      .post('/admin/contractors')
      .send({ fullName: 'Third Contractor', phoneNumber: '+1 404 425 6394' });

    expect(res.status).toBe(201);
    expect(res.body.contractor.phone_e164).toBe('+14044256394');
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
      is_active: true,
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
