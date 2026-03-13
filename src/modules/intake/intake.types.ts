/** Canonical normalized intake object produced from any intake source */
export interface CanonicalIntake {
  externalSubmissionId: string;
  submittedAt: string;
  customer: {
    firstName: string;
    lastName: string;
    fullName: string;
    email: string;
    phone: string;
  };
  address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode?: string;
  };
  service: {
    typeCode: string;
    rushRequested: boolean;
    rushType?: string;         // raw rush label from form (e.g. "Same-day (+30)")
    customJobDetails?: string;
  };
  appointment: {
    date?: string;
    window?: string;           // preferred time window
  };
  /** Financial fields passed directly from Jotform (pre-calculated by form logic) */
  financials?: {
    totalAmount?: string;          // q58_totalamount
    amountChargedToday?: string;   // q59_amountchargedtoday
    remainingBalance?: string;     // q60_remainingbalance
    paymentType?: string;          // q83_paymentType  (e.g. "Pay in Full" / "$25 Deposit")
    paymentMethodLabel?: string;   // q43_typeA43
    stripeKey?: string;            // q87_stripekey
  };
  /** Metadata fields from the form */
  meta?: {
    uniqueId?: string;   // q20_uniqueId
    areaTag?: string;    // q52_areaTag
  };
  media: string[];
  source: {
    formName?: string;
    raw: Record<string, unknown>;
  };
}

/** Jotform field name mapping — configurable per form version */
export interface JotformFieldMapping {
  // Customer name
  firstName: string;
  lastName: string;
  // Contact
  email: string;
  phone: string;
  phoneFallback?: string;        // secondary phone field
  // Address
  addressLine1?: string;
  city: string;
  state?: string;
  postalCode?: string;
  // Service
  serviceType: string;
  rushRequested?: string;
  // Appointment
  appointmentDate?: string;
  appointmentWindow?: string;    // preferred time
  // Notes / custom
  customDetails?: string;
  // Financial (Jotform-calculated)
  totalAmount?: string;
  amountChargedToday?: string;
  remainingBalance?: string;
  paymentType?: string;
  paymentMethodLabel?: string;
  stripeKey?: string;
  // Metadata
  uniqueId?: string;
  areaTag?: string;
}

/**
 * LIVE Jotform field mapping — derived from real webhook payload (2026-03-13).
 *
 * Field key format notes:
 *   - Name fields:  q3_fullName.first / q3_fullName.last  (nested object, dot-notation)
 *   - Phone fields: q79_phoneNumber79.full / q5_phoneNumber.full  (nested, dot-notation)
 *   - Address:      q6_streetNumberstreet.addr_line1 (nested), q26_typeA26 (flat city),
 *                   q38_address...state / q38_address...postal (nested, dot-notation)
 *   - All other fields are flat string keys.
 */
export const DEFAULT_JOTFORM_FIELD_MAPPING: JotformFieldMapping = {
  // ── Customer name ──────────────────────────────────────────────────────────
  firstName:           'q3_fullName.first',
  lastName:            'q3_fullName.last',

  // ── Contact ────────────────────────────────────────────────────────────────
  email:               'q4_email',
  phone:               'q79_phoneNumber79.full',
  phoneFallback:       'q5_phoneNumber.full',

  // ── Address ────────────────────────────────────────────────────────────────
  addressLine1:        'q6_streetNumberstreet.addr_line1',
  city:                'q26_typeA26',
  // Long Jotform field key for the prepopulated address block:
  state:               'q38_addresshttpswwwjotformcomhelp71-Prepopulating-Fiel.state',
  postalCode:          'q38_addresshttpswwwjotformcomhelp71-Prepopulating-Fiel.postal',

  // ── Service ────────────────────────────────────────────────────────────────
  serviceType:         'q7_serviceNeeded',
  rushRequested:       'q48_typeA48',

  // ── Appointment ────────────────────────────────────────────────────────────
  appointmentDate:     'q9_preferredDate',
  appointmentWindow:   'q11_preferredTime',

  // ── Notes ──────────────────────────────────────────────────────────────────
  customDetails:       'q13_notesFor',

  // ── Financial (Jotform-calculated, passed through for reference) ───────────
  totalAmount:         'q58_totalamount',
  amountChargedToday:  'q59_amountchargedtoday',
  remainingBalance:    'q60_remainingbalance',
  paymentType:         'q83_paymentType',
  paymentMethodLabel:  'q43_typeA43',
  stripeKey:           'q87_stripekey',

  // ── Metadata ───────────────────────────────────────────────────────────────
  uniqueId:            'q20_uniqueId',
  areaTag:             'q52_areaTag',
};

/** Normalize a service type string from Jotform into a canonical code */
export function normalizeServiceTypeCode(raw: string): string {
  const lower = (raw ?? '').toLowerCase().trim();
  if (lower.includes('small'))     return 'small';
  if (lower.includes('medium'))    return 'medium';
  if (lower.includes('large'))     return 'large';
  if (lower.includes('treadmill')) return 'treadmill';
  if (lower.includes('custom'))    return 'custom';
  // Handle common Jotform label variations
  if (lower.includes('standard'))  return 'medium';
  if (lower.includes('exercise') || lower.includes('fitness')) return 'treadmill';
  // Fallback: slugify the raw value so it is at least readable in logs
  return lower.replace(/\s+/g, '_') || 'unknown';
}

/** Normalize a rush flag from various Jotform representations */
export function normalizeRushFlag(raw: string | boolean | undefined): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  const lower = String(raw).toLowerCase().trim();
  // Matches: "yes", "true", "1", "rush", "same-day", "next-day", "same day (+30)", etc.
  return (
    lower === 'yes' ||
    lower === 'true' ||
    lower === '1' ||
    lower.includes('rush') ||
    lower.includes('same') ||
    lower.includes('next')
  );
}
