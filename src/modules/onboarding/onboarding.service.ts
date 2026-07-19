/**
 * Onboarding Service
 *
 * Handles inbound contractor onboarding Jotform submissions:
 *   1.  Validate payload (formID, contractorRecord, backendContractor)
 *   2.  Verify contractor exists in Postgres and IDs match
 *   3.  Idempotency check on jotform_submission_id
 *   4.  Resolve/create Google Drive folder
 *   5.  BOOL_OR aggregate: fetch cumulative prior receipt booleans
 *   6.  Download Jotform files and upload approved content to Drive
 *   7.  Compute cumulative status and upload a normalized text summary
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
  sanitizeFileName,
  uploadBufferToFolder,
  type DownloadedDriveFile,
  type TrustedDocumentContentType,
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
  submissionDate?: string;
  created_at?: string;
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
  // Additional response fields
  q7_q7_phone5?: { full?: string } | string;  // Best Phone Number for Dispatch
  q10_q10_checkbox8?: string;                 // Approved Services Confirmation
  q21_q21_datetime19?: { day?: string; month?: string; year?: string } | string; // Agreement Signed Date
  q11_q11_textarea9?: string;                 // Services No Longer Accepted
  q12_q12_textarea10?: string;                // Service Area or Availability Changes
  q17_q17_textarea15?: string;                // Tool, Transportation, or Readiness Updates
  q23_q23_radio21?: string;                   // W-9 Upload Intent
  q27_q27_textarea25?: string;                // Payment Setup Notes
  q40_questionsOr?: string;                   // Questions or Comments
  [key: string]: unknown;
}

export interface OnboardingResult {
  status: 'processed' | 'duplicate';
  submissionId: string;
  contractorId: string;
  airtableRecordId: string;
  submittedAt: string;
  documents: OnboardingDocumentResult[];
  overallDocumentStatus: string;
  documentStatus: string;
  processedFiles: string[];
  processingErrors: string[];
  errors: string[];
}

export type OnboardingDocumentType =
  | 'signed_agreement'
  | 'w9'
  | 'photo_id'
  | 'insurance'
  | 'other_document';

export type OnboardingDocumentResultStatus =
  | 'uploaded'
  | 'previously_retained'
  | 'missing'
  | 'rejected'
  | 'optional_not_supplied'
  | 'accepted_legacy';

export interface OnboardingDocumentResult {
  documentType: OnboardingDocumentType;
  label: string;
  status: OnboardingDocumentResultStatus;
  requirementSatisfied: boolean;
  originalFileName?: string;
  detectedContentType?: TrustedDocumentContentType;
  storedFileName?: string;
  driveFileId?: string;
  driveFileUrl?: string;
  safeRejectionReason?: string;
}

export interface OnboardingResponseFields {
  legalName: string;
  preferredName?: string;
  phone?: string;
  dispatchPhone?: string;
  email?: string;
  approvedServicesConfirmed: boolean;
  agreementSignedDate?: string;  // YYYY-MM-DD
  agreementAcknowledged: boolean;
  smsConsentConfirmed: boolean;
  transportationConfirmed: boolean;
  basicToolsConfirmed: boolean;
  jobReadinessConfirmed: boolean;
  paymentSetupAcknowledged: boolean;
  preferredPayoutMethod?: string;
  handbookAcknowledged: boolean;
  informationAccuracyCertified: boolean;
}

export interface AdditionalResponseFields {
  servicesNoLongerAccepted?: string;
  serviceAreaChanges?: string;
  toolTransportationUpdates?: string;
  w9UploadIntent?: string;
  paymentSetupNotes?: string;
  questionsOrComments?: string;
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

const FILE_FIELD_KEYS = new Set([
  'q24_fileupload22',
  'q29_fileupload27',
  'q30_fileupload28',
  'q31_fileupload29',
  'uploadSigned49',
]);
const SENSITIVE_PAYLOAD_KEY = /(?:authorization|api.?key|password|secret|token)/i;

/** Build a sanitized payload for audit storage without signatures or source URLs. */
function buildSanitizedPayload(payload: OnboardingPayload): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'q20_q20_signature18') {
      sanitized[k] = '[SIGNATURE_REDACTED]';
    } else if (SENSITIVE_PAYLOAD_KEY.test(k)) {
      sanitized[k] = '[CREDENTIAL_REDACTED]';
    } else if (FILE_FIELD_KEYS.has(k) && v) {
      sanitized[k] = '[FILE_SOURCE_REDACTED]';
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
}

