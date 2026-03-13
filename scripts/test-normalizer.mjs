/**
 * Simulates what Express urlencoded(extended:true) produces from a real Jotform POST.
 * Jotform sends bracket-notation: q3_fullName[first]=Jane&q3_fullName[last]=Smith
 * Express extended parser converts that to nested objects: { q3_fullName: { first: "Jane", last: "Smith" } }
 *
 * This script tests both the nested-object form AND the flat bracket-key form.
 */

// Simulate the parsed body from Express urlencoded (extended:true)
// This is what req.body looks like after Jotform posts to /webhooks/jotform
const simulatedExpressParsed = {
  submissionID: "5987654321",
  formID: "242424242",
  formTitle: "Assembly Concierge Booking Form",

  // Name — Express extended parser converts q3_fullName[first] → nested object
  q3_fullName: { first: "Marcus", last: "Thompson" },

  // Email — flat
  q4_email: "marcus.thompson@example.com",

  // Phone — nested (primary)
  q79_phoneNumber79: { full: "(404) 555-0199" },
  // Phone fallback
  q5_phoneNumber: { full: "" },

  // Address line 1 — nested
  q6_streetNumberstreet: { addr_line1: "742 Evergreen Terrace" },

  // City — flat
  q26_typeA26: "Hampton",

  // State/postal — long key, Express may keep as nested or flat depending on key length
  // Test both: nested object form
  "q38_addresshttpswwwjotformcomhelp71-Prepopulating-Fiel": { state: "GA", postal: "30228" },

  // Service type — flat
  q7_serviceNeeded: "Small Assembly",

  // Rush — flat
  q48_typeA48: "No Rush",

  // Appointment
  q9_preferredDate: "2026-03-20",
  q11_preferredTime: "Morning (9am - 12pm)",

  // Notes
  q13_notesFor: "Please bring extra tools",

  // Unique ID
  q20_uniqueId: "AC-2026-0042",

  // Area tag
  q52_areaTag: "Hampton",

  // Financial
  q58_totalamount: "109.00",
  q59_amountchargedtoday: "25.00",
  q60_remainingbalance: "84.00",
  q83_paymentType: "Pay in Full",
  q43_typeA43: "Credit Card",
  q87_stripekey: "pi_test_abc123",
};

// Also test the flat bracket-notation form (what happens if Express doesn't nest)
const simulatedFlatBracket = {
  submissionID: "5987654322",
  "q3_fullName[first]": "Marcus",
  "q3_fullName[last]": "Thompson",
  q4_email: "marcus.thompson@example.com",
  "q79_phoneNumber79[full]": "(404) 555-0199",
  "q6_streetNumberstreet[addr_line1]": "742 Evergreen Terrace",
  q26_typeA26: "Hampton",
  "q38_addresshttpswwwjotformcomhelp71-Prepopulating-Fiel[state]": "GA",
  "q38_addresshttpswwwjotformcomhelp71-Prepopulating-Fiel[postal]": "30228",
  q7_serviceNeeded: "Small Assembly",
  q48_typeA48: "No Rush",
  q9_preferredDate: "2026-03-20",
  q11_preferredTime: "Morning",
  q13_notesFor: "Notes here",
  q20_uniqueId: "AC-2026-0042",
  q52_areaTag: "Hampton",
  q58_totalamount: "109.00",
  q59_amountchargedtoday: "25.00",
  q60_remainingbalance: "84.00",
  q83_paymentType: "Pay in Full",
  q43_typeA43: "Credit Card",
  q87_stripekey: "pi_test_abc123",
};

// ── Inline get() — mirrors the TypeScript implementation ──────────────────
function get(payload, key) {
  if (!key) return '';

  // 1. Exact flat key
  const direct = payload[key];
  if (direct !== undefined && direct !== null) {
    if (typeof direct === 'string') return direct.trim();
    if (typeof direct === 'object') {
      return Object.values(direct).filter(Boolean).join(' ').trim();
    }
    return String(direct).trim();
  }

  // 2. Split on last separator
  let parent = null, child = null;
  const lastDot = key.lastIndexOf('.');
  if (lastDot !== -1) {
    parent = key.substring(0, lastDot);
    child  = key.substring(lastDot + 1);
  } else {
    const m = key.match(/^(.+?)\[(.+?)\]$/);
    if (m) { parent = m[1]; child = m[2]; }
  }

  if (parent && child) {
    // 2a. Bracket-notation literal key
    const bv = payload[`${parent}[${child}]`];
    if (bv !== undefined && bv !== null) return String(bv).trim();

    // 2b. Nested object
    const pv = payload[parent];
    if (pv && typeof pv === 'object') {
      const cv = pv[child];
      if (cv !== undefined && cv !== null) return String(cv).trim();
    }

    // 2c. Dot-notation literal key
    const dv = payload[`${parent}.${child}`];
    if (dv !== undefined && dv !== null) return String(dv).trim();
  }

  return '';
}

