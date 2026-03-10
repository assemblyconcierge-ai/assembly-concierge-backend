import {
  CanonicalIntake,
  JotformFieldMapping,
  DEFAULT_JOTFORM_FIELD_MAPPING,
  normalizeServiceTypeCode,
  normalizeRushFlag,
} from './intake.types';
import { normalizePhone } from '../../common/utils';

type RawPayload = Record<string, unknown>;

function get(payload: RawPayload, key: string): string {
  const val = payload[key];
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'object') {
    // Jotform sometimes nests values: { "first": "John", "last": "Doe" }
    return Object.values(val as Record<string, string>)
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  return String(val).trim();
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
