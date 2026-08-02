-- Durable processing and notification state for the dedicated contractor
-- missing-documents webhook. Files remain in Google Drive; this table stores
-- only identifiers, safe metadata, outcomes, and retry state.
CREATE TABLE IF NOT EXISTS contractor_missing_document_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id UUID NOT NULL REFERENCES contractors(id),
  airtable_record_id TEXT NOT NULL,
  jotform_submission_id TEXT NOT NULL UNIQUE,
  jotform_form_id TEXT,
  submitted_at TIMESTAMPTZ NOT NULL,
  contractor_message TEXT,
  drive_folder_id TEXT,
  drive_folder_url TEXT,
  document_results JSONB NOT NULL DEFAULT '{}'::jsonb,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN (
      'pending', 'processing_files', 'files_failed', 'files_processed',
      'airtable_synced', 'completed'
    )),
  file_processing_started_at TIMESTAMPTZ,
  files_processed_at TIMESTAMPTZ,
  processing_error TEXT,
  airtable_attempt_count INTEGER NOT NULL DEFAULT 0,
  airtable_synced_at TIMESTAMPTZ,
  airtable_error TEXT,
  notification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (notification_status IN ('pending', 'sending', 'sent', 'logged', 'failed')),
  notification_attempt_count INTEGER NOT NULL DEFAULT 0,
  notification_started_at TIMESTAMPTZ,
  notification_sent_at TIMESTAMPTZ,
  notification_provider_message_id TEXT,
  notification_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS contractor_missing_docs_contractor_idx
  ON contractor_missing_document_submissions(contractor_id);
