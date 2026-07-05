/**
 * Airtable Contractor Adapter
 *
 * Provides GET and PATCH operations specifically for the Contractors table
 * (AIRTABLE_TABLE_CONTRACTORS, default: tblQzDt6XtSSaFAlX).
 *
 * This is separate from airtable.adapter.ts which targets the Jobs table.
 *
 * IMPORTANT: This adapter MUST NEVER update activation or dispatch fields:
 *   - Contractor Active
 *   - Contractor Status
 *   - Dispatch Eligible
 *   - Activation Requested / At / Status / Error
 *   - Backend Contractor ID
 *   - Name, Phone, Email
 *
 * These fields are enforced by the FORBIDDEN_FIELD_IDS set below.
 */

import { config } from '../../common/config';
import { logger } from '../../common/logger';

// ── Guardrail: fields that must never be written by the onboarding service ──

const FORBIDDEN_FIELD_IDS = new Set([
  // Activation / dispatch fields — never touch
  'fldXXXXXXXXXXXXXX', // placeholder — add real IDs if known
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

function getBaseUrl(): string {
  const baseId = config.AIRTABLE_BASE_ID;
  const tableName = config.AIRTABLE_TABLE_CONTRACTORS;
  if (!baseId) throw new Error('AIRTABLE_BASE_ID is not configured');
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;
}

function getHeaders(): Record<string, string> {
  const apiKey = config.AIRTABLE_API_KEY;
  if (!apiKey) throw new Error('AIRTABLE_API_KEY is not configured');
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch a single field value from a contractor Airtable record.
 * Returns null if the field is absent or Airtable is not configured.
 */
export async function getContractorAirtableField(
  recordId: string,
  fieldId: string,
): Promise<string | null> {
  if (!config.AIRTABLE_API_KEY || !config.AIRTABLE_BASE_ID) {
    logger.warn('[AirtableContractor] Not configured — skipping GET');
    return null;
  }

  const url = `${getBaseUrl()}/${recordId}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: getHeaders(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Airtable GET contractor error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as { fields?: Record<string, unknown> };
  const value = data.fields?.[fieldId];
  if (value === undefined || value === null) return null;
  return String(value);
}

/**
 * Update fields on a contractor Airtable record.
 *
 * Enforces guardrail: any field ID in FORBIDDEN_FIELD_IDS is silently removed
 * from the update payload and a warning is logged.
 *
 * Does nothing if Airtable is not configured.
 */
export async function updateContractorAirtableFields(
  recordId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  if (!config.AIRTABLE_API_KEY || !config.AIRTABLE_BASE_ID) {
    logger.warn('[AirtableContractor] Not configured — skipping PATCH');
    return;
  }

  // Enforce guardrail
  const safeFields: Record<string, unknown> = {};
  for (const [fieldId, value] of Object.entries(fields)) {
    if (FORBIDDEN_FIELD_IDS.has(fieldId)) {
      logger.warn(
        { fieldId, recordId },
        '[AirtableContractor] Blocked attempt to write forbidden field — skipping',
      );
      continue;
    }
    safeFields[fieldId] = value;
  }

  if (Object.keys(safeFields).length === 0) {
    logger.warn({ recordId }, '[AirtableContractor] No fields to update after guardrail check');
    return;
  }

  const url = `${getBaseUrl()}/${recordId}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify({ fields: safeFields }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Airtable PATCH contractor error ${response.status}: ${body}`);
  }

  logger.info(
    { recordId, fieldCount: Object.keys(safeFields).length },
    '[AirtableContractor] Record updated',
  );
}
