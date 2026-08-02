import { queryOne } from '../../db/pool';
import { config } from '../../common/config';
import { logger } from '../../common/logger';
import {
  downloadAndUploadFile,
  resolveContractorFolder,
  sanitizeFileName,
  type TrustedDocumentContentType,
} from '../storage/googleDrive.service';
import {
  getContractorAirtableField,
  getContractorMissingDocumentsStatuses,
  updateContractorMissingDocumentsFields,
} from '../airtable-sync/airtable.contractor.adapter';
import { sendMissingDocumentsOperatorNotification } from '../email/email.service';
import { extractFileUrl } from './onboarding.service';
import {
  claimMissingDocumentsFileProcessing,
  claimMissingDocumentsNotification,
  findContractorOnboardingFolder,
  getMissingDocumentsSubmission,
  markMissingDocumentsAirtableFailed,
  markMissingDocumentsAirtableSynced,
  markMissingDocumentsFilesFailed,
  markMissingDocumentsFilesProcessed,
  markMissingDocumentsNotificationComplete,
  markMissingDocumentsNotificationFailed,
  reserveMissingDocumentsSubmission,
  type MissingDocumentsSubmissionRow,
} from './missingDocuments.repository';

const AT = {
  SUBMITTED_AT: 'fld0Is7pUxLh2TZj3',
  SUBMISSION_ID: 'fldQHTr0eSxmhGGOW',
  DRIVE_FOLDER: 'fldXR2KV5uq7DYbZ9',
  SIGNED_AGREEMENT: 'fldQH4HCChb5i8HM9',
  W9_RECEIVED: 'fld06XS5VPue6uSj8',
  PHOTO_ID_RECEIVED: 'fldqZOgILUTVbqzii',
  PHOTO_ID_FILE_LINK: 'fldO46UgxkOuEpvay',
  DOCUMENT_STATUS: 'fldauRRFrJoe7FrKQ',
  MISSING_DOCS_REVIEW_STATUS: 'fldhp1o95RqRv3Oy0',
} as const;

export const MISSING_DOCUMENTS_REVIEW_STATUS = 'Owner Review Needed';
export const MISSING_DOCS_AWAITING_REVIEW_STATUS = 'Awaiting Review';
const APPROVED_FOR_ACTIVATION_REQUEST = 'Approved for Activation Request';
const BLOCKED_ONBOARDING_DOCUMENT_STATUS = 'Blocked';
const TERMINAL_MISSING_DOCS_REVIEW_STATUSES = new Set([
  'Reviewed - Accepted',
  'More Documents Needed',
]);

export type MissingDocumentType =
  | 'signed_agreement'
  | 'w9'
  | 'photo_id'
  | 'insurance'
  | 'other_document';

export interface MissingDocumentsPayload {
  formID?: string;
  submissionID?: string;
  submissionDate?: string;
  created_at?: string;
  contractorRecord?: string;
  backendContractor?: string;
  q34_contractorRecord?: string;
  q35_backendContractor?: string;
  signedContractorAgreement?: string | string[];
  uploadSigned49?: string | string[];
  w9?: string | string[];
  q24_fileupload22?: string | string[];
  photoId?: string | string[];
  q29_fileupload27?: string | string[];
  insurance?: string | string[];
  q30_fileupload28?: string | string[];
  otherDocument?: string | string[];
  q31_fileupload29?: string | string[];
  contractorMessage?: string;
  correctionNote?: string;
  q40_questionsOr?: string;
  [key: string]: unknown;
}

export interface MissingDocumentResult {
  documentType: MissingDocumentType;
  label: string;
  status: 'uploaded' | 'rejected' | 'not_supplied';
  storedFileName?: string;
  detectedContentType?: TrustedDocumentContentType;
  driveFileId?: string;
  driveFileUrl?: string;
  error?: string;
}

export interface MissingDocumentsResult {
  status: 'processed' | 'duplicate' | 'retry_pending';
  submissionId: string;
  contractorId: string;
  airtableRecordId: string;
  documentStatus: typeof MISSING_DOCUMENTS_REVIEW_STATUS;
  documents: MissingDocumentResult[];
  processedFiles: string[];
  errors: string[];
  notificationStatus: string;
}

