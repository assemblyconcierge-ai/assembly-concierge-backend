/**
 * Onboarding Service
 *
 * Handles inbound contractor onboarding Jotform submissions:
 *   1.  Validate payload (formID, contractorRecord, backendContractor)
 *   2.  Verify contractor exists in Postgres and IDs match
 *   3.  Idempotency check on jotform_submission_id
 *   4.  Resolve/create Google Drive folder
 *   5.  BOOL_OR aggregate: fetch cumulative prior receipt booleans
 *   6.  Download Jotform files and upload to Drive
 *   6b. Upload a complete submission summary document to Drive
 *   7.  Compute checklist booleans, merge with prior cumulative state
 *   8.  Persist metadata to Postgres (uses mergedChecklist)
 *   9.  Mirror checklist/status/links to Airtable (uses mergedChecklist)
 *   10. Clear contractor_missing_docs email lock (only if Airtable PATCH succeeded)
 *
 * Never touches activation or dispatch fields.
 * Never overwrites existing successful file links with blank/null.
 * Receipt booleans are cumulative: a field that was true in any prior
 * submission can never revert to false on a later submission.
 */

import crypto from 'crypto';
import { query, queryOne } from '../../db/pool';
import { config } from '../../common/config';
import { logger } from '../../common/logger';
import {
  resolveContractorFolder,
  downloadAndUploadFile,
  uploadBufferToFolder,
} from '../storage/googleDrive.service';
import {
  getContractorAirtableField,
  updateContractorAirtableFields,
} from '../airtable-sync/airtable.contractor.adapter';
import { clearContractorMissingDocsEvent } from '../email/email_events.repository';

// ── Constants ──────────────────────────────────────────────────────────────

const EXPECTED_FORM_ID = config.JOTFORM_ONBOARDING_FORM_ID; // '261801729818060'

// Airtable field IDs for the Contractors table
const AT = {
  SUBMITTED_AT:              'fld0Is7pUxLh2TZj3',
  SUBMISSION_ID:             'fldQHTr0eSxmhGGOW',
  DRIVE_FOLDER:              'fldXR2KV5uq7DYbZ9',
  SIGNED_AGREEMENT:          'fldQH4HCChb5i8HM9',
  W9_RECEIVED:               'fld06XS5VPue6uSj8',
  PAYMENT_SETUP:             'fldZ1q3cYMvYwni8q',
  SMS_CONSENT:               'fldd92BZZcGigAshI',
  TOOLS_TRANSPORTATION:      'fldWjj2Ox2reuMG8I',
  HANDBOOK:                  'fld85axOvjHgJDmiS',
  PHOTO_ID_RECEIVED:         'fldqZOgILUTVbqzii',
  PHOTO_ID_FILE_LINK:        'fldO46UgxkOuEpvay',
  DOCUMENT_STATUS:           'fldauRRFrJoe7FrKQ',
} as const;

// ── Types ──────────────────────────────────────────────────────────────────

export interface OnboardingPayload {
  /** Jotform outer envelope */
  formID?: string;
  submissionID?: string;
  /** Parsed Jotform rawRequest fields */
  q34_contractorRecord?: string;
  q35_backendContractor?: string;
  q43_typeA?: string;           // Legal full name
  q5_q5_textbox3?: string;      // Preferred name
  q6_q6_phone4?: { full?: string } | string;
  q8_q8_email6?: string;
  // Files — Jotform may send as string or array
  q24_fileupload22?: string | string[];  // W-9
  q29_fileupload27?: string | string[];  // Photo ID
  q30_fileupload28?: string | string[];  // Proof of Insurance
  q31_fileupload29?: string | string[];  // Other document
  uploadSigned49?: string | string[];    // Signed Contractor Agreement upload (new field)
  // Checklist fields
  q20_q20_signature18?: string;          // Legacy signature (existence check only)
  q19_q19_checkbox17?: string;           // Agreement acknowledgment
  q36_iAgree?: string;                   // SMS consent
  q14_q14_checkbox12?: string;           // Transportation
  q15_q15_checkbox13?: string;           // Tools
  q16_q16_checkbox14?: string;           // Tools/readiness agreement
  q25_q25_checkbox23?: string;           // Payment setup acknowledgment
  q26_q26_dropdown24?: string;           // Payout method
  q39_contractorHandbook39?: string;     // Handbook acknowledgment
  q32_q32_checkbox30?: string;           // Final certification
  [key: string]: unknown;
}

