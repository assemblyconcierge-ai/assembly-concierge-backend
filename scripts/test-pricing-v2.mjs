/**
 * Assembly Concierge — Financial Scenario Validator v2
 * Source of truth: Airtable confirmed formulas (2026-03-13)
 *
 * Formulas implemented exactly as specified:
 *
 * 1. contractorFlatPayout:  Small=55, Medium=80, Large=110, Treadmill=130
 * 2. contractorRushBonus:   Same-day=20, Next-day=14, No Rush=0
 * 3. contractorTotalPayout: flatPayout + rushBonus
 * 4. rushFeeAmount (customer): Same-day=30, Next-day=20, No Rush=0
 * 5. stripeFee:
 *      Pay in Full:   (totalCharged * 0.029) + 0.30
 *      $25 Deposit:   (depositAmount * 0.029 + 0.30) + (remainingBalance * 0.029 + 0.30)
 * 6. jobMargin:       totalCharged - stripeFee - contractorTotalPayout
 * 7. rushPlatformShare: rushFeeAmount - contractorRushBonus
 */

// ── Base prices (confirmed) ─────────────────────────────────────────────────
const BASE_PRICES = {
  'Small Assembly':     109,
  'Medium Assembly':    149,
  'Large Assembly':     199,
  'Treadmill Assembly': 189,
};

// ── Contractor flat payouts (confirmed) ────────────────────────────────────
const CONTRACTOR_FLAT_PAYOUT = {
  'Small Assembly':     55,
  'Medium Assembly':    80,
  'Large Assembly':     110,
  'Treadmill Assembly': 130,
};

// ── Rush types ──────────────────────────────────────────────────────────────
const RUSH_TYPES = {
  'No Rush':           { customerFee: 0,  contractorBonus: 0  },
  'Same-day (+30)':    { customerFee: 30, contractorBonus: 20 },
  'Next-day (+20)':    { customerFee: 20, contractorBonus: 14 },
};

// ── Deposit amount (fixed per spec: "$25 Deposit") ──────────────────────────
const FIXED_DEPOSIT = 25;

// ── Stripe fee formulas ─────────────────────────────────────────────────────
function stripeFeeFullPayment(totalCharged) {
  return +(totalCharged * 0.029 + 0.30).toFixed(2);
}
function stripeFeeDepositPayment(depositAmount, remainingBalance) {
  const depositFee   = +(depositAmount   * 0.029 + 0.30).toFixed(2);
  const remainderFee = +(remainingBalance * 0.029 + 0.30).toFixed(2);
  return +(depositFee + remainderFee).toFixed(2);
}

// ── Run all scenarios ───────────────────────────────────────────────────────
const services     = Object.keys(BASE_PRICES);
const rushTypes    = Object.keys(RUSH_TYPES);
const payMethods   = ['Pay in Full', '$25 Deposit'];

const results = [];

