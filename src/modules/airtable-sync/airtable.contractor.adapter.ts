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
  'fldTHFlf5RuluUjLK', // Onboarding Documents Accepted
  'fldj3x3BnSQt9IpKv', // Contractor Active
  'fldPHh2SUD6F6XLEA', // Activation Requested
  'fldgmMKvhbrzRQ2MK', // Contractor Status
  'fldi1iftUdPGspZzH', // Dispatch Eligible (formula)
  // Activation / dispatch fields — never touch
  'fldXXXXXXXXXXXXXX', // placeholder — add real IDs if known
]);

/** Exact write surface allowed for the dedicated missing-documents flow. */
export const MISSING_DOCUMENTS_ALLOWED_FIELD_IDS = new Set([
  'fld0Is7pUxLh2TZj3',
  'fldQHTr0eSxmhGGOW',
  'fldXR2KV5uq7DYbZ9',
  'fldQH4HCChb5i8HM9',
  'fld06XS5VPue6uSj8',
  'fldqZOgILUTVbqzii',
  'fldO46UgxkOuEpvay',
  'fldauRRFrJoe7FrKQ',
  'fldhp1o95RqRv3Oy0', // Missing Docs Review Status
]);

const ONBOARDING_DOCUMENT_STATUS_FIELD_ID = 'fldauRRFrJoe7FrKQ';
const MISSING_DOCS_REVIEW_STATUS_FIELD_ID = 'fldhp1o95RqRv3Oy0';

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

/**
 * Read only the two status fields needed to make the missing-documents PATCH
 * non-regressive. A filtered list request is used because it supports fields[]
 * projection while still selecting the exact Airtable record ID.
 */
export async function getContractorMissingDocumentsStatuses(
  recordId: string,
): Promise<{
  onboardingDocumentStatus: string | null;
  missingDocsReviewStatus: string | null;
}> {
  if (!config.AIRTABLE_API_KEY || !config.AIRTABLE_BASE_ID) {
    throw new Error('Airtable is not configured for missing-documents processing');
  }

  const escapedRecordId = recordId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const url = new URL(getBaseUrl());
  url.searchParams.set('filterByFormula', `RECORD_ID()="${escapedRecordId}"`);
  url.searchParams.append('fields[]', ONBOARDING_DOCUMENT_STATUS_FIELD_ID);
  url.searchParams.append('fields[]', MISSING_DOCS_REVIEW_STATUS_FIELD_ID);
  url.searchParams.set('maxRecords', '1');
  url.searchParams.set('returnFieldsByFieldId', 'true');

  const response = await fetch(url, { method: 'GET', headers: getHeaders() });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Airtable GET contractor statuses error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    records?: Array<{ id: string; fields?: Record<string, unknown> }>;
  };
  const record = data.records?.find((candidate) => candidate.id === recordId);
  if (!record) throw new Error(`Airtable contractor record not found: ${recordId}`);

  const fields = record.fields ?? {};
  const readString = (fieldId: string): string | null => {
    const value = fields[fieldId];
    return value === undefined || value === null ? null : String(value);
  };
  return {
    onboardingDocumentStatus: readString(ONBOARDING_DOCUMENT_STATUS_FIELD_ID),
    missingDocsReviewStatus: readString(MISSING_DOCS_REVIEW_STATUS_FIELD_ID),
  };
}

/** Fail-closed write adapter for the dedicated missing-documents flow. */
export async function updateContractorMissingDocumentsFields(
  recordId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const disallowed = Object.keys(fields).filter(
    (fieldId) => !MISSING_DOCUMENTS_ALLOWED_FIELD_IDS.has(fieldId),
  );
  if (disallowed.length > 0) {
    throw new Error(`Missing-documents Airtable update contains disallowed fields: ${disallowed.join(', ')}`);
  }
  if (!config.AIRTABLE_API_KEY || !config.AIRTABLE_BASE_ID) {
    throw new Error('Airtable is not configured for missing-documents processing');
  }
  await updateContractorAirtableFields(recordId, fields);
}