export interface OnboardingResult {
  status: 'processed' | 'duplicate';
  contractorId: string;
  documentStatus: string;
  processedFiles: string[];
  errors: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract the first URL from a Jotform file field (string or string[]). */
export function extractFileUrl(field: string | string[] | undefined | null): string | null {
  if (!field) return null;
  if (Array.isArray(field)) {
    const first = field[0];
    return first && first.trim() ? first.trim() : null;
  }
  const trimmed = field.trim();
  return trimmed || null;
}

/** Determine if a Jotform checkbox/text field represents a truthy response. */
export function isChecked(value: unknown): boolean {
  if (!value) return false;
  const s = String(value).trim().toLowerCase();
  return s !== '' && s !== 'no' && s !== 'false' && s !== '0' && s !== 'n/a';
}

/** Compute checklist booleans from the raw Jotform payload. */
export function computeChecklist(
  payload: OnboardingPayload,
  w9Uploaded: boolean,
  photoIdUploaded: boolean,
  signedAgreementUploaded: boolean = false,
) {
  // Signed agreement is received if EITHER:
  //   (a) legacy: both the signature field and the checkbox are present/truthy, OR
  //   (b) new: the uploadSigned49 file was successfully downloaded, validated,
  //       uploaded to Google Drive, and metadata saved (signedAgreementUploaded=true).
  const legacySignature =
    isChecked(payload.q20_q20_signature18) && isChecked(payload.q19_q19_checkbox17);
  return {
    signed_agreement_received: legacySignature || signedAgreementUploaded,
    w9_received: w9Uploaded,
    photo_id_received: photoIdUploaded,
    payment_setup_complete: isChecked(payload.q25_q25_checkbox23),
    sms_consent_confirmed: isChecked(payload.q36_iAgree),
    tools_transportation_confirmed:
      isChecked(payload.q14_q14_checkbox12) ||
      isChecked(payload.q15_q15_checkbox13) ||
      isChecked(payload.q16_q16_checkbox14),
    contractor_handbook_acknowledged: isChecked(payload.q39_contractorHandbook39),
  };
}

/** Compute the Onboarding Document Status string. */
export function computeDocumentStatus(checklist: ReturnType<typeof computeChecklist>): string {
  const allComplete =
    checklist.signed_agreement_received &&
    checklist.w9_received &&
    checklist.payment_setup_complete &&
    checklist.sms_consent_confirmed &&
    checklist.tools_transportation_confirmed &&
    checklist.contractor_handbook_acknowledged &&
    checklist.photo_id_received;
  return allComplete ? 'Submitted - Docs Complete' : 'Submitted - Missing Items';
}

/** Build a sanitized payload (strip base64 signature) for audit storage. */
function buildSanitizedPayload(payload: OnboardingPayload): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'q20_q20_signature18') {
      sanitized[k] = '[SIGNATURE_REDACTED]';
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
}

/** SHA-256 hex hash of the JSON-serialised payload for dedup/audit. */
function hashPayload(payload: OnboardingPayload): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

// ── Main service function ──────────────────────────────────────────────────

