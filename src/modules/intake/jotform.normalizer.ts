import {
  CanonicalIntake,
  JotformFieldMapping,
  DEFAULT_JOTFORM_FIELD_MAPPING,
  normalizeServiceTypeCode,
  normalizeRushFlag,
} from './intake.types';
import { normalizePhone } from '../../common/utils';
import { logger } from '../../common/logger';

type RawPayload = Record<string, unknown>;

/**
 * Resolve a field value from a Jotform payload.
 *
 * WHY THIS IS COMPLEX:
 * Jotform posts webhooks as application/x-www-form-urlencoded.
 * Express urlencoded parser (extended:true) converts bracket-notation keys into
 * nested objects:
 *   "q3_fullName[first]=Jane" → { q3_fullName: { first: "Jane" } }
 *
 * BUT for very long keys (like the prepopulated address field), Express may leave
 * them as flat bracket-notation strings:
 *   "q38_address...Fiel[state]=GA" → { "q38_address...Fiel[state]": "GA" }
 *
 * We support ALL of these lookup strategies in priority order:
 *   1. Exact flat key match:          payload["q4_email"]
 *   2. Bracket-notation literal key:  payload["q3_fullName[first]"]
 *   3. Nested object via dot-notation: payload["q3_fullName"]["first"]
 *   4. Nested object via bracket-notation: payload["q3_fullName"]["first"]
 *      (same as 3, just the mapping key uses bracket syntax)
 *   5. Whole nested object joined:    payload["q3_fullName"] → "Jane Smith"
 *
 * Mapping keys use DOT notation (e.g. "q3_fullName.first") as the canonical form.
 * The resolver converts them to bracket-notation for lookup as well.
 */
function get(payload: RawPayload, key: string): string {
  if (!key) return '';

  // ── Strategy 1: Exact flat key ────────────────────────────────────────────
  const direct = payload[key];
  if (direct !== undefined && direct !== null) {
    if (typeof direct === 'string') return direct.trim();
    if (typeof direct === 'object') {
      // Whole nested object — join non-empty values (e.g. name → "Jane Smith")
      return Object.values(direct as Record<string, string>)
        .filter(Boolean)
        .join(' ')
        .trim();
    }
    return String(direct).trim();
  }

  // ── Strategy 2 & 3: Key contains a sub-field separator ───────────────────
  // Supports both dot-notation ("q3_fullName.first") and
  // bracket-notation ("q3_fullName[first]") as mapping keys.
  // Split on the LAST separator to handle long keys like:
  //   "q38_addresshttpswwwjotformcomhelp71-Prepopulating-Fiel.state"

  let parent: string | null = null;
  let child: string | null = null;

  const lastDot = key.lastIndexOf('.');
  if (lastDot !== -1) {
    parent = key.substring(0, lastDot);
    child  = key.substring(lastDot + 1);
  } else {
    const bracketMatch = key.match(/^(.+?)\[(.+?)\]$/);
    if (bracketMatch) {
      parent = bracketMatch[1];
      child  = bracketMatch[2];
    }
  }

  if (parent && child) {
    // 2a. Try bracket-notation literal key: payload["q3_fullName[first]"]
    const bracketKey = `${parent}[${child}]`;
    const bracketVal = payload[bracketKey];
    if (bracketVal !== undefined && bracketVal !== null) {
      return String(bracketVal).trim();
    }

    // 2b. Try nested object: payload["q3_fullName"]["first"]
    const parentVal = payload[parent];
    if (parentVal && typeof parentVal === 'object') {
      const childVal = (parentVal as Record<string, unknown>)[child];
      if (childVal !== undefined && childVal !== null) {
        return String(childVal).trim();
      }
    }

    // 2c. Try dot-notation literal key: payload["q3_fullName.first"]
    const dotKey = `${parent}.${child}`;
    const dotVal = payload[dotKey];
    if (dotVal !== undefined && dotVal !== null) {
      return String(dotVal).trim();
    }
  }

  return '';
}

/** Extract media URLs from Jotform payload */
function extractMedia(payload: RawPayload): string[] {
  const urls: string[] = [];
  for (const [key, val] of Object.entries(payload)) {
    if (!key.toLowerCase().includes('photo') && !key.toLowerCase().includes('upload')) continue;
    if (typeof val === 'string' && val.startsWith('http')) urls.push(val);
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string' && item.startsWith('http')) urls.push(item);
        if (typeof item === 'object' && item !== null && 'url' in item) {
          urls.push((item as { url: string }).url);
        }
      }
    }
  }
  return urls;
}

