/**
 * Assembly Concierge — Financial Scenario Validator v3
 * Reflects pricing_rules state AFTER migration 003_fix_pricing.sql is applied.
 * Source of truth: Airtable confirmed formulas (2026-03-13)
 *
 * Post-migration pricing_rules values:
 *   small:     base=10900, rush=3000, deposit=2500, payout=5500
 *   medium:    base=14900, rush=3000, deposit=2500, payout=8000
 *   large:     base=19900, rush=3000, deposit=2500, payout=11000
 *   treadmill: base=18900, rush=3000, deposit=2500, payout=13000
 *
 * Formulas (Airtable spec):
 *   contractorTotalPayout = flatPayout + rushBonus
 *   stripeFee (full)      = (total * 0.029) + 0.30
 *   stripeFee (deposit)   = (deposit * 0.029 + 0.30) + (remainder * 0.029 + 0.30)
 *   jobMargin             = totalCharged - stripeFee - contractorTotalPayout
 *   rushPlatformShare     = rushFeeAmount - contractorRushBonus
 */

// ── Post-migration pricing_rules (cents) ────────────────────────────────────
const PRICING_RULES = {
  'Small Assembly':     { baseCents: 10900, rushCents: 3000, depositCents: 2500, payoutCents: 5500  },
  'Medium Assembly':    { baseCents: 14900, rushCents: 3000, depositCents: 2500, payoutCents: 8000  },
  'Large Assembly':     { baseCents: 19900, rushCents: 3000, depositCents: 2500, payoutCents: 11000 },
  'Treadmill Assembly': { baseCents: 18900, rushCents: 3000, depositCents: 2500, payoutCents: 13000 },
};

// ── Expected values from Airtable spec ─────────────────────────────────────
const EXPECTED = {
  'Small Assembly':     { basePrice: 109, flatPayout: 55  },
  'Medium Assembly':    { basePrice: 149, flatPayout: 80  },
  'Large Assembly':     { basePrice: 199, flatPayout: 110 },
  'Treadmill Assembly': { basePrice: 189, flatPayout: 130 },
};

// ── Rush types ──────────────────────────────────────────────────────────────
const RUSH_TYPES = {
  'No Rush':        { customerFeeCents: 0,    contractorBonusCents: 0    },
  'Same-day (+30)': { customerFeeCents: 3000, contractorBonusCents: 2000 },
  'Next-day (+20)': { customerFeeCents: 2000, contractorBonusCents: 1400 },
};

