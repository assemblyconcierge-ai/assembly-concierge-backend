import { query, queryOne } from '../../db/pool';

export interface PricingRule {
  id: string;
  service_type_code: string;
  base_price_cents: number;
  rush_price_cents: number;
  default_deposit_cents: number | null;
  payout_cents: number | null;
  is_active: boolean;
}

export interface PricingResult {
  serviceTypeCode: string;
  basePriceCents: number;
  rushAmountCents: number;
  subtotalCents: number;
  depositCents: number;
  remainderCents: number;
  totalCents: number;
  payoutCents: number;
  rule: PricingRule;
}

/** Default deposit percentage if no explicit deposit is set on the rule */
const DEFAULT_DEPOSIT_PERCENTAGE = 0.5;

/**
 * Calculate pricing for a job.
 * All amounts are in integer cents.
 * Pricing comes from the pricing_rules table — never hard-coded.
 */
export async function calculatePricing(
  serviceTypeCode: string,
  rushRequested: boolean,
): Promise<PricingResult> {
  const rule = await queryOne<PricingRule>(
    `SELECT * FROM pricing_rules
     WHERE service_type_code = $1
       AND is_active = TRUE
       AND (active_to IS NULL OR active_to > NOW())
     ORDER BY active_from DESC
     LIMIT 1`,
    [serviceTypeCode],
  );

  if (!rule) {
    throw new Error(`No active pricing rule found for service type: ${serviceTypeCode}`);
  }

  const basePriceCents = rule.base_price_cents;
  const rushAmountCents = rushRequested ? rule.rush_price_cents : 0;
  const subtotalCents = basePriceCents + rushAmountCents;

  // Deposit: use explicit rule value, or fall back to DEFAULT_DEPOSIT_PERCENTAGE of subtotal
  const depositCents =
    rule.default_deposit_cents !== null && rule.default_deposit_cents > 0
      ? rule.default_deposit_cents
      : Math.round(subtotalCents * DEFAULT_DEPOSIT_PERCENTAGE);

  const remainderCents = Math.max(0, subtotalCents - depositCents);
  const totalCents = subtotalCents;
  const payoutCents = rule.payout_cents ?? 0;

  return {
    serviceTypeCode,
    basePriceCents,
    rushAmountCents,
    subtotalCents,
    depositCents,
    remainderCents,
    totalCents,
    payoutCents,
    rule,
  };
}

/** Get all active pricing rules (for admin config endpoint) */
export async function getAllPricingRules(): Promise<PricingRule[]> {
  return query<PricingRule>(
    `SELECT * FROM pricing_rules WHERE is_active = TRUE ORDER BY service_type_code`,
  );
}

/** Upsert a pricing rule (admin config) */
export async function upsertPricingRule(params: {
  serviceTypeCode: string;
  basePriceCents: number;
  rushPriceCents: number;
  defaultDepositCents?: number;
  payoutCents?: number;
}): Promise<PricingRule> {
  // Deactivate existing rules for this service type
  await query(
    `UPDATE pricing_rules SET is_active = FALSE WHERE service_type_code = $1`,
    [params.serviceTypeCode],
  );

  const rows = await query<PricingRule>(
    `INSERT INTO pricing_rules
      (service_type_code, base_price_cents, rush_price_cents, default_deposit_cents, payout_cents, is_active)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     RETURNING *`,
    [
      params.serviceTypeCode,
      params.basePriceCents,
      params.rushPriceCents,
      params.defaultDepositCents ?? null,
      params.payoutCents ?? null,
    ],
  );
  return rows[0];
}
