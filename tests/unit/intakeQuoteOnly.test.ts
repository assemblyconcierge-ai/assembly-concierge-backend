import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processIntake } from '../../src/modules/intake/intake.service';
import { calculatePricing } from '../../src/modules/pricing/pricing.service';
import { createJob } from '../../src/modules/jobs/job.repository';
import { createJobCheckoutSession } from '../../src/modules/payments/payment.service';
import { CanonicalIntake } from '../../src/modules/intake/intake.types';

vi.mock('../../src/modules/service-areas/serviceArea.service', () => ({
  classifyServiceArea: vi.fn(async () => ({ status: 'in_area', city: 'Hampton', state: 'GA' })),
}));

vi.mock('../../src/modules/pricing/pricing.service', () => ({
  calculatePricing: vi.fn(),
  normalizeRushTier: vi.fn(() => 'none'),
  rushTierLabel: vi.fn(() => 'No Rush'),
}));

vi.mock('../../src/modules/customers/customer.repository', () => ({
  upsertCustomer: vi.fn(async () => ({ id: 'customer-123' })),
  createAddress: vi.fn(async () => ({ id: 'address-123' })),
}));

vi.mock('../../src/modules/jobs/job.repository', () => ({
  createJob: vi.fn(async (params: any) => ({
    id: 'job-123',
    job_key: params.jobKey,
    status: params.status,
    total_amount_cents: params.totalAmountCents,
  })),
}));

vi.mock('../../src/modules/audit/audit.service', () => ({
  recordAuditEvent: vi.fn(async () => {}),
}));

vi.mock('../../src/modules/payments/payment.service', () => ({
  createJobCheckoutSession: vi.fn(),
}));

const quoteOnlyIntake: CanonicalIntake = {
  externalSubmissionId: 'web-quote-test',
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
    typeCode: 'fitness_equipment',
    rushRequested: false,
    rushType: 'No Rush',
    customJobDetails: 'Fitness equipment quote request',
  },
  appointment: {
    date: '2099-06-15',
    window: 'Morning(8am-12pm)',
  },
  financials: {
    paymentType: 'deposit',
  },
  media: [],
  source: {
    formName: 'web-booking',
    raw: {},
  },
};

describe('processIntake quote-only services', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps fitness_equipment in review without pricing or checkout', async () => {
    const result = await processIntake('sub-123', quoteOnlyIntake, 'corr-123', {
      sourceChannel: 'web',
    });

    expect(result.status).toBe('intake_validated');
    expect(result.checkoutRequired).toBe(false);
    expect(calculatePricing).not.toHaveBeenCalled();
    expect(createJobCheckoutSession).not.toHaveBeenCalled();
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMode: 'custom_review',
        status: 'intake_validated',
        totalAmountCents: 0,
      }),
      expect.anything(),
    );
  });
});
