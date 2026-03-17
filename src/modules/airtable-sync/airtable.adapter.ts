/**
 * Airtable Sync Adapter
 *
 * Airtable is a MIRROR ONLY — it is not the source of truth.
 * All sync failures are logged and retried; they must never roll back core DB transactions.
 *
 * SINGLE SELECT SAFETY RULE:
 *   All Single Select fields must be mapped through an explicit allowlist before being sent
 *   to Airtable. If an internal value is not in the allowlist, a safe fallback is used and
 *   a warning is logged. This prevents INVALID_MULTIPLE_CHOICE_OPTIONS 422 errors.
 */

import { config } from '../../common/config';
import { logger } from '../../common/logger';
import { query } from '../../db/pool';
import { v4 as uuidv4 } from 'uuid';

// ── Single Select Mapping Tables ─────────────────────────────────────────────
//
// Keys are internal backend values (database enums / service_type codes).
// Values are the EXACT option labels defined in the Airtable base.
// Add new entries here whenever a new option is added to the Airtable field.

/** Maps internal service_type.code → Airtable "Service Type" Single Select option */
const SERVICE_TYPE_MAP: Record<string, string> = {
  small:             'Small Assembly',
  medium:            'Medium Assembly',
  large:             'Large Assembly',
  treadmill:         'Treadmill Assembly',
  fitness_equipment: 'Fitness Equipment',
  custom:            'Custom Job',
};
const SERVICE_TYPE_FALLBACK = 'Custom Job';

/**
 * Maps internal job_status enum → Airtable "Status" Single Select option.
 *
 * Confirmed allowed values in Airtable "Status" field (2026-03-15):
 *   pending_payment | paid | dispatch_ready | assigned | in_progress | completed | cancelled
 *
 * Multiple internal states collapse to the same Airtable label because the
 * Airtable field represents a coarser operational view than the internal lifecycle.
 */
const JOB_STATUS_MAP: Record<string, string> = {
  intake_received:            'pending_payment',
  intake_validated:           'pending_payment',
  quoted_outside_area:        'pending_payment',
  awaiting_payment:           'pending_payment',
  deposit_paid:               'paid',
  paid_in_full:               'paid',
  ready_for_dispatch:         'dispatch_ready',
  dispatch_in_progress:       'dispatch_ready',
  assigned:                   'assigned',
  scheduled:                  'assigned',
  work_completed:             'completed',
  awaiting_remainder_payment: 'paid',
  closed_paid:                'completed',
  cancelled:                  'cancelled',
  error_review:               'pending_payment',
};
const JOB_STATUS_FALLBACK = 'pending_payment';

/**
 * Maps internal service_area_status enum → Airtable "Area Status" Single Select option.
 *
 * Confirmed allowed values in Airtable "Area Status" field (2026-03-15):
 *   Inside Service Area | Quote Only | Outside Service Area
 */
const AREA_STATUS_MAP: Record<string, string> = {
  in_area:      'Inside Service Area',
  quote_only:   'Quote Only',
  blocked:      'Outside Service Area',
  // Legacy / alternate spellings that have appeared in logs
  inside_area:  'Inside Service Area',
  outside_area: 'Outside Service Area',
  unknown:      'Quote Only',
};
const AREA_STATUS_FALLBACK = 'Quote Only';

// ── Mapping helpers ──────────────────────────────────────────────────────────

function mapServiceType(code: string): string {
  const mapped = SERVICE_TYPE_MAP[code?.toLowerCase?.()];
  if (!mapped) {
    logger.warn(
      { internalValue: code, fallback: SERVICE_TYPE_FALLBACK, field: 'Service Type' },
      '[Airtable] Unrecognised service_type_code — using fallback',
    );
    return SERVICE_TYPE_FALLBACK;
  }
  return mapped;
}

function mapJobStatus(status: string): string {
  const mapped = JOB_STATUS_MAP[status?.toLowerCase?.()];
  if (!mapped) {
    logger.warn(
      { internalValue: status, fallback: JOB_STATUS_FALLBACK, field: 'Status' },
      '[Airtable] Unrecognised job_status — using fallback',
    );
    return JOB_STATUS_FALLBACK;
  }
  return mapped;
}

function mapAreaStatus(status: string): string {
  const mapped = AREA_STATUS_MAP[status?.toLowerCase?.()];
  if (!mapped) {
    logger.warn(
      { internalValue: status, fallback: AREA_STATUS_FALLBACK, field: 'Area Status' },
      '[Airtable] Unrecognised service_area_status — using fallback',
    );
    return AREA_STATUS_FALLBACK;
  }
  return mapped;
}

/**
 * Maps appointment window strings → Airtable "Appointment Window" Single Select option.
 *
 * Airtable requires NO space before the parenthesis:
 *   "Morning (8am-12pm)"   → "Morning(8am-12pm)"
 *   "Afternoon (12pm-4pm)" → "Afternoon(12pm-4pm)"
 *   "Evening (4pm-8pm)"    → "Evening(4pm-8pm)"
 *
 * Unknown values are passed through unchanged so future windows don't silently break.
 */