function clientError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/gi, '[redacted URL]').slice(0, 1000);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function submittedAt(payload: MissingDocumentsPayload): string {
  const raw = firstString(payload.submissionDate, payload.created_at);
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function documentResultsFromRow(row: MissingDocumentsSubmissionRow): MissingDocumentResult[] {
  const stored = typeof row.document_results === 'string'
    ? JSON.parse(row.document_results) as Record<string, MissingDocumentResult>
    : row.document_results as Record<string, MissingDocumentResult>;
  return Object.values(stored ?? {});
}

function resultResponse(
  row: MissingDocumentsSubmissionRow,
  contractorId: string,
  status: MissingDocumentsResult['status'],
  extraErrors: string[] = [],
): MissingDocumentsResult {
  const documents = documentResultsFromRow(row);
  return {
    status,
    submissionId: row.jotform_submission_id,
    contractorId,
    airtableRecordId: row.airtable_record_id,
    documentStatus: MISSING_DOCUMENTS_REVIEW_STATUS,
    documents,
    processedFiles: documents.filter((doc) => doc.status === 'uploaded').map((doc) => doc.label),
    errors: [
      ...documents.filter((doc) => doc.status === 'rejected').map((doc) => `${doc.label}: ${doc.error}`),
      ...extraErrors,
    ],
    notificationStatus: row.notification_status,
  };
}

const DOCUMENTS: Array<{
  type: MissingDocumentType;
  label: string;
  prefix: string;
  field: (payload: MissingDocumentsPayload) => string | string[] | undefined;
}> = [
  { type: 'signed_agreement', label: 'Signed Contractor Agreement', prefix: 'SignedAgreement', field: (p) => p.signedContractorAgreement ?? p.uploadSigned49 },
  { type: 'w9', label: 'W-9', prefix: 'W9', field: (p) => p.w9 ?? p.q24_fileupload22 },
  { type: 'photo_id', label: 'Photo ID', prefix: 'PhotoID', field: (p) => p.photoId ?? p.q29_fileupload27 },
  { type: 'insurance', label: 'Insurance', prefix: 'Insurance', field: (p) => p.insurance ?? p.q30_fileupload28 },
  { type: 'other_document', label: 'Other Document', prefix: 'OtherDocument', field: (p) => p.otherDocument ?? p.q31_fileupload29 },
];

async function processFiles(params: {
  payload: MissingDocumentsPayload;
  row: MissingDocumentsSubmissionRow;
  contractorName: string;
}): Promise<MissingDocumentsSubmissionRow> {
  const claimed = await claimMissingDocumentsFileProcessing(params.row.id);
  if (!claimed) {
    const current = await getMissingDocumentsSubmission(params.row.jotform_submission_id);
    if (!current) throw new Error('Missing-documents submission disappeared during processing');
    return current;
  }

  try {
    const existingFolder = await findContractorOnboardingFolder(params.row.contractor_id);
    const airtableFolderUrl = await getContractorAirtableField(
      params.row.airtable_record_id,
      AT.DRIVE_FOLDER,
    );
    const folder = await resolveContractorFolder({
      existingFolderId: existingFolder?.drive_folder_id,
      existingFolderUrl: existingFolder?.drive_folder_url,
      airtableFolderUrl,
      legalName: params.contractorName,
      airtableRecordId: params.row.airtable_record_id,
    });

    const results: Record<string, MissingDocumentResult> = {};
    const safeSubmissionId = sanitizeFileName(params.row.jotform_submission_id).replace(/\s+/g, '-');
    for (const document of DOCUMENTS) {
      const sourceUrl = extractFileUrl(document.field(params.payload));
      if (!sourceUrl) {
        results[document.type] = {
          documentType: document.type,
          label: document.label,
          status: 'not_supplied',
        };
        continue;
      }

      const requestedName = `${document.prefix}_${params.row.airtable_record_id}_${safeSubmissionId}.pdf`;
      try {
        const uploaded = await downloadAndUploadFile({
          sourceUrl,
          fileName: requestedName,
          folderId: folder.id,
          jotformApiKey: config.JOTFORM_API_KEY,
        });
        results[document.type] = {
          documentType: document.type,
          label: document.label,
          status: 'uploaded',
          storedFileName: uploaded.storedFileName,
          detectedContentType: uploaded.detectedContentType,
          driveFileId: uploaded.id,
          driveFileUrl: uploaded.webViewLink,
        };
      } catch (error) {
        results[document.type] = {
          documentType: document.type,
          label: document.label,
          status: 'rejected',
          error: safeError(error),
        };
      }
    }

    const updated = await markMissingDocumentsFilesProcessed({
      rowId: params.row.id,
      folderId: folder.id,
      folderUrl: folder.webViewLink,
      documentResults: results,
    });
    if (!updated) throw new Error('Failed to persist missing-document upload results');
    return updated;
  } catch (error) {
    await markMissingDocumentsFilesFailed(params.row.id, safeError(error));
    throw error;
  }
}

function buildAirtableFields(
  row: MissingDocumentsSubmissionRow,
  currentStatuses: {
    onboardingDocumentStatus: string | null;
    missingDocsReviewStatus: string | null;
  },
): Record<string, unknown> {
  const documents = documentResultsFromRow(row);
  const byType = new Map(documents.map((doc) => [doc.documentType, doc]));
  const fields: Record<string, unknown> = {
    [AT.SUBMITTED_AT]: row.submitted_at,
    [AT.SUBMISSION_ID]: row.jotform_submission_id,
    [AT.DRIVE_FOLDER]: row.drive_folder_url,
  };
  if (
    currentStatuses.onboardingDocumentStatus !== APPROVED_FOR_ACTIVATION_REQUEST &&
    currentStatuses.onboardingDocumentStatus !== BLOCKED_ONBOARDING_DOCUMENT_STATUS
  ) {
    fields[AT.DOCUMENT_STATUS] = MISSING_DOCUMENTS_REVIEW_STATUS;
  }
  if (!TERMINAL_MISSING_DOCS_REVIEW_STATUSES.has(currentStatuses.missingDocsReviewStatus ?? '')) {
    fields[AT.MISSING_DOCS_REVIEW_STATUS] = MISSING_DOCS_AWAITING_REVIEW_STATUS;
  }
  if (byType.get('signed_agreement')?.status === 'uploaded') fields[AT.SIGNED_AGREEMENT] = true;
  if (byType.get('w9')?.status === 'uploaded') fields[AT.W9_RECEIVED] = true;
  if (byType.get('photo_id')?.status === 'uploaded') {
    fields[AT.PHOTO_ID_RECEIVED] = true;
    fields[AT.PHOTO_ID_FILE_LINK] = byType.get('photo_id')?.driveFileUrl;
  }
  return fields;
}

export async function processMissingDocumentsSubmission(
  payload: MissingDocumentsPayload,
): Promise<MissingDocumentsResult> {
  const configuredFormId = config.JOTFORM_MISSING_DOCS_FORM_ID?.trim();
  const formId = firstString(payload.formID);
  if (configuredFormId && formId && formId !== configuredFormId) {
    throw clientError(`Unexpected formID: ${formId}`, 400, 'WRONG_FORM_ID');
  }

  const airtableRecordId = firstString(payload.contractorRecord, payload.q34_contractorRecord);
  const contractorId = firstString(payload.backendContractor, payload.q35_backendContractor);
  const submissionId = firstString(payload.submissionID);
  if (!airtableRecordId) throw clientError('Missing contractorRecord', 422, 'MISSING_CONTRACTOR_RECORD');
  if (!contractorId) throw clientError('Missing backendContractor', 422, 'MISSING_BACKEND_CONTRACTOR_ID');
  if (!submissionId) throw clientError('Missing submissionID', 422, 'MISSING_SUBMISSION_ID');

  const contractor = await queryOne<{
    id: string;
    full_name: string;
    airtable_record_id: string | null;
  }>('SELECT id, full_name, airtable_record_id FROM contractors WHERE id = $1', [contractorId]);
  if (!contractor) throw clientError('Contractor not found', 404, 'CONTRACTOR_NOT_FOUND');
  if (!contractor.airtable_record_id || contractor.airtable_record_id !== airtableRecordId) {
    throw clientError('Backend contractor and Airtable record identity do not match', 409, 'CONTRACTOR_IDENTITY_MISMATCH');
  }

  const message = firstString(payload.contractorMessage, payload.correctionNote, payload.q40_questionsOr);
  const reserved = await reserveMissingDocumentsSubmission({
    contractorId,
    airtableRecordId,
    submissionId,
    formId: formId || null,
    submittedAt: submittedAt(payload),
    contractorMessage: message || null,
  });
  let row = reserved.row;
  if (row.contractor_id !== contractorId || row.airtable_record_id !== airtableRecordId) {
    throw clientError('Submission ID belongs to a different contractor identity', 409, 'SUBMISSION_IDENTITY_MISMATCH');
  }
  if (row.processing_status === 'completed') {
    return resultResponse(row, contractorId, 'duplicate');
  }

  if (!row.files_processed_at) {
    row = await processFiles({ payload, row, contractorName: contractor.full_name });
    if (!row.files_processed_at) return resultResponse(row, contractorId, 'duplicate');
  }

  if (!row.airtable_synced_at) {
    try {
      // Accepted limitation: Airtable has no compare-and-set in this adapter,
      // so an operator edit in the brief GET-to-PATCH interval could be overwritten.
      const currentStatuses = await getContractorMissingDocumentsStatuses(airtableRecordId);
      await updateContractorMissingDocumentsFields(
        airtableRecordId,
        buildAirtableFields(row, currentStatuses),
      );
      const synced = await markMissingDocumentsAirtableSynced(row.id);
      if (!synced) throw new Error('Failed to persist successful Airtable sync state');
      row = synced;
    } catch (error) {
      const reason = safeError(error);
      const failed = await markMissingDocumentsAirtableFailed(row.id, reason);
      if (failed) row = failed;
      logger.error({ submissionId, error: reason }, '[MissingDocuments] Airtable sync failed; retry remains available');
      return resultResponse(row, contractorId, 'retry_pending', [`Airtable sync failed: ${reason}`]);
    }
  }

  if (row.notification_status !== 'sent' && row.notification_status !== 'logged') {
    const claimed = await claimMissingDocumentsNotification(row.id);
    if (!claimed) {
      const current = await getMissingDocumentsSubmission(submissionId);
      return resultResponse(current ?? row, contractorId, 'duplicate');
    }
    row = claimed;
    const documents = documentResultsFromRow(row);
    try {
      const notification = await sendMissingDocumentsOperatorNotification({
        contractorName: contractor.full_name,
        contractorId,
        airtableRecordId,
        submissionId,
        submittedAt: row.submitted_at,
        receivedDocuments: documents.filter((doc) => doc.status === 'uploaded').map((doc) => doc.label),
        failedDocuments: documents.filter((doc) => doc.status === 'rejected').map((doc) => `${doc.label}: ${doc.error}`),
        contractorMessage: row.contractor_message,
        idempotencyKey: `missing-docs-${row.id}`,
      });
      const completed = await markMissingDocumentsNotificationComplete({
        rowId: row.id,
        mode: notification.mode,
        providerMessageId: notification.providerMessageId,
      });
      if (!completed) throw new Error('Failed to persist operator notification completion');
      row = completed;
    } catch (error) {
      const reason = safeError(error);
      const failed = await markMissingDocumentsNotificationFailed(row.id, reason);
      if (failed) row = failed;
      logger.error({ submissionId, error: reason }, '[MissingDocuments] Operator notification failed; retry remains available');
      return resultResponse(row, contractorId, 'retry_pending', [`Operator notification failed: ${reason}`]);
    }
  }

  return resultResponse(row, contractorId, 'processed');
}