/**
 * Collapse all line-break characters (CR, LF, Unicode LS/PS) and repeated
 * whitespace to a single space, then trim.  Returns undefined for blank input
 * so callers can use `|| fallback` or conditional spread cleanly.
 */
function normalizeSingleLine(value: unknown): string | undefined {
  const normalized = String(value ?? '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || undefined;
}

/**
 * Normalise a free-text textarea value for safe inclusion in the Drive summary.
 *
 * - Normalises CRLF / CR / U+2028 / U+2029 to LF so line structure is preserved.
 * - Trims trailing whitespace from every line.
 * - Collapses runs of more than two consecutive blank lines to a single blank line.
 * - Strips leading and trailing blank lines from the result.
 * - Prevents values from injecting fake section headings or trusted field labels by
 *   prefixing any line that exactly matches a known summary heading with a zero-width
 *   space (U+200B), making it visually identical but not matching a regex anchor.
 * - Returns undefined for values that are blank after normalisation.
 */
const SUMMARY_HEADING_RE = /^(?:Contractor Onboarding Submission|Onboarding Responses|Additional Onboarding Responses|Document Results|Overall Status:|Processing Notes:|Signed Agreement|W-9|Photo ID|Proof of Insurance|Other Document)$/;

function safeMultiline(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = String(value)
    // Normalise all line-ending variants to LF
    .replace(/\r\n|\r|\u2028|\u2029/g, '\n')
    // Trim trailing whitespace from each line
    .replace(/[^\S\n]+$/gm, '')
    // Collapse runs of 3+ consecutive blank lines to exactly one blank line
    .replace(/\n{3,}/g, '\n\n')
    // Strip leading and trailing blank lines
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
    .trim();
  if (!raw) return undefined;
  // Prefix any line that exactly matches a known summary heading so it cannot
  // be mistaken for a real section boundary when the summary is parsed.
  const safeLines = raw.split('\n').map((line) =>
    SUMMARY_HEADING_RE.test(line) ? `\u200B${line}` : line,
  );
  return safeLines.join('\n');
}

/**
 * Render a labelled field whose value may span multiple lines.
 *
 * The first content line is prefixed with "Label: "; every continuation line
 * is indented with two spaces.  This prevents any embedded line from being
 * mistaken for a top-level summary field or section heading when the file is
 * read back line-by-line.
 */
function renderMultilineField(label: string, value: string): string {
  const contentLines = value.split('\n');
  const first = `${label}: ${contentLines[0]}`;
  const rest  = contentLines.slice(1).map((l) => `  ${l}`);
  return [first, ...rest].join('\n');
}

/** Normalise a Jotform phone field (object or string) to a single-line string. */
function normalizePhoneField(raw: unknown): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'full' in raw) {
    return normalizeSingleLine((raw as { full?: string }).full);
  }
  if (typeof raw === 'string') {
    return normalizeSingleLine(raw);
  }
  return undefined;
}

/**
 * Determine whether a given year is a leap year.
 * A year is a leap year if it is divisible by 4, except for century years,
 * which must be divisible by 400.
 */
function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Return the maximum valid day for a given month and year.
 * Months are 1-indexed (1 = January, 12 = December).
 */
