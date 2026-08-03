import { queryOne } from '../../db/pool';

export type MissingDocumentsProcessingStatus =
  | 'pending'
  | 'processing_files'
  | 'files_failed'
  | 'files_processed'
  | 'airtable_synced'
  | 'completed';

export type MissingDocumentsNotificationStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'logged'
  | 'failed';

export interface MissingDocumentsSubmissionRow {
  id: string;
  contractor_id: string;
  airtable_record_id: string;
  jotform_submission_id: string;
  jotform_form_id: string | null;
  submitted_at: string | Date;
  contractor_message: string | null;
  drive_folder_id: string | null;
  drive_folder_url: string | null;
  document_results: Record<string, unknown>;
  processing_status: MissingDocumentsProcessingStatus;
  files_processed_at: string | null;
  processing_error: string | null;
  airtable_attempt_count: number;
  airtable_synced_at: string | null;
  airtable_error: string | null;
  notification_status: MissingDocumentsNotificationStatus;
  notification_attempt_count: number;
  notification_sent_at: string | null;
  notification_provider_message_id: string | null;
  notification_error: string | null;
}

export async function reserveMissingDocumentsSubmission(params: {
  contractorId: string;
  airtableRecordId: string;
  submissionId: string;
  formId?: string | null;
  submittedAt: string;
  contractorMessage?: string | null;
}): Promise<{ row: MissingDocumentsSubmissionRow; isNew: boolean }> {
  const inserted = await queryOne<MissingDocumentsSubmissionRow>(
    `INSERT INTO contractor_missing_document_submissions (
       contractor_id, airtable_record_id, jotform_submission_id,
       jotform_form_id, submitted_at, contractor_message
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (jotform_submission_id) DO NOTHING
     RETURNING *`,
    [
      params.contractorId,
      params.airtableRecordId,
      params.submissionId,
      params.formId ?? null,
      params.submittedAt,
      params.contractorMessage ?? null,
    ],
  );
  if (inserted) return { row: inserted, isNew: true };

  const existing = await getMissingDocumentsSubmission(params.submissionId);
  if (!existing) throw new Error('Submission reservation conflict could not be reloaded');
  return { row: existing, isNew: false };
}

export function getMissingDocumentsSubmission(
  submissionId: string,
): Promise<MissingDocumentsSubmissionRow | null> {
  return queryOne<MissingDocumentsSubmissionRow>(
    `SELECT * FROM contractor_missing_document_submissions
     WHERE jotform_submission_id = $1`,
    [submissionId],
  );
}

export function claimMissingDocumentsFileProcessing(
  rowId: string,
): Promise<MissingDocumentsSubmissionRow | null> {
  return queryOne<MissingDocumentsSubmissionRow>(
    `UPDATE contractor_missing_document_submissions
     SET processing_status = 'processing_files',
         file_processing_started_at = NOW(), processing_error = NULL, updated_at = NOW()
     WHERE id = $1
       AND files_processed_at IS NULL
       AND (
         processing_status IN ('pending', 'files_failed')
         OR (processing_status = 'processing_files'
             AND file_processing_started_at < NOW() - INTERVAL '15 minutes')
       )
     RETURNING *`,
    [rowId],
  );
}

export function markMissingDocumentsFilesProcessed(params: {
  rowId: string;
  folderId: string;
  folderUrl: string;
  documentResults: Record<string, unknown>;
}): Promise<MissingDocumentsSubmissionRow | null> {
  return queryOne<MissingDocumentsSubmissionRow>(
    `UPDATE contractor_missing_document_submissions
     SET drive_folder_id = $2, drive_folder_url = $3, document_results = $4::jsonb,
         processing_status = 'files_processed', files_processed_at = NOW(),
         processing_error = NULL, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [params.rowId, params.folderId, params.folderUrl, JSON.stringify(params.documentResults)],
  );
}

export function markMissingDocumentsFilesFailed(
  rowId: string,
  error: string,
): Promise<MissingDocumentsSubmissionRow | null> {
  return queryOne<MissingDocumentsSubmissionRow>(
    `UPDATE contractor_missing_document_submissions
     SET processing_status = 'files_failed', processing_error = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [rowId, error],
  );
}

export function markMissingDocumentsAirtableSynced(
  rowId: string,
): Promise<MissingDocumentsSubmissionRow | null> {
  return queryOne<MissingDocumentsSubmissionRow>(
    `UPDATE contractor_missing_document_submissions
     SET processing_status = 'airtable_synced', airtable_attempt_count = airtable_attempt_count + 1,
         airtable_synced_at = NOW(), airtable_error = NULL, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [rowId],
  );
}

export function markMissingDocumentsAirtableFailed(
  rowId: string,
  error: string,
): Promise<MissingDocumentsSubmissionRow | null> {
  return queryOne<MissingDocumentsSubmissionRow>(
    `UPDATE contractor_missing_document_submissions
     SET airtable_attempt_count = airtable_attempt_count + 1,
         airtable_error = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [rowId, error],
  );
}

export function claimMissingDocumentsNotification(
  rowId: string,
): Promise<MissingDocumentsSubmissionRow | null> {
  return queryOne<MissingDocumentsSubmissionRow>(
    `UPDATE contractor_missing_document_submissions
     SET notification_status = 'sending', notification_started_at = NOW(),
         notification_attempt_count = notification_attempt_count + 1,
         notification_error = NULL, updated_at = NOW()
     WHERE id = $1 AND airtable_synced_at IS NOT NULL
       AND (
         notification_status IN ('pending', 'failed')
         OR (notification_status = 'sending'
             AND notification_started_at < NOW() - INTERVAL '15 minutes')
       )
     RETURNING *`,
    [rowId],
  );
}

export function markMissingDocumentsNotificationComplete(params: {
  rowId: string;
  mode: 'sent' | 'logged';
  providerMessageId?: string;
}): Promise<MissingDocumentsSubmissionRow | null> {
  return queryOne<MissingDocumentsSubmissionRow>(
    `UPDATE contractor_missing_document_submissions
     SET notification_status = $2, notification_sent_at = NOW(),
         notification_provider_message_id = $3, notification_error = NULL,
         processing_status = 'completed', updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [params.rowId, params.mode, params.providerMessageId ?? null],
  );
}

export function markMissingDocumentsNotificationFailed(
  rowId: string,
  error: string,
): Promise<MissingDocumentsSubmissionRow | null> {
  return queryOne<MissingDocumentsSubmissionRow>(
    `UPDATE contractor_missing_document_submissions
     SET notification_status = 'failed', notification_error = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [rowId, error],
  );
}

export function findContractorOnboardingFolder(contractorId: string): Promise<{
  drive_folder_id: string | null;
  drive_folder_url: string | null;
} | null> {
  return queryOne(
    `SELECT drive_folder_id, drive_folder_url
     FROM (
       SELECT drive_folder_id, drive_folder_url, created_at
       FROM contractor_missing_document_submissions WHERE contractor_id = $1
       UNION ALL
       SELECT drive_folder_id, drive_folder_url, created_at
       FROM contractor_onboarding_documents WHERE contractor_id = $1
     ) folders
     WHERE drive_folder_id IS NOT NULL OR drive_folder_url IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [contractorId],
  );
}
