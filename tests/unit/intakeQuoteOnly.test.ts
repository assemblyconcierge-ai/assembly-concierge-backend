import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processIntake } from '../../src/modules/intake/intake.service';
import { calculatePricing } from '../../src/modules/pricing/pricing.service';
import { createJob } from '../../src/modules/jobs/job.repository';
import { createJobCheckoutSession } from '../../src/modules/payments/payment.service';
import { CanonicalIntake } from '../../src/modules/intake/intake.types';
import { query } from '../../src/db/pool';
import { classifyServiceArea } from '../../src/modules/service-areas/serviceArea.service';

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
    vi.mocked(query).mockResolvedValue([{ id: 'service-type-123' }] as any);
    vi.mocked(classifyServiceArea).mockResolvedValue({ status: 'in_area', city: 'Hampton', state: 'GA' });
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
        serviceTypeId: 'service-type-123',
        totalAmountCents: 0,
      }),
      expect.anything(),
    );
  });

  it('keeps custom jobs in review without pricing or checkout', async () => {
    const customIntake: CanonicalIntake = {
      ...quoteOnlyIntake,
      service: {
        ...quoteOnlyIntake.service,
        typeCode: 'custom',
        customJobDetails: 'Custom assembly request',
      },
    };

    const result = await processIntake('sub-123', customIntake, 'corr-123', {
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
        serviceTypeId: 'service-type-123',
        totalAmountCents: 0,
      }),
      expect.anything(),
    );
  });

  it('forceReviewOnly keeps a standard service in custom review without pricing or checkout', async () => {
    const standardReviewIntake: CanonicalIntake = {
      ...quoteOnlyIntake,
      service: {
        ...quoteOnlyIntake.service,
        typeCode: 'small',
        customJobDetails: 'Full slot review request',
      },
    };

    const result = await processIntake('sub-123', standardReviewIntake, 'corr-123', {
      sourceChannel: 'web',
      forceReviewOnly: true,
    });

    expect(result.status).toBe('intake_validated');
    expect(result.checkoutRequired).toBe(false);
    expect(calculatePricing).not.toHaveBeenCalled();
    expect(createJobCheckoutSession).not.toHaveBeenCalled();
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMode: 'custom_review',
        status: 'intake_validated',
        serviceTypeId: 'service-type-123',
        subtotalAmountCents: 0,
        depositAmountCents: 0,
        remainderAmountCents: 0,
        totalAmountCents: 0,
      }),
      expect.anything(),
    );
  });

  it('forceReviewOnly preserves quote-only status behavior for outside-area review requests', async () => {
    vi.mocked(classifyServiceArea).mockResolvedValueOnce({
      status: 'quote_only',
      city: 'Atlanta',
      state: 'GA',
    });

    const outsideAreaReviewIntake: CanonicalIntake = {
      ...quoteOnlyIntake,
      address: {
        ...quoteOnlyIntake.address,
        city: 'Atlanta',
      },
      service: {
        ...quoteOnlyIntake.service,
        typeCode: 'small',
        customJobDetails: 'Outside area review request',
      },
    };

    const result = await processIntake('sub-123', outsideAreaReviewIntake, 'corr-123', {
      sourceChannel: 'web',
      forceReviewOnly: true,
    });

    expect(result.status).toBe('quoted_outside_area');
    expect(result.checkoutRequired).toBe(false);
    expect(calculatePricing).not.toHaveBeenCalled();
    expect(createJobCheckoutSession).not.toHaveBeenCalled();
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMode: 'custom_review',
        status: 'quoted_outside_area',
        serviceTypeId: 'service-type-123',
        totalAmountCents: 0,
      }),
      expect.anything(),
    );
  });
});