/**
 * Normalise a raw Jotform date value to ISO YYYY-MM-DD.
 *
 * Jotform date fields (e.g. q9_preferredDate) arrive as a nested object:
 *   { "day": "02", "month": "05", "year": "2026" }
 * The get() helper's strategy-1 joins the object values with spaces, producing a
 * string like "02 2026 05" (key-iteration order is not guaranteed).  This helper
 * handles all observed variants:
 *   - Jotform object { year, month, day }  → "2026-05-02"
 *   - Already ISO "2026-05-02"             → returned unchanged
 *   - Joined YYYY MM DD "2026 05 02"       → "2026-05-02"
 *   - Joined MM DD YYYY "05 02 2026"       → "2026-05-02"
 *   - Anything else                        → returned as-is (downstream logging catches it)
 */
function normalizeAppointmentDate(raw: unknown): string | undefined {
  if (!raw) return undefined;
  // Jotform nested object passed directly (before get() joins it)
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, string>;
    if (obj['year'] && obj['month'] && obj['day']) {
      return `${obj['year']}-${String(obj['month']).padStart(2, '0')}-${String(obj['day']).padStart(2, '0')}`;
    }
    return undefined;
  }
  const str = String(raw).trim();
  if (!str) return undefined;
  // Already ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // Joined string — split on whitespace and try both orderings
  const parts = str.split(/\s+/);
  if (parts.length === 3) {
    const [a, b, c] = parts;
    // YYYY MM DD (year is 4 digits in first position)
    if (a.length === 4 && /^\d+$/.test(a)) {
      return `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
    }
    // MM DD YYYY (year is 4 digits in last position)
    if (c.length === 4 && /^\d+$/.test(c)) {
      return `${c}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
    }
    // DD MM YYYY or ambiguous — last 4-digit wins as year, treat first as month
    // (Jotform always sends month before day in the object, so joined order is month-day-year
    //  or year-month-day depending on V8 key iteration)
  }
  // Unknown format — pass through unchanged
  return str;
}

/**
 * Normalize a raw Jotform webhook payload into the canonical CanonicalIntake model.
 *
 * Live field mapping (real Jotform form, direct webhook, 2026-03-13):
 *   firstName          ← q3_fullName.first  (or q3_fullName[first])
 *   lastName           ← q3_fullName.last   (or q3_fullName[last])
 *   email              ← q4_email
 *   phone              ← q79_phoneNumber79.full  fallback: q5_phoneNumber.full
 *   addressLine1       ← q6_streetNumberstreet.addr_line1
 *   city               ← q26_typeA26
 *   state              ← q38_address...Fiel.state
 *   postalCode         ← q38_address...Fiel.postal
 *   serviceType        ← q7_serviceNeeded
 *   rushRequested      ← q48_typeA48
 *   appointmentDate    ← q9_preferredDate
 *   appointmentWindow  ← q11_preferredTime
 *   customDetails      ← q13_notesFor
 *   totalAmount        ← q58_totalamount
 *   amountChargedToday ← q59_amountchargedtoday
 *   remainingBalance   ← q60_remainingbalance
 *   paymentType        ← q83_paymentType
 *   paymentMethodLabel ← q43_typeA43
 *   stripeKey          ← q87_stripekey
 *   uniqueId           ← q20_uniqueId
 *   areaTag            ← q52_areaTag
 */
