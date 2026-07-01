/**
 * Tests for Migration 019 — snapshot-first contact resolution in createJobCheckoutSession.
 *
 * Verifies:
 * - When all three snapshot fields are present, they are used for Stripe checkout
 *   and the live customers table is NOT queried.
 * - When any snapshot field is null (old job), falls back to the live customers row.
 * - Key regression: a customer's phone change does not affect a previously booked job's
 *   checkout/payment SMS path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────
vi.mock('../../src/modules/jobs/job.repository', () => ({
  getJobById: vi.fn(),
  updateJobStatus: vi.fn(),
}));

vi.mock('../../src/db/pool', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(async (fn: any) => {
    const client = { query: vi.fn(async () => ({ rows: [{ id: 'pay-1', job_id: 'job-1', payment_type: 'deposit', amount_due_cents: 2500, status: 'checkout_created' }] })) };
    return fn(client);
  }),
}));

vi.mock('../../src/modules/payments/stripe.adapter', () => ({
  createCheckoutSession: vi.fn(async () => ({
    id: 'sess_test',
    url: 'https://checkout.stripe.com/test',
  })),
}));

vi.mock('../../src/modules/audit/audit.service', () => ({
  recordAuditEvent: vi.fn(async () => {}),
}));

vi.mock('../../src/modules/airtable-sync/airtable.payments.adapter', () => ({
  createAirtablePaymentRow: vi.fn(async () => {}),
}));

vi.mock('../../src/common/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

vi.mock('../../src/common/config', () => ({
  config: {
    APP_BASE_URL: 'https://api.example.com',
    FRONTEND_BASE_URL: 'https://app.example.com',
    NODE_ENV: 'test',
  },
}));

import { getJobById } from '../../src/modules/jobs/job.repository';
import { query } from '../../src/db/pool';
import { createCheckoutSession } from '../../src/modules/payments/stripe.adapter';
import { createJobCheckoutSession } from '../../src/modules/payments/payment.service';

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    job_key: 'AC-2026-TEST',
    customer_id: 'cust-1',
    status: 'awaiting_payment',
    payment_mode: 'deposit',
    total_amount_cents: 10900,
    deposit_amount_cents: 2500,
    remainder_amount_cents: 8400,
    public_pay_token: 'ppt_test',
    airtable_record_id: null,
    customer_name_snapshot: null,
    customer_email_snapshot: null,
    customer_phone_snapshot: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(query).mockResolvedValue([] as any);
});

// ── Snapshot-first path ───────────────────────────────────────────────────────
describe('createJobCheckoutSession — snapshot-first contact resolution', () => {
  it('uses snapshot name/email/phone when all three are present and does NOT query customers table', async () => {
    vi.mocked(getJobById).mockResolvedValueOnce(makeJob({
      customer_name_snapshot: 'Jane Smith',
      customer_email_snapshot: 'jane@example.com',
      customer_phone_snapshot: '+14045551111',
    }) as any);

    const result = await createJobCheckoutSession('job-1', 'deposit', 'corr-1');

    // Stripe session was created with snapshot values
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customerName: 'Jane Smith',
        customerEmail: 'jane@example.com',
      }),
    );

    // The live customers table was NOT queried
    const queryCalls = vi.mocked(query).mock.calls.map((c) => c[0] as string);
    const customerLookup = queryCalls.find((sql) => sql.includes('FROM customers'));
    expect(customerLookup).toBeUndefined();

    // Returned phone is from snapshot
    expect(result.customerPhone).toBe('+14045551111');
  });

  it('returns snapshot phone in result (used for payment link SMS)', async () => {
    vi.mocked(getJobById).mockResolvedValueOnce(makeJob({
      customer_name_snapshot: 'Jane Smith',
      customer_email_snapshot: 'jane@example.com',
      customer_phone_snapshot: '+14045551111',
    }) as any);

    const result = await createJobCheckoutSession('job-1', 'deposit', 'corr-1');
    expect(result.customerPhone).toBe('+14045551111');
  });
});

// ── Fallback path (old jobs without snapshots) ────────────────────────────────
describe('createJobCheckoutSession — live customers fallback for old jobs', () => {
  it('queries the live customers table when all snapshots are null', async () => {
    vi.mocked(getJobById).mockResolvedValueOnce(makeJob({
      customer_name_snapshot: null,
      customer_email_snapshot: null,
      customer_phone_snapshot: null,
    }) as any);

    // Live customers row
    vi.mocked(query).mockResolvedValueOnce([{
      full_name: 'Jane Smith',
      email: 'jane@example.com',
      phone_e164: '+14045559999',
    }] as any);

    const result = await createJobCheckoutSession('job-1', 'deposit', 'corr-1');

    const queryCalls = vi.mocked(query).mock.calls.map((c) => c[0] as string);
    const customerLookup = queryCalls.find((sql) => sql.includes('FROM customers'));
    expect(customerLookup).toBeDefined();

    expect(result.customerPhone).toBe('+14045559999');
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customerName: 'Jane Smith',
        customerEmail: 'jane@example.com',
      }),
    );
  });

  it('queries the live customers table when any snapshot field is null', async () => {
    // Only phone snapshot is missing — all three must be present to skip live lookup
    vi.mocked(getJobById).mockResolvedValueOnce(makeJob({
      customer_name_snapshot: 'Jane Smith',
      customer_email_snapshot: 'jane@example.com',
      customer_phone_snapshot: null, // missing
    }) as any);

    vi.mocked(query).mockResolvedValueOnce([{
      full_name: 'Jane Smith',
      email: 'jane@example.com',
      phone_e164: '+14045559999',
    }] as any);

    const result = await createJobCheckoutSession('job-1', 'deposit', 'corr-1');

    const queryCalls = vi.mocked(query).mock.calls.map((c) => c[0] as string);
    const customerLookup = queryCalls.find((sql) => sql.includes('FROM customers'));
    expect(customerLookup).toBeDefined();
    expect(result.customerPhone).toBe('+14045559999');
  });
});

// ── Key regression: phone overwrite ──────────────────────────────────────────
describe('createJobCheckoutSession — phone overwrite regression', () => {
  it('remainder/payment SMS path still uses phone A after customer updates to phone B', async () => {
    // Job was created when customer had phone A — snapshot captured at booking time
    vi.mocked(getJobById).mockResolvedValueOnce(makeJob({
      customer_name_snapshot: 'Jane Smith',
      customer_email_snapshot: 'jane@example.com',
      customer_phone_snapshot: '+14045551111', // phone A — captured at booking
    }) as any);

    // Simulate: customer later updated their phone to B in the customers table.
    // The live customers row now has phone B.
    // query() should NOT be called for customers when snapshot is complete,
    // but we set it up to return phone B to prove it is not used.
    vi.mocked(query).mockResolvedValueOnce([{
      full_name: 'Jane Smith',
      email: 'jane@example.com',
      phone_e164: '+14045552222', // phone B — the updated live value
    }] as any);

    const result = await createJobCheckoutSession('job-1', 'remainder', 'corr-regression');

    // Payment/SMS path must use phone A (the snapshot), not phone B (the live value)
    expect(result.customerPhone).toBe('+14045551111');
    expect(result.customerPhone).not.toBe('+14045552222');

    // Confirm the live customers table was skipped entirely
    const queryCalls = vi.mocked(query).mock.calls.map((c) => c[0] as string);
    const customerLookup = queryCalls.find((sql) => sql.includes('FROM customers'));
    expect(customerLookup).toBeUndefined();
  });
});
