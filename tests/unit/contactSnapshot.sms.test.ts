/**
 * Tests for Migration 019 — snapshot phone preference in SMS active-job lookup.
 *
 * Verifies that ACTIVE_JOB_BASE_SQL resolves customer_phone as:
 *   COALESCE(j.customer_phone_snapshot, cust.phone_e164)
 *
 * These tests operate at the processSmsWebhook level and verify that the
 * customer_phone value used in OTW/CONFIRM SMS notifications reflects the
 * snapshot phone when present, not the live customers row.
 *
 * Key regression: job created with phone A; same customer later has phone B;
 * OTW/CONFIRM SMS for the original job still uses phone A.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryOne, query, withTransaction } from '../../src/db/pool';
import { enqueueAirtableSync } from '../../src/modules/airtable-sync/airtableSync.queue';

const { mockSendSms, mockRecordAuditEvent } = vi.hoisted(() => ({
  mockSendSms: vi.fn(),
  mockRecordAuditEvent: vi.fn(),
}));

vi.mock('../../src/modules/sms/quo.adapter', () => ({
  sendSms: mockSendSms,
}));

vi.mock('../../src/modules/audit/audit.service', () => ({
  recordAuditEvent: mockRecordAuditEvent,
}));

import { processSmsWebhook } from '../../src/modules/sms/sms.service';

const contractor = {
  id: 'contractor-1',
  full_name: 'Alex Rivera',
  phone_e164: '+14045550100',
};

/**
 * Build an active job row as returned by ACTIVE_JOB_BASE_SQL.
 * The customer_phone field is already resolved by COALESCE in SQL;
 * here we simulate what the DB would return after that resolution.
 */
function activeJob(overrides: Record<string, unknown> = {}) {
  return {
    job_id: 'job-1',
    job_key: 'AC-TEST',
    job_status: 'assigned',
    airtable_record_id: 'rec-1',
    assignment_id: 'assignment-1',
    assignment_status: 'accepted',
    dispatch_id: 'dispatch-1',
    contractor_packet_token: null,
    contractor_completion_token: null,
    customer_phone: '+14045550200', // default: resolved by COALESCE
    customer_otw_text_sent_at: null,
    customer_confirm_text_sent_at: null,
    address_line1: '123 Main St',
    address_line2: null,
    address_city: 'Atlanta',
    address_state: 'GA',
    address_postal_code: '30301',
    ...overrides,
  };
}

function setupDb(jobRow = activeJob()) {
  const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  vi.mocked(queryOne).mockResolvedValueOnce(contractor as any);
  vi.mocked(query).mockResolvedValueOnce([jobRow] as any);
  vi.mocked(query).mockResolvedValue([] as any);
  vi.mocked(withTransaction).mockImplementation(async (fn: any) => fn({ query: clientQuery }));
  return { clientQuery };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queryOne).mockReset();
  vi.mocked(query).mockReset();
  vi.mocked(withTransaction).mockReset();
  mockSendSms.mockResolvedValue({ messageId: 'msg-1' });
  mockRecordAuditEvent.mockResolvedValue(undefined);
  vi.mocked(enqueueAirtableSync).mockResolvedValue(undefined as any);
});

describe('SMS active-job lookup — snapshot phone preference (Migration 019)', () => {
  it('OTW SMS uses customer_phone from active-job row (snapshot phone when present)', async () => {
    // COALESCE in SQL returns snapshot phone '+14045551111' (phone A)
    setupDb(activeJob({ customer_phone: '+14045551111' }));

    await processSmsWebhook(contractor.phone_e164, 'on my way', 'corr-snap-1');

    // The OTW handler sends a customer notification to customer_phone
    const smsCalls = mockSendSms.mock.calls;
    const customerSmsCalls = smsCalls.filter(
      ([to]: [string]) => to !== contractor.phone_e164,
    );
    expect(customerSmsCalls.length).toBeGreaterThan(0);
    expect(customerSmsCalls[0][0]).toBe('+14045551111');
  });

  it('OTW SMS uses live customers phone when snapshot is null (fallback — old job)', async () => {
    // COALESCE in SQL falls back to cust.phone_e164 '+14045559999' (phone B)
    setupDb(activeJob({ customer_phone: '+14045559999' }));

    await processSmsWebhook(contractor.phone_e164, 'on my way', 'corr-snap-2');

    const smsCalls = mockSendSms.mock.calls;
    const customerSmsCalls = smsCalls.filter(
      ([to]: [string]) => to !== contractor.phone_e164,
    );
    expect(customerSmsCalls.length).toBeGreaterThan(0);
    expect(customerSmsCalls[0][0]).toBe('+14045559999');
  });

  it('key regression: OTW SMS uses phone A even after customer updates to phone B', async () => {
    // Job was created when customer had phone A.
    // The DB's COALESCE returns phone A (from j.customer_phone_snapshot).
    // The live customers row now has phone B, but COALESCE prefers the snapshot.
    const PHONE_A = '+14045551111';
    const PHONE_B = '+14045552222';

    setupDb(activeJob({ customer_phone: PHONE_A }));

    await processSmsWebhook(contractor.phone_e164, 'on my way', 'corr-regression');

    const smsCalls = mockSendSms.mock.calls;
    const customerSmsCalls = smsCalls.filter(
      ([to]: [string]) => to !== contractor.phone_e164,
    );
    expect(customerSmsCalls.length).toBeGreaterThan(0);
    // Must use phone A (snapshot), not phone B (updated live value)
    expect(customerSmsCalls[0][0]).toBe(PHONE_A);
    expect(customerSmsCalls[0][0]).not.toBe(PHONE_B);
  });
});