const APPOINTMENT_WINDOW_MAP: Record<string, string> = {
  'Morning (8am-12pm)':   'Morning(8am-12pm)',
  'Afternoon (12pm-4pm)': 'Afternoon(12pm-4pm)',
  'Evening (4pm-8pm)':    'Evening(4pm-8pm)',
  // Already-correct variants (no space) — idempotent
  'Morning(8am-12pm)':    'Morning(8am-12pm)',
  'Afternoon(12pm-4pm)':  'Afternoon(12pm-4pm)',
  'Evening(4pm-8pm)':     'Evening(4pm-8pm)',
};
function mapAppointmentWindow(raw?: string): string | undefined {
  if (!raw) return undefined;
  const mapped = APPOINTMENT_WINDOW_MAP[raw];
  if (!mapped) {
    logger.warn(
      { internalValue: raw, field: 'Appointment Window' },
      '[Airtable] Unrecognised appointment_window — skipping field to prevent 422',
    );
    return undefined;
  }
  return mapped;
}

/** Maps internal dispatch_status enum → Airtable "Dispatch Status" Single Select option */
const DISPATCH_STATUS_MAP: Record<string, string> = {
  pending:    'Pending Dispatch',
  sent:       'Dispatch Sent',
  accepted:   'Accepted',
  declined:   'Declined',
  completed:  'Completed',
  cancelled:  'Cancelled',
};
const DISPATCH_STATUS_FALLBACK = 'Pending Dispatch';

function mapDispatchStatus(status?: string): string {
  if (!status) return DISPATCH_STATUS_FALLBACK;
  const mapped = DISPATCH_STATUS_MAP[status?.toLowerCase?.()];
  if (!mapped) {
    logger.warn(
      { internalValue: status, fallback: DISPATCH_STATUS_FALLBACK, field: 'Dispatch Status' },
      '[Airtable] Unrecognised dispatch_status — using fallback',
    );
    return DISPATCH_STATUS_FALLBACK;
  }
  return mapped;
}

// ── Public interface ─────────────────────────────────────────────────────────

export interface AirtableJobRecord {
  // Core identity
  jobKey: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  city: string;
  serviceType: string;       // internal service_type.code
  areaStatus?: string;       // internal service_area_status (optional)
  rushRequested: boolean;
  totalAmountCents: number;
  depositAmountCents: number;
  status: string;            // internal job_status enum
  appointmentDate?: string;
  appointmentWindow?: string;
  createdAt: string;
  // Extended fields (new Airtable columns)
  addressLine1?: string;
  state?: string;
  postalCode?: string;
  customerNotes?: string;
  jobPhotos?: string[];          // array of photo URLs from Jotform upload fields
  remainingBalanceCents?: number;
  paymentType?: string;          // e.g. "Pay in Full" / "$25 Deposit"
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  serviceTypeCode?: string;      // raw code for reference (e.g. "small")
  dispatchStatus?: string;       // defaults to "Pending Dispatch" at intake
  rushType?: string;             // "No Rush" | "Same-day (+30)" | "Next-day (+20)"
  // Financial split fields
  basePriceCents?: number;
  rushFeeAmountCents?: number;          // = rushAmountCents
  contractorFlatPayoutCents?: number;
  contractorRushBonusCents?: number;
  contractorTotalPayoutCents?: number;
  stripeFeeCents?: number;
  rushPlatformShareCents?: number;
  jobMarginCents?: number;
}