export function normalizeJotformPayload(
  rawPayload: RawPayload,
  mapping: JotformFieldMapping = DEFAULT_JOTFORM_FIELD_MAPPING,
): CanonicalIntake {

  // ── DEBUG: log raw payload keys so we can see exactly what arrived ────────
  logger.info(
    { rawPayloadKeys: Object.keys(rawPayload) },
    '[Normalizer] Raw Jotform payload keys received',
  );

  // ── Submission identity ──────────────────────────────────────────────────
  const submissionId =
    (rawPayload['submissionID'] as string) ||
    (rawPayload['submission_id'] as string) ||
    (rawPayload['formID'] as string) ||
    'unknown';

  const submittedAt =
    (rawPayload['submissionDate'] as string) ||
    (rawPayload['created_at'] as string) ||
    new Date().toISOString();

  // ── Customer name ────────────────────────────────────────────────────────
  const firstName = get(rawPayload, mapping.firstName);
  const lastName  = get(rawPayload, mapping.lastName);
  const fullName  = `${firstName} ${lastName}`.trim();

  // ── Email ────────────────────────────────────────────────────────────────
  const email = get(rawPayload, mapping.email);

  // ── Phone — primary then fallback ────────────────────────────────────────
  let rawPhone = get(rawPayload, mapping.phone);
  if (!rawPhone && mapping.phoneFallback) {
    rawPhone = get(rawPayload, mapping.phoneFallback);
  }
  const phone = rawPhone ? normalizePhone(rawPhone) : '';

  // ── Address ──────────────────────────────────────────────────────────────
  const line1      = mapping.addressLine1 ? get(rawPayload, mapping.addressLine1) : '';
  const city       = get(rawPayload, mapping.city);
  const state      = (mapping.state ? get(rawPayload, mapping.state) : '') || 'GA';
  const postalCode = mapping.postalCode ? get(rawPayload, mapping.postalCode) || undefined : undefined;

  // ── Service type ─────────────────────────────────────────────────────────
  const rawServiceType = get(rawPayload, mapping.serviceType);
  const typeCode = normalizeServiceTypeCode(rawServiceType);

  // ── Rush ─────────────────────────────────────────────────────────────────
  const rushType      = mapping.rushRequested ? get(rawPayload, mapping.rushRequested) : undefined;
  const rushRequested = normalizeRushFlag(rushType);

  // ── Appointment ──────────────────────────────────────────────────────────
  // q9_preferredDate arrives as a nested object { day, month, year }; normalise to ISO.
  const rawAppointmentDate = mapping.appointmentDate
    ? (rawPayload[mapping.appointmentDate] ?? (get(rawPayload, mapping.appointmentDate) || undefined))
    : undefined;
  const appointmentDate    = normalizeAppointmentDate(rawAppointmentDate);
  const appointmentWindow = mapping.appointmentWindow ? get(rawPayload, mapping.appointmentWindow) || undefined : undefined;

  // ── Notes / custom details ───────────────────────────────────────────────
  const customJobDetails = mapping.customDetails ? get(rawPayload, mapping.customDetails) || undefined : undefined;

  // ── Financial fields ─────────────────────────────────────────────────────
  const totalAmount        = mapping.totalAmount        ? get(rawPayload, mapping.totalAmount)        || undefined : undefined;
  const amountChargedToday = mapping.amountChargedToday ? get(rawPayload, mapping.amountChargedToday) || undefined : undefined;
  const remainingBalance   = mapping.remainingBalance   ? get(rawPayload, mapping.remainingBalance)   || undefined : undefined;
  const paymentType        = mapping.paymentType        ? get(rawPayload, mapping.paymentType)        || undefined : undefined;
  const paymentMethodLabel = mapping.paymentMethodLabel ? get(rawPayload, mapping.paymentMethodLabel) || undefined : undefined;
  const stripeKey          = mapping.stripeKey          ? get(rawPayload, mapping.stripeKey)          || undefined : undefined;

  // ── Metadata ─────────────────────────────────────────────────────────────
  const uniqueId = mapping.uniqueId ? get(rawPayload, mapping.uniqueId) || undefined : undefined;
  const areaTag  = mapping.areaTag  ? get(rawPayload, mapping.areaTag)  || undefined : undefined;

  // ── Media ─────────────────────────────────────────────────────────────────
  const media = extractMedia(rawPayload);

  const formName =
    (rawPayload['formTitle'] as string) ||
    (rawPayload['form_title'] as string) ||
    undefined;

  return {
    externalSubmissionId: submissionId,
    submittedAt,
    customer:    { firstName, lastName, fullName, email, phone },
    address:     { line1, city, state, postalCode },
    service:     { typeCode, rushRequested, rushType: rushType || undefined, customJobDetails },
    appointment: { date: appointmentDate, window: appointmentWindow },
    financials:  { totalAmount, amountChargedToday, remainingBalance, paymentType, paymentMethodLabel, stripeKey },
    meta:        { uniqueId, areaTag },
    media,
    source:      { formName, raw: rawPayload },
  };
}
