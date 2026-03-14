import { query, queryOne } from '../../db/pool';

export type RushTier = 'none' | 'next_day' | 'same_day';

export interface PricingRule {
  id: string;
  service_type_code: string;
  base_price_cents: number;
  rush_price_cents: number;                   // same-day customer fee (e.g. 3000 = $30)
  next_day_rush_price_cents: number;          // next-day customer fee (e.g. 2000 = $20) — added by migration 004
  default_deposit_cents: number | null;
  payout_cents: number | null;
  contractor_rush_bonus_cents: number;        // same-day bonus (e.g. 2000 = $20) — added by migration 004
  is_active: boolean;
}

export interface PricingResult {
  serviceTypeCode: string;
  rushTier: RushTier;
  basePriceCents: number;
  rushAmountCents: number;              // customer-facing rush fee
  contractorRushBonusCents: number;    // added to contractor payout for rush
  subtotalCents: number;               // base + rushAmount (customer total)
  depositCents: number;
  remainderCents: number;
  totalCents: number;                  // = subtotalCents
  flatPayoutCents: number;             // contractor flat payout (no rush)
  payoutCents: number;                 // flatPayout + contractorRushBonus (contractor total)
  rushPlatformShareCents: number;      // rushAmount - contractorRushBonus (platform keeps this)
  stripeFeeCents: number;              // estimated Stripe fee: (total * 2.9%) + $0.30
  jobMarginCents: number;              // total - stripeFee - contractorTotalPayout
  rule: PricingRule;
}

/**
 * Calculate estimated Stripe processing fee for a given charge amount.
 * Formula: (amountCents * 0.029) + 30  (standard US card rate)
 * This is an ESTIMATE at intake time. Actual fee is confirmed after Stripe webhook.
 */
export function estimateStripeFee(amountCents: number): number {
  return Math.round(amountCents * 0.029) + 30;
}

/** Default deposit percentage if no explicit deposit is set on the rule */
const DEFAULT_DEPOSIT_PERCENTAGE = 0.5;

/**
 * Normalise a raw rush label from Jotform into a RushTier enum value.
 * Handles all known label formats:
 *   "Same-day (+30)", "same day", "same_day", "rush", "yes", "true", "1"  → same_day
 *   "Next-day (+20)", "next day", "next_day"                               → next_day
 *   "No Rush", "no", "false", "0", undefined, null                         → none
 */
export function normalizeRushTier(raw: string | boolean | undefined | null): RushTier {
  if (raw === undefined || raw === null || raw === false || raw === '') return 'none';
  if (raw === true) return 'same_day'; // legacy boolean true → same-day
  const lower = String(raw).toLowerCase().trim();
  if (lower === 'false' || lower === 'no' || lower === '0' || lower === 'no rush') return 'none';
  if (lower.includes('next')) return 'next_day';
  if (
    lower.includes('same') ||
    lower.includes('rush') ||
    lower === 'yes' ||
    lower === 'true' ||
    lower === '1'
  ) return 'same_day';
  return 'none';
}

/**
 * Human-readable label for a RushTier — matches Airtable spec exactly.
 */
export function rushTierLabel(tier: RushTier): string {
  switch (tier) {
    case 'same_day': return 'Same-day (+30)';
    case 'next_day': return 'Next-day (+20)';
    default:         return 'No Rush';
  }
}

/**
 * Calculate pricing for a job.
 * All amounts are in integer cents.
 * Pricing comes from the pricing_rules table — never hard-coded.
 *
 * @param serviceTypeCode  e.g. 'small', 'medium', 'large', 'treadmill'
 * @param rushTier         'none' | 'next_day' | 'same_day'
 */
export async function calculatePricing(
  serviceTypeCode: string,
  rushTier: RushTier | boolean,   // accepts legacy boolean for backwards compat
): Promise<PricingResult> {
  // Normalise legacy boolean callers
  const tier: RushTier =
    typeof rushTier === 'boolean'
      ? (rushTier ? 'same_day' : 'none')
      : rushTier;

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

  // Customer-facing rush fee — depends on tier
  let rushAmountCents = 0;
  if (tier === 'same_day') {
    rushAmountCents = rule.rush_price_cents;                    // e.g. 3000 ($30)
  } else if (tier === 'next_day') {
    rushAmountCents = rule.next_day_rush_price_cents ?? 2000;   // e.g. 2000 ($20)
  }

  // Contractor rush bonus — same-day = full bonus, next-day = $14 (spec)
  // same-day bonus stored in contractor_rush_bonus_cents (e.g. 2000 = $20)
  // next-day bonus = same-day bonus - $6 (per Airtable spec: 20 → 14)
  const sameDayBonus = rule.contractor_rush_bonus_cents ?? 0;
  let contractorRushBonusCents = 0;
  if (tier === 'same_day') {
    contractorRushBonusCents = sameDayBonus;
  } else if (tier === 'next_day') {
    contractorRushBonusCents = Math.max(0, sameDayBonus - 600); // $20 - $6 = $14
  }

  const subtotalCents = basePriceCents + rushAmountCents;

  // Deposit: use explicit rule value, or fall back to DEFAULT_DEPOSIT_PERCENTAGE of subtotal
  const depositCents =
    rule.default_deposit_cents !== null && rule.default_deposit_cents > 0
      ? rule.default_deposit_cents
      : Math.round(subtotalCents * DEFAULT_DEPOSIT_PERCENTAGE);

  const remainderCents = Math.max(0, subtotalCents - depositCents);
  const totalCents = subtotalCents;

  const flatPayoutCents = rule.payout_cents ?? 0;
  const payoutCents = flatPayoutCents + contractorRushBonusCents;

  // Platform keeps the difference between what customer pays for rush and what contractor gets
  const rushPlatformShareCents = Math.max(0, rushAmountCents - contractorRushBonusCents);

  // Stripe fee estimate: (totalCents * 2.9%) + $0.30
  // This is the Pay-in-Full estimate. For deposit flows, the fee is split across two charges.
  // Updated to actual after Stripe payment.succeeded webhook.
  const stripeFeeCents = estimateStripeFee(totalCents);

  // Job margin: what the platform keeps after paying Stripe and the contractor
  const jobMarginCents = Math.max(0, totalCents - stripeFeeCents - payoutCents);

  return {
    serviceTypeCode,
    rushTier: tier,
    basePriceCents,
    rushAmountCents,
    contractorRushBonusCents,
    subtotalCents,
    depositCents,
    remainderCents,
    totalCents,
    flatPayoutCents,
    payoutCents,
    rushPlatformShareCents,
    stripeFeeCents,
    jobMarginCents,
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
  nextDayRushPriceCents?: number;
  defaultDepositCents?: number;
  payoutCents?: number;
  contractorRushBonusCents?: number;
}): Promise<PricingRule> {
  // Deactivate existing rules for this service type
  await query(
    `UPDATE pricing_rules SET is_active = FALSE WHERE service_type_code = $1`,
    [params.serviceTypeCode],
  );

  const rows = await query<PricingRule>(
    `INSERT INTO pricing_rules
      (service_type_code, base_price_cents, rush_price_cents, next_day_rush_price_cents,
       default_deposit_cents, payout_cents, contractor_rush_bonus_cents, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
     RETURNING *`,
    [
      params.serviceTypeCode,
      params.basePriceCents,
      params.rushPriceCents,
      params.nextDayRushPriceCents ?? 2000,
      params.defaultDepositCents ?? null,
      params.payoutCents ?? null,
      params.contractorRushBonusCents ?? 2000,
    ],
  );
  return rows[0];
}