/** Push a job record to Airtable. Returns the Airtable record ID. */
export async function syncJobToAirtable(record: AirtableJobRecord): Promise<string | null> {
  if (!config.AIRTABLE_API_KEY || !config.AIRTABLE_BASE_ID) {
    logger.warn('[Airtable] AIRTABLE_API_KEY or AIRTABLE_BASE_ID not configured — skipping sync');
    return null;
  }

  const tableName = config.AIRTABLE_TABLE_JOBS;
  const url = `https://api.airtable.com/v0/${config.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`;

  // All Single Select fields go through the mapping layer — never raw internal values
  const fields: Record<string, unknown> = {
    'Job Key':        record.jobKey,
    'Customer Name':  record.customerName,
    'Customer Email': record.customerEmail,
    'Customer Phone': record.customerPhone,
    'City':           record.city,
    'Service Type':   mapServiceType(record.serviceType),
    'Rush Requested': record.rushRequested,
    'Total Amount':   record.totalAmountCents / 100,
    'Deposit Amount': record.depositAmountCents / 100,
    // Lifecycle status → Airtable "Status" field (confirmed allowed values: pending_payment, paid, etc.)
    'Status':         mapJobStatus(record.status ?? 'intake_received'),
    'Created At':     record.createdAt,
  };

  // Area Status — geographic classification written to its own separate field
  if (record.areaStatus) {
    fields['Area Status'] = mapAreaStatus(record.areaStatus);
  }

  if (record.appointmentDate)   fields['Appointment Date']   = record.appointmentDate;
  if (record.appointmentWindow) {
    const mappedWindow = mapAppointmentWindow(record.appointmentWindow);
    if (mappedWindow !== undefined) fields['Appointment Window'] = mappedWindow;
  }

  // ── Extended fields ────────────────────────────────────────────────────────
  // Address detail
  if (record.addressLine1) fields['Address Line 1'] = record.addressLine1;
  if (record.state)        fields['State']          = record.state;
  if (record.postalCode)   fields['Postal Code']    = record.postalCode;

  // Notes
  if (record.customerNotes) fields['Customer Notes'] = record.customerNotes;

  // Job photos — Airtable attachment field expects array of { url } objects
  if (record.jobPhotos && record.jobPhotos.length > 0) {
    fields['Job Photos'] = record.jobPhotos.map((url) => ({ url }));
  }

  // Financial
  if (record.remainingBalanceCents !== undefined) {
    fields['Remaining Balance'] = record.remainingBalanceCents / 100;
  }
  if (record.paymentType) fields['Payment Type'] = record.paymentType;

  // Stripe identifiers
  if (record.stripeCheckoutSessionId) {
    fields['Stripe Checkout Session ID'] = record.stripeCheckoutSessionId;
  }
  if (record.stripePaymentIntentId) {
    fields['Stripe Payment Intent ID'] = record.stripePaymentIntentId;
  }

  // Service type code (raw, for reference)
  if (record.serviceTypeCode) fields['Service Type Code'] = record.serviceTypeCode;

  // Rush Type — exact label from Jotform / normalizer
  if (record.rushType) fields['Rush Type'] = record.rushType;

  // ── Financial split fields ─────────────────────────────────────────────────
  // All currency fields sent as dollars (not cents) to Airtable Currency/Number fields
  if (record.basePriceCents !== undefined)
    fields['Base Price'] = record.basePriceCents / 100;
  if (record.rushFeeAmountCents !== undefined)
    fields['Rush Fee Amount'] = record.rushFeeAmountCents / 100;
  if (record.contractorFlatPayoutCents !== undefined)
    fields['Contractor Flat Payout'] = record.contractorFlatPayoutCents / 100;
  if (record.contractorRushBonusCents !== undefined)
    fields['Contractor Rush Bonus'] = record.contractorRushBonusCents / 100;
  if (record.contractorTotalPayoutCents !== undefined)
    fields['Contractor Total Payout'] = record.contractorTotalPayoutCents / 100;
  if (record.stripeFeeCents !== undefined)
    fields['Stripe Fee'] = record.stripeFeeCents / 100;
  if (record.rushPlatformShareCents !== undefined)
    fields['Rush Platform Share'] = record.rushPlatformShareCents / 100;
  if (record.jobMarginCents !== undefined)
    fields['Job Margin'] = record.jobMarginCents / 100;

  // Dispatch status — always set at intake (defaults to Pending Dispatch)
  fields['Dispatch Status'] = mapDispatchStatus(record.dispatchStatus);

  // Assigned Contractor — intentionally left blank at intake (filled by dispatcher)
  // fields['Assigned Contractor'] = '';  // omitted — do not send empty values to Airtable

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Airtable API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

/** Update an existing Airtable record.
 *  Any Single Select fields passed in fields must already be mapped to safe labels. */
export async function updateAirtableRecord(
  recordId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  if (!config.AIRTABLE_API_KEY || !config.AIRTABLE_BASE_ID) return;

  const tableName = config.AIRTABLE_TABLE_JOBS;
  const url = `https://api.airtable.com/v0/${config.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}/${recordId}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${config.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Airtable update error ${response.status}: ${body}`);
  }
}

/** Convenience wrapper: update lifecycle status and optional financial fields.
 *  Writes to Airtable "Status" field using confirmed allowed values.
 *  Does NOT write to the legacy "Job Status (Canonical Lifecycle)" field. */
export async function updateAirtableStatus(
  recordId: string,
  internalStatus: string,
  totalAmountCents?: number,
  stripePaymentIntentId?: string,
): Promise<void> {
  const fields: Record<string, unknown> = {
    'Status': mapJobStatus(internalStatus),
  };
  if (totalAmountCents !== undefined) {
    fields['Total Amount'] = totalAmountCents / 100;
  }
  if (stripePaymentIntentId) {
    fields['Stripe Payment Intent ID'] = stripePaymentIntentId;
  }
  await updateAirtableRecord(recordId, fields);
}

/** Log an integration failure for retry */
export async function logIntegrationFailure(params: {
  integrationName: string;
  relatedEntityType: string;
  relatedEntityId: string;
  operationName: string;
  payload: Record<string, unknown>;
  errorMessage: string;
}): Promise<void> {
  try {
    const nextRetry = new Date(Date.now() + 5 * 60 * 1000); // 5 min
    await query(
      `INSERT INTO integration_failures
        (id, integration_name, related_entity_type, related_entity_id, operation_name, payload_json, error_message, next_retry_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        uuidv4(),
        params.integrationName,
        params.relatedEntityType,
        params.relatedEntityId,
        params.operationName,
        JSON.stringify(params.payload),
        params.errorMessage,
        nextRetry,
      ],
    );
  } catch (dbErr) {
    logger.error({ dbErr }, '[Airtable] Failed to log integration failure');
  }
}