function daysInMonth(m: number, y: number): number {
  const days = [0, 31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[m] ?? 0;
}

/**
 * Strictly validate and normalise a calendar date to YYYY-MM-DD.
 *
 * Rejects:
 *  - month < 1 or > 12
 *  - day < 1 or > actual days in that month (e.g. Feb 30, Apr 31)
 *  - Feb 29 in non-leap years
 *
 * Does not rely on Date() normalisation (which silently rolls over invalid dates).
 */
function normalizeDateField(raw: unknown): string | undefined {
  let y: number;
  let m: number;
  let d: number;

  if (!raw) return undefined;

  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const obj = raw as { day?: string; month?: string; year?: string };
    const ys = normalizeSingleLine(obj.year);
    const ms = normalizeSingleLine(obj.month);
    const ds = normalizeSingleLine(obj.day);
    if (!ys || !ms || !ds) return undefined;
    y = parseInt(ys, 10);
    m = parseInt(ms, 10);
    d = parseInt(ds, 10);
  } else if (typeof raw === 'string') {
    const s = normalizeSingleLine(raw);
    if (!s) return undefined;
    // Accept YYYY-MM-DD or YYYY/MM/DD or similar numeric-only formats
    const match = s.match(/^(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})$/);
    if (!match) return undefined;
    y = parseInt(match[1]!, 10);
    m = parseInt(match[2]!, 10);
    d = parseInt(match[3]!, 10);
  } else {
    return undefined;
  }

  // Reject out-of-range month or day
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return undefined;
  if (m < 1 || m > 12) return undefined;
  if (d < 1 || d > daysInMonth(m, y)) return undefined;

  const yStr  = String(y).padStart(4, '0');
  const mStr  = String(m).padStart(2, '0');
  const dStr  = String(d).padStart(2, '0');
  return `${yStr}-${mStr}-${dStr}`;
}

/** Extract owner-review response fields from a raw Jotform payload. */
export function extractResponseFields(
  payload: OnboardingPayload,
  fallbackName: string,
): OnboardingResponseFields {
  const submittedLegalName = normalizeSingleLine(payload.q43_typeA);
  const fallbackLegalName  = normalizeSingleLine(fallbackName) ?? '';

  return {
    legalName:            submittedLegalName || fallbackLegalName,
    preferredName:        normalizeSingleLine(payload.q5_q5_textbox3),
    phone:                normalizePhoneField(payload.q6_q6_phone4),
    dispatchPhone:        normalizePhoneField(payload.q7_q7_phone5),
    email:                normalizeSingleLine(payload.q8_q8_email6),
    approvedServicesConfirmed:   isChecked(payload.q10_q10_checkbox8),
    agreementSignedDate:         normalizeDateField(payload.q21_q21_datetime19),
    agreementAcknowledged:       isChecked(payload.q19_q19_checkbox17),
    smsConsentConfirmed:         isChecked(payload.q36_iAgree),
    transportationConfirmed:     isChecked(payload.q14_q14_checkbox12),
    basicToolsConfirmed:         isChecked(payload.q15_q15_checkbox13),
    jobReadinessConfirmed:       isChecked(payload.q16_q16_checkbox14),
    paymentSetupAcknowledged:    isChecked(payload.q25_q25_checkbox23),
    preferredPayoutMethod:       normalizeSingleLine(payload.q26_q26_dropdown24),
    handbookAcknowledged:        isChecked(payload.q39_contractorHandbook39),
    informationAccuracyCertified: isChecked(payload.q32_q32_checkbox30),
  };
}

/** Extract additional free-text response fields from a raw Jotform payload. */
export function extractAdditionalResponseFields(
  payload: OnboardingPayload,
): AdditionalResponseFields {
  return {
    servicesNoLongerAccepted:  safeMultiline(payload.q11_q11_textarea9),
    serviceAreaChanges:        safeMultiline(payload.q12_q12_textarea10),
    toolTransportationUpdates: safeMultiline(payload.q17_q17_textarea15),
    w9UploadIntent:            safeMultiline(payload.q23_q23_radio21),
    paymentSetupNotes:         safeMultiline(payload.q27_q27_textarea25),
    questionsOrComments:       safeMultiline(payload.q40_questionsOr),
  };
}

/** SHA-256 hex hash of the JSON-serialised payload for dedup/audit. */
function hashPayload(payload: OnboardingPayload): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

