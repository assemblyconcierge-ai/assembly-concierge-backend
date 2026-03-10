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
 * Jotform webhooks can send data in several formats:
 *   1. Nested object:  { "q3_name": { "first": "Jane", "last": "Smith" } }
 *      Mapping key:    "q3_name"  → returns "Jane Smith"
 *      Mapping key:    "q3_name.first" → returns "Jane"
 *
 *   2. Bracket notation (legacy / rawRequest decoded):
 *      { "q3_name[first]": "Jane" }
 *      Mapping key: "q3_name[first]" → returns "Jane"
 *
 *   3. Flat string:    { "q4_email": "jane@test.com" }
 *      Mapping key:    "q4_email" → returns "jane@test.com"
 */
function get(payload: RawPayload, key: string): string {
  // 1. Try exact key match first (handles flat strings and bracket-notation keys)
  const direct = payload[key];
  if (direct !== undefined && direct !== null) {
    if (typeof direct === 'string') return direct.trim();
    if (typeof direct === 'object') {
      // Nested object — join all values (e.g. name object → "Jane Smith")
      return Object.values(direct as Record<string, string>)
        .filter(Boolean)
        .join(' ')
        .trim();
    }
    return String(direct).trim();
  }

  // 2. Try dot-notation: "q3_name.first" → payload["q3_name"]["first"]
  if (key.includes('.')) {
    const [parent, child] = key.split('.', 2);
    const parentVal = payload[parent];
    if (parentVal && typeof parentVal === 'object') {
      const childVal = (parentVal as Record<string, unknown>)[child];
      if (childVal !== undefined && childVal !== null) return String(childVal).trim();
    }
  }

  // 3. Try bracket-notation: "q3_name[first]" → payload["q3_name"]["first"]
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

/** Extract media URLs from Jotform payload — handles both array and object formats */
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
 * The mapping is configurable — pass a custom mapping to support different form versions.
 */
export function normalizeJotformPayload(
  rawPayload: RawPayload,
  mapping: JotformFieldMapping = DEFAULT_JOTFORM_FIELD_MAPPING,
): CanonicalIntake {
  const submissionId =
    (rawPayload['submissionID'] as string) ||
    (rawPayload['submission_id'] as string) ||
    (rawPayload['formID'] as string) ||
    'unknown';

  const submittedAt =
    (rawPayload['submissionDate'] as string) ||
    (rawPayload['created_at'] as string) ||
    new Date().toISOString();

  const firstName = get(rawPayload, mapping.firstName);
  const lastName = get(rawPayload, mapping.lastName);
  const fullName = `${firstName} ${lastName}`.trim();
  const email = get(rawPayload, mapping.email);
  const rawPhone = get(rawPayload, mapping.phone);
  const phone = rawPhone ? normalizePhone(rawPhone) : '';

  const line1 = mapping.addressLine1 ? get(rawPayload, mapping.addressLine1) : '';
  const city = get(rawPayload, mapping.city);
  const state = mapping.state ? get(rawPayload, mapping.state) || 'GA' : 'GA';
  const postalCode = mapping.postalCode ? get(rawPayload, mapping.postalCode) : undefined;

  const rawServiceType = get(rawPayload, mapping.serviceType);
  const typeCode = normalizeServiceTypeCode(rawServiceType);

  const rawRush = mapping.rushRequested ? rawPayload[mapping.rushRequested] : undefined;
  const rushRequested = normalizeRushFlag(rawRush as string | boolean | undefined);

  const customJobDetails = mapping.customDetails
    ? get(rawPayload, mapping.customDetails) || undefined
    : undefined;

  const appointmentDate = mapping.appointmentDate
    ? get(rawPayload, mapping.appointmentDate) || undefined
    : undefined;
  const appointmentWindow = mapping.appointmentWindow
    ? get(rawPayload, mapping.appointmentWindow) || undefined
    : undefined;

  const media = extractMedia(rawPayload);

  const formName =
    (rawPayload['formTitle'] as string) ||
    (rawPayload['form_title'] as string) ||
    undefined;

  return {
    externalSubmissionId: submissionId,
    submittedAt,
    customer: { firstName, lastName, fullName, email, phone },
    address: { line1, city, state, postalCode },
    service: { typeCode, rushRequested, customJobDetails },
    appointment: { date: appointmentDate, window: appointmentWindow },
    media,
    source: { formName, raw: rawPayload },
  };
}
