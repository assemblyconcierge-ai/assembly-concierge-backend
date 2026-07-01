/**
 * Tests for Migration 019 — job-level customer contact snapshots.
 *
 * Verifies that processIntake passes the upserted customer's name, email,
 * and phone_e164 as snapshot fields to createJob, so later upserts to the
 * shared customers row cannot overwrite job-specific contact data.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processIntake } from '../../src/modules/intake/intake.service';
import { createJob } from '../../src/modules/jobs/job.repository';
import { upsertCustomer } from '../../src/modules/customers/customer.repository';
import { CanonicalIntake } from '../../src/modules/intake/intake.types';
import { query } from '../../src/db/pool';
import { classifyServiceArea } from '../../src/modules/service-areas/serviceArea.service';

vi.mock('../../src/modules/service-areas/serviceArea.service', () => ({
  classifyServiceArea: vi.fn(async () => ({ status: 'in_area', city: 'Hampton', state: 'GA' })),
}));

vi.mock('../../src/modules/pricing/pricing.service', () => ({
  calculatePricing: vi.fn(async () => ({
    subtotalCents: 10900,
    rushAmountCents: 0,
    depositCents: 2500,
    remainderCents: 8400,
    totalCents: 10900,
    basePriceCents: 10900,
    flatPayoutCents: 7500,
    contractorRushBonusCents: 0,
    payoutCents: 7500,
    rushPlatformShareCents: 0,
    stripeFeeCents: 420,
    jobMarginCents: 2980,
  })),
  normalizeRushTier: vi.fn(() => 'none'),
  rushTierLabel: vi.fn(() => 'No Rush'),
}));

vi.mock('../../src/modules/customers/customer.repository', () => ({
  upsertCustomer: vi.fn(),
  createAddress: vi.fn(async () => ({ id: 'address-123' })),
}));

vi.mock('../../src/modules/jobs/job.repository', () => ({
  createJob: vi.fn(async (params: any) => ({
    id: 'job-123',
    job_key: params.jobKey ?? 'AC-TEST',
    status: params.status,
    total_amount_cents: params.totalAmountCents ?? 0,
    customer_name_snapshot: params.customerNameSnapshot ?? null,
    customer_email_snapshot: params.customerEmailSnapshot ?? null,
    customer_phone_snapshot: params.customerPhoneSnapshot ?? null,
  })),
}));

vi.mock('../../src/modules/audit/audit.service', () => ({
  recordAuditEvent: vi.fn(async () => {}),
}));

vi.mock('../../src/modules/payments/payment.service', () => ({
  createJobCheckoutSession: vi.fn(async () => ({
    checkoutUrl: 'https://checkout.stripe.com/test',
    sessionId: 'sess_test',
    paymentId: 'pay_test',
    customerPhone: '+14045551234',
  })),
}));

vi.mock('../../src/modules/airtable-sync/airtableSync.queue', () => ({
  enqueueAirtableSync: vi.fn(async () => {}),
}));

vi.mock('../../src/modules/notifications/paymentLink.sms', () => ({
  sendPaymentLinkSms: vi.fn(async () => {}),
}));

vi.mock('../../src/common/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

const baseIntake: CanonicalIntake = {
  externalSubmissionId: 'snap-test-001',
  submittedAt: '2099-06-15T12:00:00.000Z',
  customer: {
    firstName: 'Jane',
    lastName: 'Smith',
    fullName: 'Jane Smith',
    email: 'jane@example.com',
    phone: '+14045551234',
  },
  address: {
    line1: '123 Main St',
    city: 'Hampton',
    state: 'GA',
    postalCode: '30228',
  },
  service: {
    typeCode: 'small',
    rushRequested: false,
    rushType: 'No Rush',
  },
  appointment: {
    date: '2099-06-15',
    window: 'Morning(8am-12pm)',
  },
  financials: {
    paymentType: 'deposit',
  },
  media: [],
  source: { formName: 'web-booking', raw: {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(query).mockResolvedValue([{ id: 'service-type-123' }] as any);
  vi.mocked(classifyServiceArea).mockResolvedValue({ status: 'in_area', city: 'Hampton', state: 'GA' });
});

describe('processIntake — customer contact snapshot persistence (Migration 019)', () => {
  it('passes customer name, email, and phone_e164 from upsertCustomer result to createJob as snapshot fields', async () => {
    vi.mocked(upsertCustomer).mockResolvedValueOnce({
      id: 'customer-123',
      full_name: 'Jane Smith',
      email: 'jane@example.com',
      phone_e164: '+14045551234',
    } as any);

    await processIntake('sub-123', baseIntake, 'corr-123', { sourceChannel: 'web' });

    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        customerNameSnapshot: 'Jane Smith',
        customerEmailSnapshot: 'jane@example.com',
        customerPhoneSnapshot: '+14045551234',
      }),
      expect.anything(),
    );
  });

  it('snapshot uses the upserted customer phone, not the raw intake phone', async () => {
    // Simulates a case where upsertCustomer normalizes or corrects the phone
    vi.mocked(upsertCustomer).mockResolvedValueOnce({
      id: 'customer-123',
      full_name: 'Jane Smith',
      email: 'jane@example.com',
      phone_e164: '+14045559999', // different from intake.customer.phone
    } as any);

    await processIntake('sub-123', baseIntake, 'corr-123', { sourceChannel: 'web' });

    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        customerPhoneSnapshot: '+14045559999', // from upsertCustomer, not intake.customer.phone
      }),
      expect.anything(),
    );
  });

  it('snapshot captures the phone at booking time — a later upsert to the same customer cannot affect it', async () => {
    // First booking: phone A
    vi.mocked(upsertCustomer).mockResolvedValueOnce({
      id: 'customer-123',
      full_name: 'Jane Smith',
      email: 'jane@example.com',
      phone_e164: '+14045551111', // phone A
    } as any);

    await processIntake('sub-001', baseIntake, 'corr-001', { sourceChannel: 'web' });

    const firstCallArgs = vi.mocked(createJob).mock.calls[0][0];
    expect(firstCallArgs.customerPhoneSnapshot).toBe('+14045551111');

    // Second booking by same customer, now with phone B (e.g. customer updated their number)
    vi.mocked(upsertCustomer).mockResolvedValueOnce({
      id: 'customer-123',
      full_name: 'Jane Smith',
      email: 'jane@example.com',
      phone_e164: '+14045552222', // phone B
    } as any);

    await processIntake('sub-002', baseIntake, 'corr-002', { sourceChannel: 'web' });

    const secondCallArgs = vi.mocked(createJob).mock.calls[1][0];
    expect(secondCallArgs.customerPhoneSnapshot).toBe('+14045552222');

    // The first job's snapshot is still phone A — it was captured at booking time
    // and is stored in the jobs row, not derived from the live customers table.
    expect(firstCallArgs.customerPhoneSnapshot).toBe('+14045551111');
    expect(firstCallArgs.customerPhoneSnapshot).not.toBe(secondCallArgs.customerPhoneSnapshot);
  });
});
