/**
 * Airtable Sync Adapter
 *
 * Airtable is a MIRROR ONLY — it is not the source of truth.
 * All sync failures are logged and retried; they must never roll back core DB transactions.
 *
 * This adapter is a stub for Phase 1. Full field mapping should be wired in Phase 4.
 */

import { config } from '../../common/config';
import { logger } from '../../common/logger';
import { query } from '../../db/pool';
import { v4 as uuidv4 } from 'uuid';

export interface AirtableJobRecord {
  jobKey: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  city: string;
  serviceType: string;
  rushRequested: boolean;
  totalAmountCents: number;
  depositAmountCents: number;
  status: string;
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

  const fields: Record<string, unknown> = {
    'Job Key': record.jobKey,
    'Customer Name': record.customerName,
    'Customer Email': record.customerEmail,
    'Customer Phone': record.customerPhone,
    'City': record.city,
    'Service Type': record.serviceType,
    'Rush Requested': record.rushRequested,
    'Total Amount': record.totalAmountCents / 100,
    'Deposit Amount': record.depositAmountCents / 100,
    'Status': record.status,
    'Created At': record.createdAt,
  };

  if (record.appointmentDate) fields['Appointment Date'] = record.appointmentDate;
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

/** Update an existing Airtable record */
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