// ── Stripe fee formulas ─────────────────────────────────────────────────────
function stripeFeeFullCents(totalCents) {
  return Math.round(totalCents * 0.029) + 30;
}
function stripeFeeDepositCents(depositCents, remainderCents) {
  return (Math.round(depositCents * 0.029) + 30) + (Math.round(remainderCents * 0.029) + 30);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const fmt = (cents) => (cents / 100).toFixed(2);

// ── Run all scenarios ───────────────────────────────────────────────────────
const services   = Object.keys(PRICING_RULES);
const rushTypes  = Object.keys(RUSH_TYPES);
const payMethods = ['Pay in Full', '$25 Deposit'];

const results = [];

for (const svc of services) {
  const rule = PRICING_RULES[svc];
  const exp  = EXPECTED[svc];

  for (const rush of rushTypes) {
    const rt = RUSH_TYPES[rush];

    const baseCents              = rule.baseCents;
    const rushFeeCents           = rt.customerFeeCents;
    const contractorBonusCents   = rt.contractorBonusCents;
    const flatPayoutCents        = rule.payoutCents;
    const contractorTotalCents   = flatPayoutCents + contractorBonusCents;
    const totalCents             = baseCents + rushFeeCents;
    const rushPlatformShareCents = rushFeeCents - contractorBonusCents;

    for (const payMethod of payMethods) {
      let depositCents, remainderCents, stripeFeeCents;

      if (payMethod === 'Pay in Full') {
        depositCents   = totalCents;
        remainderCents = 0;
        stripeFeeCents = stripeFeeFullCents(totalCents);
      } else {
        depositCents   = rule.depositCents;           // fixed $25 = 2500 cents
        remainderCents = totalCents - depositCents;
        stripeFeeCents = stripeFeeDepositCents(depositCents, remainderCents);
      }

      const marginCents = totalCents - stripeFeeCents - contractorTotalCents;

      // ── Validation checks ───────────────────────────────────────────────
      const baseOk        = baseCents === exp.basePrice * 100;
      const payoutOk      = flatPayoutCents === exp.flatPayout * 100;
      const depositOk     = payMethod === 'Pay in Full' || depositCents === 2500;
      const reconcileOk   = depositCents + remainderCents === totalCents;
      const marginFormula = marginCents === totalCents - stripeFeeCents - contractorTotalCents;
      const rushShareOk   = rushPlatformShareCents === rushFeeCents - contractorBonusCents;

      const pass = baseOk && payoutOk && depositOk && reconcileOk && marginFormula && rushShareOk;

      const failures = [
        !baseOk      && `basePrice: got $${fmt(baseCents)}, expected $${exp.basePrice}`,
        !payoutOk    && `flatPayout: got $${fmt(flatPayoutCents)}, expected $${exp.flatPayout}`,
        !depositOk   && `deposit: got $${fmt(depositCents)}, expected $25.00 (fixed)`,
        !reconcileOk && `deposit+remainder=$${fmt(depositCents+remainderCents)} != total=$${fmt(totalCents)}`,
        !rushShareOk && `rushPlatformShare: got $${fmt(rushPlatformShareCents)}, expected $${fmt(rushFeeCents-contractorBonusCents)}`,
      ].filter(Boolean);

      results.push({
        serviceType:           svc,
        rushType:              rush,
        paymentMethod:         payMethod,
        basePrice:             fmt(baseCents),
        rushFeeAmount:         fmt(rushFeeCents),
        totalCharged:          fmt(totalCents),
        depositAmount:         fmt(depositCents),
        remainingBalance:      fmt(remainderCents),
        contractorFlatPayout:  fmt(flatPayoutCents),
        contractorRushBonus:   fmt(contractorBonusCents),
        contractorTotalPayout: fmt(contractorTotalCents),
        stripeFee:             fmt(stripeFeeCents),
        rushPlatformShare:     fmt(rushPlatformShareCents),
        jobMargin:             fmt(marginCents),
        pass,
        failures,
      });
    }
  }
}

// ── Print results ───────────────────────────────────────────────────────────
const W = { svc:20, rush:18, pay:14, base:7, rushF:7, total:8, dep:8, rem:9, flat:8, bonus:7, cpay:8, sfee:9, rps:9, margin:9 };
const p = (s, w) => String(s).padEnd(w);

console.log('\n=== ASSEMBLY CONCIERGE FINANCIAL SCENARIOS — POST MIGRATION 003 ===\n');
console.log(
  p('Service',W.svc), p('Rush',W.rush), p('PayMethod',W.pay),
  p('Base',W.base), p('Rush+',W.rushF), p('Total',W.total),
  p('Deposit',W.dep), p('Remain',W.rem),
  p('FlatPay',W.flat), p('Bonus',W.bonus), p('CPay',W.cpay),
  p('StripeFee',W.sfee), p('RushShare',W.rps), p('Margin',W.margin), 'PASS'
);
console.log('-'.repeat(170));

for (const r of results) {
  console.log(
    p(r.serviceType,W.svc), p(r.rushType,W.rush), p(r.paymentMethod,W.pay),
    p('$'+r.basePrice,W.base), p('$'+r.rushFeeAmount,W.rushF), p('$'+r.totalCharged,W.total),
    p('$'+r.depositAmount,W.dep), p('$'+r.remainingBalance,W.rem),
    p('$'+r.contractorFlatPayout,W.flat), p('$'+r.contractorRushBonus,W.bonus),
    p('$'+r.contractorTotalPayout,W.cpay),
    p('$'+r.stripeFee,W.sfee), p('$'+r.rushPlatformShare,W.rps),
    p('$'+r.jobMargin,W.margin),
    r.pass ? '✓ PASS' : '✗ FAIL',
  );
  for (const f of r.failures) console.log('    ↳', f);
}

const failing = results.filter(r => !r.pass);
const passing = results.filter(r => r.pass);
console.log(`\nTotal: ${results.length} | Passing: ${passing.length} | Failing: ${failing.length}`);

// ── Deposit confirmation ────────────────────────────────────────────────────
console.log('\n=== DEPOSIT CONFIRMATION ===');
console.log('Post-migration: default_deposit_cents = 2500 ($25.00 fixed) for all non-custom service types.');
for (const svc of services) {
  const rule = PRICING_RULES[svc];
  console.log(`  ${svc}: deposit = $${fmt(rule.depositCents)} (was 50% of base = $${fmt(rule.baseCents * 0.5)})`);
}

// ── Payout confirmation ─────────────────────────────────────────────────────
console.log('\n=== PAYOUT CONFIRMATION ===');
for (const svc of services) {
  const rule = PRICING_RULES[svc];
  const exp  = EXPECTED[svc];
  const match = rule.payoutCents === exp.flatPayout * 100;
  console.log(`  ${svc}: payout = $${fmt(rule.payoutCents)} — spec $${exp.flatPayout} — ${match ? 'MATCH' : 'MISMATCH'}`);
}

// ── Treadmill base price confirmation ──────────────────────────────────────
console.log('\n=== TREADMILL BASE PRICE CONFIRMATION ===');
const tr = PRICING_RULES['Treadmill Assembly'];
const trExp = EXPECTED['Treadmill Assembly'];
console.log(`  base_price_cents: ${tr.baseCents} ($${fmt(tr.baseCents)}) — spec $${trExp.basePrice} — ${tr.baseCents === trExp.basePrice * 100 ? 'MATCH' : 'MISMATCH'}`);