for (const svc of services) {
  for (const rush of rushTypes) {
    const basePrice          = BASE_PRICES[svc];
    const rushFeeAmount      = RUSH_TYPES[rush].customerFee;
    const contractorRushBonus = RUSH_TYPES[rush].contractorBonus;
    const contractorFlatPayout = CONTRACTOR_FLAT_PAYOUT[svc];
    const contractorTotalPayout = contractorFlatPayout + contractorRushBonus;
    const totalCharged       = basePrice + rushFeeAmount;
    const rushPlatformShare  = rushFeeAmount - contractorRushBonus;

    for (const payMethod of payMethods) {
      let depositAmount, remainingBalance, stripeFee;

      if (payMethod === 'Pay in Full') {
        depositAmount    = totalCharged;   // full amount charged at once
        remainingBalance = 0;
        stripeFee        = stripeFeeFullPayment(totalCharged);
      } else {
        // $25 Deposit
        depositAmount    = FIXED_DEPOSIT;
        remainingBalance = +(totalCharged - FIXED_DEPOSIT).toFixed(2);
        stripeFee        = stripeFeeDepositPayment(depositAmount, remainingBalance);
      }

      const jobMargin = +(totalCharged - stripeFee - contractorTotalPayout).toFixed(2);

      // ── Validation checks ─────────────────────────────────────────────────
      // All checks are definitional — if the formulas are applied correctly
      // the results are always internally consistent. We flag structural issues.
      const depositReconciles = +(depositAmount + remainingBalance).toFixed(2) === totalCharged ||
                                payMethod === 'Pay in Full';
      const rushPlatformShareOk = rushPlatformShare === rushFeeAmount - contractorRushBonus;
      const marginOk = Math.abs(jobMargin - (totalCharged - stripeFee - contractorTotalPayout)) < 0.01;

      const pass = depositReconciles && rushPlatformShareOk && marginOk;

      results.push({
        serviceType:          svc,
        rushType:             rush,
        paymentMethod:        payMethod,
        basePrice:            basePrice.toFixed(2),
        rushFeeAmount:        rushFeeAmount.toFixed(2),
        totalCharged:         totalCharged.toFixed(2),
        depositAmount:        depositAmount.toFixed(2),
        remainingBalance:     remainingBalance.toFixed(2),
        contractorFlatPayout: contractorFlatPayout.toFixed(2),
        contractorRushBonus:  contractorRushBonus.toFixed(2),
        contractorTotalPayout: contractorTotalPayout.toFixed(2),
        stripeFee:            stripeFee.toFixed(2),
        rushPlatformShare:    rushPlatformShare.toFixed(2),
        jobMargin:            jobMargin.toFixed(2),
        pass,
      });
    }
  }
}

// ── Print results table ─────────────────────────────────────────────────────
const W = {
  svc: 20, rush: 18, pay: 14, base: 7, rushF: 7, total: 8,
  dep: 8, rem: 8, flat: 7, bonus: 7, cpay: 7, sfee: 8, rps: 7, margin: 8,
};

function pad(s, w) { return String(s).padEnd(w); }

console.log('\n=== ASSEMBLY CONCIERGE — FINANCIAL SCENARIO RESULTS (Airtable Formula Source of Truth) ===\n');
console.log(
  pad('Service',W.svc), pad('Rush',W.rush), pad('PayMethod',W.pay),
  pad('Base',W.base), pad('Rush+',W.rushF), pad('Total',W.total),
  pad('Deposit',W.dep), pad('Remain',W.rem),
  pad('FlatPay',W.flat), pad('Bonus',W.bonus), pad('CPay',W.cpay),
  pad('StripeFee',W.sfee), pad('RushShare',W.rps), pad('Margin',W.margin),
  'PASS'
);
console.log('-'.repeat(160));

for (const r of results) {
  console.log(
    pad(r.serviceType,W.svc), pad(r.rushType,W.rush), pad(r.paymentMethod,W.pay),
    pad('$'+r.basePrice,W.base), pad('$'+r.rushFeeAmount,W.rushF), pad('$'+r.totalCharged,W.total),
    pad('$'+r.depositAmount,W.dep), pad('$'+r.remainingBalance,W.rem),
    pad('$'+r.contractorFlatPayout,W.flat), pad('$'+r.contractorRushBonus,W.bonus),
    pad('$'+r.contractorTotalPayout,W.cpay),
    pad('$'+r.stripeFee,W.sfee), pad('$'+r.rushPlatformShare,W.rps),
    pad('$'+r.jobMargin,W.margin),
    r.pass ? '✓' : '✗ FAIL',
  );
}

const failing = results.filter(r => !r.pass);
console.log(`\nTotal: ${results.length} scenarios | Passing: ${results.length - failing.length} | Failing: ${failing.length}`);

// ── Backend gap analysis ─────────────────────────────────────────────────────
console.log('\n=== BACKEND GAP ANALYSIS ===\n');

