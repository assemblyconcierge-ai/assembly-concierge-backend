import {
  CanonicalIntake,
  JotformFieldMapping,
  DEFAULT_JOTFORM_FIELD_MAPPING,
  normalizeServiceTypeCode,
  normalizeRushFlag,
} from './intake.types';
import { normalizePhone } from '../../common/utils';

type RawPayload = Record<string, unknown>;

/**
 * Resolve a field value from a Jotform payload using a mapping key.
 *
 * Supported key formats:
 *   1. Flat string key:      "q4_email"          → payload["q4_email"]
 *   2. Dot-notation:         "q3_fullName.first"  → payload["q3_fullName"]["first"]
 *   3. Bracket-notation:     "q3_name[first]"     → payload["q3_name"]["first"]
 *   4. Nested object (no sub-key): "q3_fullName"  → joins all child values
 *
 * The long Jotform prepopulated address key is handled as dot-notation:
 *   "q38_addresshttpswwwjotformcomhelp71-Prepopulating-Fiel.state"
 *   → payload["q38_addresshttpswwwjotformcomhelp71-Prepopulating-Fiel"]["state"]
 */
function get(payload: RawPayload, key: string): string {
  if (!key) return '';

  // 1. Exact key match (flat string or bracket-notation literal key)
  const direct = payload[key];
  if (direct !== undefined && direct !== null) {
    if (typeof direct === 'string') return direct.trim();
    if (typeof direct === 'object') {
      return Object.values(direct as Record<string, string>)
        .filter(Boolean)
        .join(' ')
        .trim();
    }
    return String(direct).trim();
  }

  // 2. Dot-notation: split on LAST dot only to handle long keys like
  //    "q38_addresshttpswwwjotformcomhelp71-Prepopulating-Fiel.state"
  const lastDot = key.lastIndexOf('.');
  if (lastDot !== -1) {
    const parent = key.substring(0, lastDot);
    const child  = key.substring(lastDot + 1);
    const parentVal = payload[parent];
    if (parentVal && typeof parentVal === 'object') {
      const childVal = (parentVal as Record<string, unknown>)[child];
      if (childVal !== undefined && childVal !== null) return String(childVal).trim();
    }
  }

  // 3. Bracket-notation: "q3_name[first]" → payload["q3_name"]["first"]
  const bracketMatch = key.match(/^(.+?)\[(.+?)\]$/);
  if (bracketMatch) {
    const [, parent, child] = bracketMatch;
    const parentVal = payload[parent];
    if (parentVal && typeof parentVal === 'object') {
      const childVal = (parentVal as Record<string, unknown>)[child];
      if (childVal !== undefined && childVal !== null) return String(childVal).trim();
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
 * Normalize a raw Jotform webhook payload into the canonical CanonicalIntake model.
 *
 * Live field mapping (from real Jotform payload 2026-03-13):
 *   firstName       ← q3_fullName.first
 *   lastName        ← q3_fullName.last
 *   email           ← q4_email
 *   phone           ← q79_phoneNumber79.full  (fallback: q5_phoneNumber.full)
 *   addressLine1    ← q6_streetNumberstreet.addr_line1
 *   city            ← q26_typeA26
 *   state           ← q38_address...Fiel.state
 *   postalCode      ← q38_address...Fiel.postal
 *   serviceType     ← q7_serviceNeeded
 *   rushRequested   ← q48_typeA48
 *   appointmentDate ← q9_preferredDate
 *   appointmentWindow ← q11_preferredTime
 *   customDetails   ← q13_notesFor
 *   totalAmount     ← q58_totalamount
 *   amountChargedToday ← q59_amountchargedtoday
 *   remainingBalance ← q60_remainingbalance
 *   paymentType     ← q83_paymentType
 *   paymentMethodLabel ← q43_typeA43
 *   stripeKey       ← q87_stripekey
 *   uniqueId        ← q20_uniqueId
 *   areaTag         ← q52_areaTag
 */
export function normalizeJotformPayload(
  rawPayload: RawPayload,
  mapping: JotformFieldMapping = DEFAULT_JOTFORM_FIELD_MAPPING,
): CanonicalIntake {
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
  const rawRush    = mapping.rushRequested ? rawPayload[mapping.rushRequested] : undefined;
  const rushType   = mapping.rushRequested ? get(rawPayload, mapping.rushRequested) : undefined;
  const rushRequested = normalizeRushFlag(rawRush as string | boolean | undefined);

  // ── Appointment ──────────────────────────────────────────────────────────
  const appointmentDate   = mapping.appointmentDate   ? get(rawPayload, mapping.appointmentDate)   || undefined : undefined;
  const appointmentWindow = mapping.appointmentWindow ? get(rawPayload, mapping.appointmentWindow) || undefined : undefined;

  // ── Notes / custom details ───────────────────────────────────────────────
  const customJobDetails = mapping.customDetails ? get(rawPayload, mapping.customDetails) || undefined : undefined;

  // ── Financial fields (Jotform-calculated, passed through for reference) ──
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
