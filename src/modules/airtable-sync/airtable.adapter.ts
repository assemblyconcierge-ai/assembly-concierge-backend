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
  small:     'Small Assembly',
  medium:    'Medium Assembly',
  large:     'Large Assembly',
  treadmill: 'Treadmill Assembly',
  custom:    'Custom Job',
};
const SERVICE_TYPE_FALLBACK = 'Custom Job';

/** Maps internal job_status enum → Airtable "Status" Single Select option */
const JOB_STATUS_MAP: Record<string, string> = {
  intake_received:           'Intake Received',
  intake_validated:          'Intake Validated',
  quoted_outside_area:       'Quoted — Outside Area',
  awaiting_payment:          'Awaiting Payment',
  deposit_paid:              'Deposit Paid',
  paid_in_full:              'Paid in Full',
  ready_for_dispatch:        'Ready for Dispatch',
  dispatch_in_progress:      'Dispatch in Progress',
  assigned:                  'Assigned',
  scheduled:                 'Scheduled',
  work_completed:            'Work Completed',
  awaiting_remainder_payment: 'Awaiting Remainder Payment',
  closed_paid:               'Closed — Paid',
  cancelled:                 'Cancelled',
  error_review:              'Error Review',
};
const JOB_STATUS_FALLBACK = 'Intake Received';

/** Maps internal service_area_status enum → Airtable "Area Status" Single Select option */
const AREA_STATUS_MAP: Record<string, string> = {
  in_area:    'Inside Service Area',
  quote_only: 'Quote Only',
  blocked:    'Outside Service Area',
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

// ── Public interface ─────────────────────────────────────────────────────────

export interface AirtableJobRecord {
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
    'Status':         mapJobStatus(record.status),
    'Created At':     record.createdAt,
  };

  // Area Status is optional — only include if the field exists in the Airtable table
  if (record.areaStatus) {
    fields['Area Status'] = mapAreaStatus(record.areaStatus);
  }

  if (record.appointmentDate)   fields['Appointment Date']   = record.appointmentDate;
  if (record.appointmentWindow) fields['Appointment Window'] = record.appointmentWindow;

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

/** Convenience wrapper: update Status field only, mapping through safe labels */
export async function updateAirtableStatus(
  recordId: string,
  internalStatus: string,
  totalAmountCents?: number,
): Promise<void> {
  const fields: Record<string, unknown> = {
    'Status': mapJobStatus(internalStatus),
  };
  if (totalAmountCents !== undefined) {
    fields['Total Amount'] = totalAmountCents / 100;
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