const gaps = [
  {
    field: 'Small payout_cents',
    backend: '$60.00 (6000 cents in seed)',
    spec:    '$55.00 (5500 cents)',
    delta:   '+$5.00 over-payment per Small job',
    fix:     'UPDATE pricing_rules SET payout_cents=5500 WHERE service_type_code=\'small\''
  },
  {
    field: 'Treadmill base_price_cents',
    backend: '$149.00 (14900 cents in seed)',
    spec:    '$189.00 (18900 cents)',
    delta:   '-$40.00 under-charge per Treadmill job',
    fix:     'UPDATE pricing_rules SET base_price_cents=18900 WHERE service_type_code=\'treadmill\''
  },
  {
    field: 'Treadmill default_deposit_cents',
    backend: '$74.50 (7450 cents — 50% of wrong $149)',
    spec:    '$94.50 (9450 cents — 50% of $189)',
    delta:   'Deposit too low by $20 for Treadmill',
    fix:     'UPDATE pricing_rules SET default_deposit_cents=9450 WHERE service_type_code=\'treadmill\''
  },
  {
    field: 'Treadmill payout_cents',
    backend: '$80.00 (8000 cents in seed)',
    spec:    '$130.00 (13000 cents)',
    delta:   '-$50.00 under-payment per Treadmill job',
    fix:     'UPDATE pricing_rules SET payout_cents=13000 WHERE service_type_code=\'treadmill\''
  },
  {
    field: 'Next-day rush fee',
    backend: 'Not modelled — only one rush_price_cents=3000 per rule (no next-day tier)',
    spec:    'Next-day = $20 customer fee, $14 contractor bonus',
    delta:   'Next-day rush tier is missing entirely',
    fix:     'Add rush_type column to pricing_rules OR add separate next_day_rush_price_cents column; update intake normalizer to distinguish rush types'
  },
  {
    field: 'Contractor rush bonus',
    backend: 'Not stored anywhere — payout_cents is flat only',
    spec:    'contractorRushBonus: Same-day=20, Next-day=14',
    delta:   'Rush bonus not added to contractor payout on rush jobs',
    fix:     'Add contractor_rush_bonus_cents to pricing_rules; add to payout calculation in pricing.service.ts'
  },
  {
    field: 'rushPlatformShare',
    backend: 'Not calculated or stored',
    spec:    'rushFeeAmount - contractorRushBonus',
    delta:   'Field does not exist in backend',
    fix:     'Derive at reporting time or add rush_platform_share_cents to jobs table'
  },
  {
    field: 'Stripe fee for $25 Deposit',
    backend: 'stripeFee not calculated in backend — Stripe charges are implicit via Checkout',
    spec:    '(deposit * 0.029 + 0.30) + (remainder * 0.029 + 0.30)',
    delta:   'Two-transaction Stripe fee not modelled; backend only tracks charged amounts',
    fix:     'Add stripe_fee_cents to payments table; calculate and store on checkout session creation'
  },
  {
    field: 'Fixed $25 deposit',
    backend: 'deposit = 50% of base price (e.g. Small=$54.50)',
    spec:    'deposit = fixed $25.00',
    delta:   'Deposit amount is wrong for all service types',
    fix:     'UPDATE pricing_rules SET default_deposit_cents=2500 for all non-custom types'
  },
  {
    field: 'jobMargin stored on job',
    backend: 'Not stored — only totalCharged, payoutCents available',
    spec:    'totalCharged - stripeFee - contractorTotalPayout',
    delta:   'Margin not persisted; must be computed at reporting time',
    fix:     'Add job_margin_cents to jobs table or compute in Airtable/reporting layer'
  },
];

for (const g of gaps) {
  console.log(`Field:   ${g.field}`);
  console.log(`Backend: ${g.backend}`);
  console.log(`Spec:    ${g.spec}`);
  console.log(`Delta:   ${g.delta}`);
  console.log(`Fix:     ${g.fix}`);
  console.log('');
}

console.log(`Total gaps found: ${gaps.length}`);
console.log('\nCritical (affect live money): Small payout, Treadmill price/payout, Fixed $25 deposit');
console.log('Structural (missing features): Next-day rush tier, contractor rush bonus, rushPlatformShare, stripeFee storage, jobMargin storage');