export async function processOnboardingSubmission(
  payload: OnboardingPayload,
): Promise<OnboardingResult> {
  const log = logger.child({ handler: 'onboarding-submission' });

  // ── 1. Validate form ID ──────────────────────────────────────────────────
  const formId = String(payload.formID ?? '').trim();
  if (formId && formId !== EXPECTED_FORM_ID) {
    throw Object.assign(
      new Error(`Unexpected formID: ${formId}. Expected ${EXPECTED_FORM_ID}.`),
      { statusCode: 400, code: 'WRONG_FORM_ID' },
    );
  }

  // ── 2. Validate required IDs ─────────────────────────────────────────────
  const airtableRecordId = String(payload.q34_contractorRecord ?? '').trim();
  const backendContractorId = String(payload.q35_backendContractor ?? '').trim();
  const submissionId = String(payload.submissionID ?? '').trim();

  if (!airtableRecordId) {
    throw Object.assign(
      new Error('Missing contractorRecord (q34_contractorRecord) in payload.'),
      { statusCode: 422, code: 'MISSING_CONTRACTOR_RECORD' },
    );
  }
  if (!backendContractorId) {
    throw Object.assign(
      new Error('Missing backendContractor (q35_backendContractor) in payload.'),
      { statusCode: 422, code: 'MISSING_BACKEND_CONTRACTOR_ID' },
    );
  }
  if (!submissionId) {
    throw Object.assign(
      new Error('Missing submissionID in payload.'),
      { statusCode: 422, code: 'MISSING_SUBMISSION_ID' },
    );
  }

  // ── 3. Verify contractor in Postgres ─────────────────────────────────────
  const contractor = await queryOne<{
    id: string;
    full_name: string;
    airtable_record_id: string | null;
  }>(
    'SELECT id, full_name, airtable_record_id FROM contractors WHERE id = $1',
    [backendContractorId],
  );
  if (!contractor) {
    throw Object.assign(
      new Error(`Contractor not found: ${backendContractorId}`),
      { statusCode: 404, code: 'CONTRACTOR_NOT_FOUND' },
    );
  }

  // If the contractor already has an airtable_record_id, verify it matches
  if (
    contractor.airtable_record_id &&
    contractor.airtable_record_id !== airtableRecordId
  ) {
    throw Object.assign(
      new Error(
        `airtableRecordId mismatch: payload has ${airtableRecordId}, ` +
          `DB has ${contractor.airtable_record_id}`,
      ),
      { statusCode: 409, code: 'AIRTABLE_RECORD_ID_MISMATCH' },
    );
  }

  // ── 4. Idempotency check ─────────────────────────────────────────────────
  const existing = await queryOne<{ id: string; document_status: string }>(
    'SELECT id, document_status FROM contractor_onboarding_documents WHERE jotform_submission_id = $1',
    [submissionId],
  );
  if (existing) {
    log.info(
      { submissionId, existingId: existing.id },
      '[Onboarding] Duplicate submission — returning early',
    );
    return {
      status: 'duplicate',
      contractorId: backendContractorId,
      documentStatus: existing.document_status,
      processedFiles: [],
      errors: [],
    };
  }

  // ── 5. Resolve Google Drive folder ───────────────────────────────────────
  // Check Postgres for an existing folder for this contractor
  const existingDoc = await queryOne<{
    drive_folder_id: string | null;
    drive_folder_url: string | null;
  }>(
    `SELECT drive_folder_id, drive_folder_url
       FROM contractor_onboarding_documents
      WHERE contractor_id = $1
        AND drive_folder_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [backendContractorId],
  );

  // Fetch Airtable folder URL for fallback
  let airtableFolderUrl: string | null = null;
  try {
    airtableFolderUrl = await getContractorAirtableField(airtableRecordId, AT.DRIVE_FOLDER);
  } catch (err) {
    log.warn({ err }, '[Onboarding] Could not fetch Airtable folder URL — continuing');
  }

  const legalName = String(payload.q43_typeA ?? contractor.full_name).trim();

  const folder = await resolveContractorFolder({
    existingFolderId: existingDoc?.drive_folder_id ?? null,
    existingFolderUrl: existingDoc?.drive_folder_url ?? null,
    airtableFolderUrl,
    legalName,
    airtableRecordId,
  });

  // ── 5. BOOL_OR aggregate: fetch cumulative prior receipt booleans ──────────
  // Aggregates all prior contractor_onboarding_documents rows so that a field
  // which was true in any earlier submission can never revert to false here.
  // Returns null when this is the first submission (no prior rows).
  type PriorChecklist = {
    signed_agreement_received:        boolean | null;
    w9_received:                      boolean | null;
    photo_id_received:                boolean | null;
    payment_setup_complete:           boolean | null;
    sms_consent_confirmed:            boolean | null;
    tools_transportation_confirmed:   boolean | null;
    contractor_handbook_acknowledged: boolean | null;
  };
  const priorChecklist = await queryOne<PriorChecklist>(
    `SELECT
       BOOL_OR(signed_agreement_received)        AS signed_agreement_received,
       BOOL_OR(w9_received)                      AS w9_received,
       BOOL_OR(photo_id_received)                AS photo_id_received,
       BOOL_OR(payment_setup_complete)           AS payment_setup_complete,
       BOOL_OR(sms_consent_confirmed)            AS sms_consent_confirmed,
       BOOL_OR(tools_transportation_confirmed)   AS tools_transportation_confirmed,
       BOOL_OR(contractor_handbook_acknowledged) AS contractor_handbook_acknowledged
     FROM contractor_onboarding_documents
     WHERE contractor_id = $1`,
    [backendContractorId],
  );

  // ── 6. Download and upload files ─────────────────────────────────────────
  const jotformApiKey = config.JOTFORM_API_KEY;
  const processedFiles: string[] = [];
  const errors: string[] = [];

  let w9FileId: string | null = null;
  let w9FileUrl: string | null = null;
  let photoIdFileId: string | null = null;
  let photoIdFileUrl: string | null = null;
  let insuranceFileId: string | null = null;
  let insuranceFileUrl: string | null = null;
  let otherDocFileId: string | null = null;
  let otherDocFileUrl: string | null = null;
  let signedAgreementFileId: string | null = null;
  let signedAgreementFileUrl: string | null = null;

  // Signed Contractor Agreement upload (new uploadSigned49 field — optional,
  // takes precedence over legacy q20/q19 signature for the file-based path)
  const signedAgreementUrl = extractFileUrl(payload.uploadSigned49);
  if (signedAgreementUrl) {
    try {
      const file = await downloadAndUploadFile({
        sourceUrl: signedAgreementUrl,
        fileName: `SignedAgreement_${airtableRecordId}.pdf`,
        folderId: folder.id,
        jotformApiKey,
      });
      signedAgreementFileId = file.id;
      signedAgreementFileUrl = file.webViewLink;
      processedFiles.push('Signed Agreement');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, submissionId }, '[Onboarding] Signed agreement upload failed');
      errors.push(`Signed Agreement: ${msg}`);
    }
  }

  // W-9 (required)
  const w9Url = extractFileUrl(payload.q24_fileupload22);
  if (w9Url) {
    try {
      const file = await downloadAndUploadFile({
        sourceUrl: w9Url,
        fileName: `W9_${airtableRecordId}.pdf`,
        folderId: folder.id,
        jotformApiKey,
      });
      w9FileId = file.id;
      w9FileUrl = file.webViewLink;
      processedFiles.push('W-9');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, submissionId }, '[Onboarding] W-9 upload failed');
      errors.push(`W-9: ${msg}`);
    }
  }

  // Photo ID (required)
  const photoIdUrl = extractFileUrl(payload.q29_fileupload27);
  if (photoIdUrl) {
    try {
      const file = await downloadAndUploadFile({
        sourceUrl: photoIdUrl,
        fileName: `PhotoID_${airtableRecordId}.jpg`,
        folderId: folder.id,
        jotformApiKey,
      });
      photoIdFileId = file.id;
      photoIdFileUrl = file.webViewLink;
      processedFiles.push('Photo ID');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, submissionId }, '[Onboarding] Photo ID upload failed');
      errors.push(`Photo ID: ${msg}`);
    }
  }

  // Proof of Insurance (optional)
  const insuranceUrl = extractFileUrl(payload.q30_fileupload28);
  if (insuranceUrl) {
    try {
      const file = await downloadAndUploadFile({
        sourceUrl: insuranceUrl,
        fileName: `Insurance_${airtableRecordId}.pdf`,
        folderId: folder.id,
        jotformApiKey,
      });
      insuranceFileId = file.id;
      insuranceFileUrl = file.webViewLink;
      processedFiles.push('Proof of Insurance');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, submissionId }, '[Onboarding] Insurance upload failed');
      errors.push(`Insurance: ${msg}`);
    }
  }

  // Other document (optional)
  const otherDocUrl = extractFileUrl(payload.q31_fileupload29);
  if (otherDocUrl) {
    try {
      const file = await downloadAndUploadFile({
        sourceUrl: otherDocUrl,
        fileName: `OtherDoc_${airtableRecordId}.pdf`,
        folderId: folder.id,
        jotformApiKey,
      });
      otherDocFileId = file.id;
      otherDocFileUrl = file.webViewLink;
      processedFiles.push('Other Document');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, submissionId }, '[Onboarding] Other document upload failed');
      errors.push(`Other Document: ${msg}`);
    }
  }

  // ── 6b. Upload complete submission summary to Drive ────────────────────
  // Generates a plain-text summary of the sanitised payload and uploads it
  // to the contractor's Drive folder.  The submissionId is embedded in the
  // filename so that reprocessing the same webhook produces the same filename
  // (Drive will create a second copy, but the name makes it identifiable).
  // Failure is non-fatal: logged and appended to errors, but processing continues.
  try {
    const summaryDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const safeName    = (String(payload.q43_typeA ?? contractor.full_name)).replace(/[/\\:*?"<>|]/g, '-').trim();
    const summaryFileName = `${safeName} - Onboarding Submission - ${summaryDate} - ${submissionId}.txt`;
    const summaryLines: string[] = [
      'Assembly Concierge — Contractor Onboarding Submission',
      '======================================================',
      `Submission ID : ${submissionId}`,
      `Submitted At  : ${new Date().toISOString()}`,
      `Contractor    : ${contractor.full_name}`,
      `Backend ID    : ${backendContractorId}`,
      `Airtable ID   : ${airtableRecordId}`,
      '',
      '── Submission Fields ──────────────────────────────────',
    ];
    const sanitizedForSummary = buildSanitizedPayload(payload);
    for (const [key, value] of Object.entries(sanitizedForSummary)) {
      if (value === undefined || value === null || value === '') continue;
      // Skip file URL fields — they are long and already stored separately
      const isFileField = [
        'q24_fileupload22', 'q29_fileupload27', 'q30_fileupload28',
        'q31_fileupload29', 'uploadSigned49',
      ].includes(key);
      if (isFileField) {
        summaryLines.push(`${key} : [file uploaded]`);
      } else {
        summaryLines.push(`${key} : ${JSON.stringify(value)}`);
      }
    }
    summaryLines.push('');
    summaryLines.push('── End of Submission ──────────────────────────────────');
    const summaryBuffer = Buffer.from(summaryLines.join('\n'), 'utf-8');
    await uploadBufferToFolder({
      buffer:   summaryBuffer,
      mimeType: 'text/plain',
      fileName: summaryFileName,
      folderId: folder.id,
    });
    processedFiles.push('Submission Summary');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, submissionId }, '[Onboarding] Submission summary upload failed (non-fatal)');
    errors.push(`Submission Summary: ${msg}`);
  }

  // ── 7. Compute checklist and status ──────────────────────────────────────
  // computeChecklist evaluates only the current payload. mergedChecklist
  // applies BOOL_OR semantics: a field that was true in any prior submission
  // (captured in priorChecklist) can never revert to false here.
  const checklist = computeChecklist(
    payload,
    w9FileId !== null,
    photoIdFileId !== null,
    signedAgreementFileId !== null,
  );
  const mergedChecklist = {
    signed_agreement_received:        checklist.signed_agreement_received        || (priorChecklist?.signed_agreement_received        ?? false),
    w9_received:                      checklist.w9_received                      || (priorChecklist?.w9_received                      ?? false),
    photo_id_received:                checklist.photo_id_received                || (priorChecklist?.photo_id_received                ?? false),
    payment_setup_complete:           checklist.payment_setup_complete           || (priorChecklist?.payment_setup_complete           ?? false),
    sms_consent_confirmed:            checklist.sms_consent_confirmed            || (priorChecklist?.sms_consent_confirmed            ?? false),
    tools_transportation_confirmed:   checklist.tools_transportation_confirmed   || (priorChecklist?.tools_transportation_confirmed   ?? false),
    contractor_handbook_acknowledged: checklist.contractor_handbook_acknowledged || (priorChecklist?.contractor_handbook_acknowledged ?? false),
  };
  const documentStatus = computeDocumentStatus(mergedChecklist);

  // ── 8. Persist metadata to Postgres ──────────────────────────────────────
  const payloadHash = hashPayload(payload);
  const sanitizedPayload = buildSanitizedPayload(payload);
  const processingError = errors.length > 0 ? errors.join('; ') : null;

  await query(
    `INSERT INTO contractor_onboarding_documents (
       contractor_id, airtable_record_id, jotform_submission_id,
       submission_payload_hash, sanitized_payload,
       drive_folder_id, drive_folder_url,
       w9_file_id, w9_file_url,
       photo_id_file_id, photo_id_file_url,
       insurance_file_id, insurance_file_url,
       other_document_file_id, other_document_file_url,
       signed_agreement_received, w9_received, photo_id_received,
       payment_setup_complete, sms_consent_confirmed,
       tools_transportation_confirmed, contractor_handbook_acknowledged,
       document_status, processing_error, processed_at,
       signed_agreement_file_id, signed_agreement_file_url
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       $16, $17, $18, $19, $20, $21, $22, $23, $24, NOW(),
       $25, $26
     )`,
    [
      backendContractorId,
      airtableRecordId,
      submissionId,
      payloadHash,
      JSON.stringify(sanitizedPayload),
      folder.id,
      folder.webViewLink,
      w9FileId,
      w9FileUrl,
      photoIdFileId,
      photoIdFileUrl,
      insuranceFileId,
      insuranceFileUrl,
      otherDocFileId,
      otherDocFileUrl,
      mergedChecklist.signed_agreement_received,
      mergedChecklist.w9_received,
      mergedChecklist.photo_id_received,
      mergedChecklist.payment_setup_complete,
      mergedChecklist.sms_consent_confirmed,
      mergedChecklist.tools_transportation_confirmed,
      mergedChecklist.contractor_handbook_acknowledged,
      documentStatus,
      processingError,
      signedAgreementFileId,
      signedAgreementFileUrl,
    ],
  );

  // Also persist airtable_record_id on the contractor row if not already set
  if (!contractor.airtable_record_id) {
    await query(
      'UPDATE contractors SET airtable_record_id = $1 WHERE id = $2',
      [airtableRecordId, backendContractorId],
    );
  }

  // ── 9. Mirror to Airtable ─────────────────────────────────────────────────
  const now = new Date().toISOString();
  const airtableFields: Record<string, unknown> = {
    [AT.SUBMITTED_AT]:         now,
    [AT.SUBMISSION_ID]:        submissionId,
    [AT.DRIVE_FOLDER]:         folder.webViewLink,
    [AT.SIGNED_AGREEMENT]:     mergedChecklist.signed_agreement_received,
    [AT.W9_RECEIVED]:          mergedChecklist.w9_received,
    [AT.PAYMENT_SETUP]:        mergedChecklist.payment_setup_complete,
    [AT.SMS_CONSENT]:          mergedChecklist.sms_consent_confirmed,
    [AT.TOOLS_TRANSPORTATION]: mergedChecklist.tools_transportation_confirmed,
    [AT.HANDBOOK]:             mergedChecklist.contractor_handbook_acknowledged,
    [AT.PHOTO_ID_RECEIVED]:    mergedChecklist.photo_id_received,
    [AT.DOCUMENT_STATUS]:      documentStatus,
  };

  // Only write Photo ID File Link if the upload succeeded (no-overwrite guard)
  if (photoIdFileUrl) {
    airtableFields[AT.PHOTO_ID_FILE_LINK] = photoIdFileUrl;
  }

  let airtablePatchSucceeded = false;
  try {
    await updateContractorAirtableFields(airtableRecordId, airtableFields);
    airtablePatchSucceeded = true;
  } catch (err) {
    log.error({ err, airtableRecordId }, '[Onboarding] Airtable update failed — metadata saved to Postgres');
    errors.push(`Airtable sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 10. Clear missing-docs email lock ─────────────────────────────────────
  // Only runs when the Airtable PATCH succeeded so the admin cannot send
  // another missing-docs follow-up while Airtable may contain stale receipt
  // fields or a stale missing-requirements list.
  //
  // Drive upload failures are non-fatal and do not block this step: if Drive
  // failed but Airtable was updated with the resulting incomplete state, the
  // admin can send a corrected follow-up normally.
  //
  // Audit note: DELETE removes the prior email event row, including sent_at
  // and provider_message_id. The contractor_onboarding_documents row for this
  // resubmission records that a new submission was received, but does not
  // preserve the deleted email-send audit record. This audit loss is accepted
  // as a launch tradeoff. A future email-event history redesign can preserve
  // multiple send cycles if needed.
  if (airtablePatchSucceeded) {
    try {
      await clearContractorMissingDocsEvent(backendContractorId);
    } catch (err) {
      log.warn(
        { err, contractorId: backendContractorId },
        '[Onboarding] Could not clear missing-docs email event — non-fatal',
      );
    }
  }

  log.info(
    { submissionId, contractorId: backendContractorId, documentStatus, processedFiles, errors },
    '[Onboarding] Submission processed',
  );

  return {
    status: 'processed',
    contractorId: backendContractorId,
    documentStatus,
    processedFiles,
    errors,
  };
}
