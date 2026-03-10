import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculatePricing } from '../../src/modules/pricing/pricing.service';

vi.mock('../../src/db/pool', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

import { queryOne } from '../../src/db/pool';

const mockQueryOne = vi.mocked(queryOne);

const makeRule = (overrides = {}) => ({
  id: 'rule-1',
  service_type_code: 'small',
  base_price_cents: 10900,
  rush_price_cents: 3000,
  default_deposit_cents: 5450,
  payout_cents: 6000,
  is_active: true,
  ...overrides,
});

describe('Pricing engine', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calculates full price for Small Assembly without rush', async () => {
    mockQueryOne.mockResolvedValueOnce(makeRule());
    const result = await calculatePricing('small', false);

    expect(result.basePriceCents).toBe(10900);
    expect(result.rushAmountCents).toBe(0);
    expect(result.subtotalCents).toBe(10900);
    expect(result.totalCents).toBe(10900);
    expect(result.depositCents).toBe(5450);
    expect(result.remainderCents).toBe(5450);
  });

  it('adds rush fee when rush is requested', async () => {
    mockQueryOne.mockResolvedValueOnce(makeRule());
    const result = await calculatePricing('small', true);

    expect(result.rushAmountCents).toBe(3000);
    expect(result.subtotalCents).toBe(13900);
    expect(result.totalCents).toBe(13900);
  });

  it('calculates deposit correctly from explicit rule value', async () => {
    mockQueryOne.mockResolvedValueOnce(makeRule({ default_deposit_cents: 5000 }));
    const result = await calculatePricing('small', false);
    expect(result.depositCents).toBe(5000);
    expect(result.remainderCents).toBe(5900);
  });

  it('falls back to 50% deposit when no explicit deposit set', async () => {
    mockQueryOne.mockResolvedValueOnce(makeRule({ default_deposit_cents: null }));
    const result = await calculatePricing('small', false);
    expect(result.depositCents).toBe(5450); // 50% of 10900
    expect(result.remainderCents).toBe(5450);
  });

  it('throws when no pricing rule found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(calculatePricing('unknown_type', false)).rejects.toThrow(
      'No active pricing rule found',
    );
  });

  it('calculates medium pricing correctly', async () => {
    mockQueryOne.mockResolvedValueOnce(
      makeRule({ service_type_code: 'medium', base_price_cents: 14900, default_deposit_cents: 7450 }),
    );
    const result = await calculatePricing('medium', false);
    expect(result.basePriceCents).toBe(14900);
    expect(result.depositCents).toBe(7450);
    expect(result.remainderCents).toBe(7450);
  });
});