const MAPPING = {
  firstName:           'q3_fullName.first',
  lastName:            'q3_fullName.last',
  email:               'q4_email',
  phone:               'q79_phoneNumber79.full',
  phoneFallback:       'q5_phoneNumber.full',
  addressLine1:        'q6_streetNumberstreet.addr_line1',
  city:                'q26_typeA26',
  state:               'q38_addresshttpswwwjotformcomhelp71-Prepopulating-Fiel.state',
  postalCode:          'q38_addresshttpswwwjotformcomhelp71-Prepopulating-Fiel.postal',
  serviceType:         'q7_serviceNeeded',
  rushRequested:       'q48_typeA48',
  appointmentDate:     'q9_preferredDate',
  appointmentWindow:   'q11_preferredTime',
  customDetails:       'q13_notesFor',
  totalAmount:         'q58_totalamount',
  amountChargedToday:  'q59_amountchargedtoday',
  remainingBalance:    'q60_remainingbalance',
  paymentType:         'q83_paymentType',
  paymentMethodLabel:  'q43_typeA43',
  stripeKey:           'q87_stripekey',
  uniqueId:            'q20_uniqueId',
  areaTag:             'q52_areaTag',
};

function normalizeServiceTypeCode(raw) {
  const lower = (raw ?? '').toLowerCase().trim();
  if (lower.includes('small'))     return 'small';
  if (lower.includes('medium'))    return 'medium';
  if (lower.includes('large'))     return 'large';
  if (lower.includes('treadmill')) return 'treadmill';
  if (lower.includes('custom'))    return 'custom';
  return lower.replace(/\s+/g, '_') || 'unknown';
}

function normalize(payload, label) {
  const firstName = get(payload, MAPPING.firstName);
  const lastName  = get(payload, MAPPING.lastName);
  let phone = get(payload, MAPPING.phone);
  if (!phone) phone = get(payload, MAPPING.phoneFallback);

  const result = {
    customerName:      `${firstName} ${lastName}`.trim(),
    customerEmail:     get(payload, MAPPING.email),
    customerPhone:     phone,
    addressLine1:      get(payload, MAPPING.addressLine1),
    city:              get(payload, MAPPING.city),
    state:             get(payload, MAPPING.state) || 'GA',
    postalCode:        get(payload, MAPPING.postalCode),
    serviceTypeCode:   normalizeServiceTypeCode(get(payload, MAPPING.serviceType)),
    rushRequested:     get(payload, MAPPING.rushRequested),
    appointmentDate:   get(payload, MAPPING.appointmentDate),
    appointmentWindow: get(payload, MAPPING.appointmentWindow),
    totalAmount:       get(payload, MAPPING.totalAmount),
    depositAmount:     get(payload, MAPPING.amountChargedToday),
    remainingBalance:  get(payload, MAPPING.remainingBalance),
    paymentType:       get(payload, MAPPING.paymentType),
    uniqueId:          get(payload, MAPPING.uniqueId),
    areaTag:           get(payload, MAPPING.areaTag),
  };

  const pass = result.customerName !== '' && result.customerEmail !== '' &&
               result.city !== '' && result.serviceTypeCode === 'small';

  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`RESULT: ${pass ? '✓ PASS' : '✗ FAIL'}`);
  return pass;
}

const p1 = normalize(simulatedExpressParsed, 'Nested Object (Express extended parsed)');
const p2 = normalize(simulatedFlatBracket,   'Flat Bracket Keys (Express flat)');

console.log(`\n=== SUMMARY ===`);
console.log(`Nested object form: ${p1 ? 'PASS' : 'FAIL'}`);
console.log(`Flat bracket form:  ${p2 ? 'PASS' : 'FAIL'}`);
process.exit(p1 && p2 ? 0 : 1);
