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
    customJobDetails?: string;
  };
  appointment: {
    date?: string;
    window?: string;
  };
  media: string[];
  source: {
    formName?: string;
    raw: Record<string, unknown>;
  };
}

/** Jotform field name mapping — configurable per form version */
export interface JotformFieldMapping {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addressLine1?: string;
  city: string;
  state?: string;
  postalCode?: string;
  serviceType: string;
  rushRequested?: string;
  appointmentDate?: string;
  appointmentWindow?: string;
  customDetails?: string;
}

/** Default Jotform field mapping — matches current form structure */
export const DEFAULT_JOTFORM_FIELD_MAPPING: JotformFieldMapping = {
  firstName: 'q3_name[first]',
  lastName: 'q3_name[last]',
  email: 'q4_email',
  phone: 'q5_phone',
  addressLine1: 'q6_address[addr_line1]',
  city: 'q7_city',
  state: 'q7_state',
  postalCode: 'q7_postal',
  serviceType: 'q8_serviceType',
  rushRequested: 'q9_rush',
  appointmentDate: 'q10_date',
  appointmentWindow: 'q11_window',
  customDetails: 'q12_customDetails',
};

/** Normalize a service type string from Jotform into a canonical code */
export function normalizeServiceTypeCode(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (lower.includes('small')) return 'small';
  if (lower.includes('medium')) return 'medium';
  if (lower.includes('large')) return 'large';
  if (lower.includes('treadmill')) return 'treadmill';
  if (lower.includes('custom')) return 'custom';
  return lower.replace(/\s+/g, '_');
}

/** Normalize a rush flag from various Jotform representations */
export function normalizeRushFlag(raw: string | boolean | undefined): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  const lower = String(raw).toLowerCase().trim();
  return lower === 'yes' || lower === 'true' || lower === '1' || lower === 'rush';
}
