/**
 * Pricing scenario validator — mirrors exact backend logic from:
 *   src/modules/pricing/pricing.service.ts
 *   src/db/embeddedMigrations.ts (002_seed_data.sql)
 *
 * No DB connection required — uses seeded values directly.
 * Stripe fee formula: (amount * 0.029) + 30 cents (standard Stripe US rate).
 * profitMargin = totalCharged - stripeFee - contractorPayout
 */

// ── Seeded pricing_rules (from 002_seed_data.sql) ──────────────────────────
const PRICING_RULES = {
  small:     { basePriceCents: 10900, rushPriceCents: 3000, defaultDepositCents: 5450,  payoutCents: 6000  },
  medium:    { basePriceCents: 14900, rushPriceCents: 3000, defaultDepositCents: 7450,  payoutCents: 8000  },
  large:     { basePriceCents: 19900, rushPriceCents: 3000, defaultDepositCents: 9950,  payoutCents: 11000 },
  treadmill: { basePriceCents: 14900, rushPriceCents: 3000, defaultDepositCents: 7450,  payoutCents: 8000  },
};

// ── Expected values from user spec ─────────────────────────────────────────
const EXPECTED = {
  small:     { basePrice: 109, contractorPayout: 55 },
  medium:    { basePrice: 149, contractorPayout: 80 },
  large:     { basePrice: 199, contractorPayout: 110 },
  treadmill: { basePrice: 189, contractorPayout: 130 },
};

// ── Stripe fee formula (standard US rate) ──────────────────────────────────
function stripeFee(amountCents) {
  return Math.round(amountCents * 0.029) + 30;
}

// ── Core pricing calculation (mirrors pricing.service.ts calculatePricing) ─
function calculatePricing(serviceTypeCode, rushRequested) {
  const rule = PRICING_RULES[serviceTypeCode];
  if (!rule) throw new Error(`No rule for: ${serviceTypeCode}`);

  const basePriceCents   = rule.basePriceCents;
  const rushAmountCents  = rushRequested ? rule.rushPriceCents : 0;
  const subtotalCents    = basePriceCents + rushAmountCents;
  const depositCents     = rule.defaultDepositCents > 0
    ? rule.defaultDepositCents
    : Math.round(subtotalCents * 0.5);
  const remainderCents   = Math.max(0, subtotalCents - depositCents);
  const totalCents       = subtotalCents;
  const payoutCents      = rule.payoutCents;

  return { basePriceCents, rushAmountCents, subtotalCents, depositCents, remainderCents, totalCents, payoutCents };
}

// ── Run all scenarios ───────────────────────────────────────────────────────
const services    = ['small', 'medium', 'large', 'treadmill'];
const rushOptions = [false, true];
const payTypes    = ['full', 'deposit', 'remainder'];

const results = [];

for (const svc of services) {
  for (const rush of rushOptions) {
    const p = calculatePricing(svc, rush);
    const exp = EXPECTED[svc];

    for (const payType of payTypes) {
      let chargedCents;
      if (payType === 'full')      chargedCents = p.totalCents;
      else if (payType === 'deposit')   chargedCents = p.depositCents;
      else /* remainder */         chargedCents = p.remainderCents;

      const fee        = stripeFee(chargedCents);
      const profit     = chargedCents - fee - p.payoutCents;

      // ── Validation checks ───────────────────────────────────────────────
      const baseOk       = p.basePriceCents === exp.basePrice * 100;
      const rushOk       = rush ? p.rushAmountCents === 3000 : p.rushAmountCents === 0;
      const payoutOk     = p.payoutCents === exp.contractorPayout * 100;
      const depositOk    = p.depositCents === Math.round(p.basePriceCents * 0.5); // 50% of BASE (not subtotal)
      const remainderOk  = p.depositCents + p.remainderCents === p.totalCents;
      const profitCheck  = profit === chargedCents - fee - p.payoutCents; // always true by definition

      // Deposit reconciliation: deposit + remainder must equal total
      const reconcileOk  = p.depositCents + p.remainderCents === p.totalCents;

      const pass = baseOk && rushOk && payoutOk && reconcileOk;

      results.push({
        service:           svc,
        rush:              rush,
        paymentType:       payType,
        basePrice:         (p.basePriceCents / 100).toFixed(2),
        rushFee:           (p.rushAmountCents / 100).toFixed(2),
        totalCharged:      (chargedCents / 100).toFixed(2),
        depositAmount:     (p.depositCents / 100).toFixed(2),
        remainingBalance:  (p.remainderCents / 100).toFixed(2),
        contractorPayout:  (p.payoutCents / 100).toFixed(2),
        stripeFee:         (fee / 100).toFixed(2),
        profitMargin:      (profit / 100).toFixed(2),
        // Checks
        baseOk,
        rushOk,
        payoutOk,
        reconcileOk,
        pass,
        // Failure reasons
        failures: [
          !baseOk    && `basePrice: got ${p.basePriceCents/100}, expected ${exp.basePrice}`,
          !rushOk    && `rushFee: got ${p.rushAmountCents/100}, expected ${rush ? 30 : 0}`,
          !payoutOk  && `contractorPayout: got ${p.payoutCents/100}, expected ${exp.contractorPayout}`,
          !reconcileOk && `deposit+remainder=${p.depositCents+p.remainderCents} ≠ total=${p.totalCents}`,
        ].filter(Boolean),
      });
    }
  }
}