/** Select a stable ISO submission timestamp without trusting malformed input. */
function resolveSubmissionTimestamp(payload: OnboardingPayload, fallback: string): string {
  const candidate = payload.submissionDate ?? payload.created_at;
  if (!candidate) return fallback;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

/** Keep operational rejection text useful without retaining URLs or credentials. */
function safeProcessingReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split(/\r?\n/, 1)[0] ?? 'Processing failed')
    .replace(/https?:\/\/[^\s"']+/gi, '[URL_REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api.?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function documentStatusLabel(status: OnboardingDocumentResultStatus): string {
  return status.replace(/_/g, ' ');
}

/** Render the normalized result as a concise, human-readable Drive summary. */
export function renderOnboardingSummary(
  result: OnboardingResult,
  responses: OnboardingResponseFields,
  additional: AdditionalResponseFields = {},
): string {
  const yn = (v: boolean) => (v ? 'Yes' : 'No');

  const lines = [
    'Contractor Onboarding Submission',
    '',
    `Contractor: ${responses.legalName}`,
    `Contractor ID: ${result.contractorId}`,
    `Airtable Record ID: ${result.airtableRecordId}`,
    `Submission ID: ${result.submissionId}`,
    `Submitted: ${result.submittedAt}`,
    '',
    'Onboarding Responses',
    `Legal Name: ${responses.legalName}`,
    ...(responses.preferredName ? [`Preferred Name: ${responses.preferredName}`] : []),
    `Phone: ${responses.phone ?? 'Not provided'}`,
    ...(responses.dispatchPhone ? [`Best Phone for Dispatch: ${responses.dispatchPhone}`] : []),
    `Email: ${responses.email ?? 'Not provided'}`,
    `Approved Services Confirmed: ${yn(responses.approvedServicesConfirmed)}`,
    ...(responses.agreementSignedDate ? [`Agreement Signed Date: ${responses.agreementSignedDate}`] : []),
    `Agreement Acknowledged: ${yn(responses.agreementAcknowledged)}`,
    `SMS Consent Confirmed: ${yn(responses.smsConsentConfirmed)}`,
    `Transportation Confirmed: ${yn(responses.transportationConfirmed)}`,
    `Basic Tools Confirmed: ${yn(responses.basicToolsConfirmed)}`,
    `Job Readiness Confirmed: ${yn(responses.jobReadinessConfirmed)}`,
    `Payment Setup Acknowledged: ${yn(responses.paymentSetupAcknowledged)}`,
    ...(responses.preferredPayoutMethod ? [`Preferred Payout Method: ${responses.preferredPayoutMethod}`] : []),
    `Contractor Handbook Acknowledged: ${yn(responses.handbookAcknowledged)}`,
    `Information Accuracy Certified: ${yn(responses.informationAccuracyCertified)}`,
  ];

  // Additional Onboarding Responses — free-text fields; omit only truly blank values.
  // renderMultilineField indents continuation lines so no embedded line can be
  // mistaken for a top-level summary field or section heading.
  const additionalLines: string[] = [];
  if (additional.servicesNoLongerAccepted) {
    additionalLines.push(renderMultilineField('Services No Longer Accepted', additional.servicesNoLongerAccepted));
  }
  if (additional.serviceAreaChanges) {
    additionalLines.push(renderMultilineField('Service Area or Availability Changes', additional.serviceAreaChanges));
  }
  if (additional.toolTransportationUpdates) {
    additionalLines.push(renderMultilineField('Tool, Transportation, or Readiness Updates', additional.toolTransportationUpdates));
  }
  if (additional.w9UploadIntent) {
    additionalLines.push(renderMultilineField('W-9 Upload Intent', additional.w9UploadIntent));
  }
  if (additional.paymentSetupNotes) {
    additionalLines.push(renderMultilineField('Payment Setup Notes', additional.paymentSetupNotes));
  }
  if (additional.questionsOrComments) {
    additionalLines.push(renderMultilineField('Questions or Comments', additional.questionsOrComments));
  }
  if (additionalLines.length > 0) {
    lines.push('', 'Additional Onboarding Responses', ...additionalLines);
  }

  lines.push('', 'Document Results');

  for (const document of result.documents) {
    lines.push('', document.label);
    lines.push(`Status: ${documentStatusLabel(document.status)}`);
    if (document.originalFileName) {
      lines.push(`Original filename: ${document.originalFileName}`);
    }
    if (document.detectedContentType) {
      lines.push(`Detected type: ${document.detectedContentType}`);
    }
    if (document.storedFileName) {
      lines.push(`Stored filename: ${document.storedFileName}`);
    }
    if (document.safeRejectionReason) {
      lines.push(`Reason: ${document.safeRejectionReason}`);
    }
  }

  lines.push('', `Overall Status: ${result.overallDocumentStatus}`);
  lines.push('Processing Notes:');
  if (result.processingErrors.length === 0) {
    lines.push('None');
  } else {
    for (const error of result.processingErrors) lines.push(`- ${error}`);
  }

  return `${lines.join('\n')}\n`;
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
  const processedAt = new Date().toISOString();
  const submittedAt = resolveSubmissionTimestamp(payload, processedAt);

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
      submissionId,
      contractorId: backendContractorId,
      airtableRecordId,
      submittedAt,
      documents: [],
      overallDocumentStatus: existing.document_status,
      documentStatus: existing.document_status,
      processedFiles: [],
      processingErrors: [],
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
  const documents: OnboardingDocumentResult[] = [];
  const legacyAgreementSatisfied =
    isChecked(payload.q20_q20_signature18) && isChecked(payload.q19_q19_checkbox17);

  function recordUploadedDocument(
    documentType: OnboardingDocumentType,
    label: string,
    requestedFileName: string,
    file: DownloadedDriveFile,
  ): void {
    const originalFileName = sanitizeFileName(requestedFileName);
    documents.push({
      documentType,
      label,
      status: 'uploaded',
      requirementSatisfied: true,
      originalFileName: file.originalFileName ?? originalFileName,
      detectedContentType: file.detectedContentType,
      storedFileName: file.storedFileName ?? originalFileName,
      driveFileId: file.id,
      driveFileUrl: file.webViewLink,
    });
  }

  function recordRejectedDocument(
    documentType: OnboardingDocumentType,
    label: string,
    requestedFileName: string,
    err: unknown,
    requirementSatisfied: boolean,
  ): string {
    const reason = safeProcessingReason(err);
    documents.push({
      documentType,
      label,
      status: 'rejected',
      requirementSatisfied,
      originalFileName: sanitizeFileName(requestedFileName),
      safeRejectionReason: reason,
    });
    return reason;
  }

  function recordAbsentDocument(
    documentType: OnboardingDocumentType,
    label: string,
    opts: { optional?: boolean; previouslySatisfied?: boolean; acceptedLegacy?: boolean },
  ): void {
    let status: OnboardingDocumentResultStatus;
    if (opts.acceptedLegacy) status = 'accepted_legacy';
    else if (opts.previouslySatisfied) status = 'previously_retained';
    else if (opts.optional) status = 'optional_not_supplied';
    else status = 'missing';
    documents.push({
      documentType,
      label,
      status,
      requirementSatisfied:
        Boolean(opts.optional) || Boolean(opts.previouslySatisfied) || Boolean(opts.acceptedLegacy),
    });
  }

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
      recordUploadedDocument(
        'signed_agreement',
        'Signed Agreement',
        `SignedAgreement_${airtableRecordId}.pdf`,
        file,
      );
    } catch (err) {
      const msg = recordRejectedDocument(
        'signed_agreement',
        'Signed Agreement',
        `SignedAgreement_${airtableRecordId}.pdf`,
        err,
        legacyAgreementSatisfied || (priorChecklist?.signed_agreement_received ?? false),
      );
      log.error({ err, submissionId }, '[Onboarding] Signed agreement upload failed');
      errors.push(`Signed Agreement: ${msg}`);
    }
  } else {
    recordAbsentDocument('signed_agreement', 'Signed Agreement', {
      previouslySatisfied: priorChecklist?.signed_agreement_received ?? false,
      acceptedLegacy: legacyAgreementSatisfied,
    });
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
      recordUploadedDocument('w9', 'W-9', `W9_${airtableRecordId}.pdf`, file);
    } catch (err) {
      const msg = recordRejectedDocument(
        'w9',
        'W-9',
        `W9_${airtableRecordId}.pdf`,
        err,
        priorChecklist?.w9_received ?? false,
      );
      log.error({ err, submissionId }, '[Onboarding] W-9 upload failed');
      errors.push(`W-9: ${msg}`);
    }
  } else {
    recordAbsentDocument('w9', 'W-9', {
      previouslySatisfied: priorChecklist?.w9_received ?? false,
    });
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
      recordUploadedDocument('photo_id', 'Photo ID', `PhotoID_${airtableRecordId}.jpg`, file);
    } catch (err) {
      const msg = recordRejectedDocument(
        'photo_id',
        'Photo ID',
        `PhotoID_${airtableRecordId}.jpg`,
        err,
        priorChecklist?.photo_id_received ?? false,
      );
      log.error({ err, submissionId }, '[Onboarding] Photo ID upload failed');
      errors.push(`Photo ID: ${msg}`);
    }
  } else {
    recordAbsentDocument('photo_id', 'Photo ID', {
      previouslySatisfied: priorChecklist?.photo_id_received ?? false,
    });
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
      recordUploadedDocument(
        'insurance',
        'Proof of Insurance',
        `Insurance_${airtableRecordId}.pdf`,
        file,
      );
    } catch (err) {
      const msg = recordRejectedDocument(
        'insurance',
        'Proof of Insurance',
        `Insurance_${airtableRecordId}.pdf`,
        err,
        true,
      );
      log.warn({ err, submissionId }, '[Onboarding] Insurance upload failed');
      errors.push(`Insurance: ${msg}`);
    }
  } else {
    recordAbsentDocument('insurance', 'Proof of Insurance', { optional: true });
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
      recordUploadedDocument(
        'other_document',
        'Other Document',
        `OtherDoc_${airtableRecordId}.pdf`,
        file,
      );
    } catch (err) {
      const msg = recordRejectedDocument(
        'other_document',
        'Other Document',
        `OtherDoc_${airtableRecordId}.pdf`,
        err,
        true,
      );
      log.warn({ err, submissionId }, '[Onboarding] Other document upload failed');
      errors.push(`Other Document: ${msg}`);
    }
  } else {
    recordAbsentDocument('other_document', 'Other Document', { optional: true });
  }

  // ── 6b. Upload complete submission summary to Drive ────────────────────
  // Generates a plain-text summary of normalized document outcomes and uploads
  // it to the contractor's Drive folder. The submissionId is embedded in the
  // filename so that reprocessing the same webhook produces the same filename
  // (Drive will create a second copy, but the name makes it identifiable).
  // Failure is non-fatal: logged and appended to errors, but processing continues.
  // Status is derived only from successful current uploads and cumulative prior
  // receipt state; the mere presence of a Jotform upload field is insufficient.
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
  const normalizedResult: OnboardingResult = {
    status: 'processed',
    submissionId,
    contractorId: backendContractorId,
    airtableRecordId,
    submittedAt,
    documents,
    overallDocumentStatus: documentStatus,
    documentStatus,
    processedFiles,
    processingErrors: errors,
    errors,
  };

  try {
    const summaryDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const safeName    = (String(payload.q43_typeA ?? contractor.full_name)).replace(/[/\\:*?"<>|]/g, '-').trim();
    const summaryFileName = `${safeName} - Onboarding Submission - ${summaryDate} - ${submissionId}.txt`;
    const summaryBuffer = Buffer.from(
      renderOnboardingSummary(
        normalizedResult,
        extractResponseFields(payload, contractor.full_name),
        extractAdditionalResponseFields(payload),
      ),
      'utf-8',
    );
    await uploadBufferToFolder({
      buffer:   summaryBuffer,
      mimeType: 'text/plain',
      fileName: summaryFileName,
      folderId: folder.id,
    });
    processedFiles.push('Submission Summary');
  } catch (err) {
    const msg = safeProcessingReason(err);
    log.error({ err, submissionId }, '[Onboarding] Submission summary upload failed (non-fatal)');
    errors.push(`Submission Summary: ${msg}`);
  }

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
    errors.push(`Airtable sync failed: ${safeProcessingReason(err)}`);
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

  return normalizedResult;
}