// ── Print compact results table ─────────────────────────────────────────────
console.log('\n=== PRICING SCENARIO RESULTS ===\n');
console.log(
  'Service'.padEnd(10),
  'Rush'.padEnd(6),
  'PayType'.padEnd(10),
  'Base'.padEnd(7),
  'Rush+'.padEnd(7),
  'Charged'.padEnd(9),
  'Deposit'.padEnd(9),
  'Remain'.padEnd(8),
  'Payout'.padEnd(8),
  'StripeFee'.padEnd(10),
  'Profit'.padEnd(8),
  'PASS',
);
console.log('-'.repeat(110));

for (const r of results) {
  console.log(
    r.service.padEnd(10),
    String(r.rush).padEnd(6),
    r.paymentType.padEnd(10),
    `$${r.basePrice}`.padEnd(7),
    `$${r.rushFee}`.padEnd(7),
    `$${r.totalCharged}`.padEnd(9),
    `$${r.depositAmount}`.padEnd(9),
    `$${r.remainingBalance}`.padEnd(8),
    `$${r.contractorPayout}`.padEnd(8),
    `$${r.stripeFee}`.padEnd(10),
    `$${r.profitMargin}`.padEnd(8),
    r.pass ? '✓ PASS' : '✗ FAIL',
  );
  if (r.failures.length > 0) {
    for (const f of r.failures) console.log('    ↳ FAIL:', f);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
const failing = results.filter(r => !r.pass);
const passing = results.filter(r => r.pass);
console.log('\n=== SUMMARY ===');
console.log(`Total scenarios: ${results.length}`);
console.log(`Passing: ${passing.length}`);
console.log(`Failing: ${failing.length}`);

if (failing.length > 0) {
  console.log('\n=== FAILING SCENARIOS ===');
  for (const r of failing) {
    console.log(`  ${r.service} / rush=${r.rush} / ${r.paymentType}: ${r.failures.join('; ')}`);
  }
}

// ── Deposit logic note ───────────────────────────────────────────────────────
console.log('\n=== DEPOSIT LOGIC NOTE ===');
console.log('Backend deposit rule: uses pricing_rules.default_deposit_cents (fixed value from seed).');
console.log('Seed sets deposit = 50% of BASE price (not subtotal including rush).');
console.log('This means rush orders have a deposit < 50% of total charged.');
console.log('');
console.log('Example — Small + Rush:');
const ex = calculatePricing('small', true);
console.log(`  base=$${ex.basePriceCents/100}, rush=$${ex.rushAmountCents/100}, total=$${ex.totalCents/100}`);
console.log(`  deposit=$${ex.depositCents/100} (50% of base $${ex.basePriceCents/100})`);
console.log(`  remainder=$${ex.remainderCents/100}`);
console.log(`  deposit+remainder=$${(ex.depositCents+ex.remainderCents)/100} vs total=$${ex.totalCents/100}`);
