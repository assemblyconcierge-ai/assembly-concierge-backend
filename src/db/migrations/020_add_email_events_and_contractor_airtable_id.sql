-- Migration 020: add email_events table and airtable_record_id to contractors.
--
-- email_events: canonical log of every outbound email attempt.
-- Used for idempotency (one send per event_type/job or event_type/contractor)
-- and for operator visibility into email delivery status.
--
-- contractors.airtable_record_id: persists the Airtable record ID so the
-- backend can generate contractor-specific Jotform prefill URLs without
-- requiring the caller to re-supply the Airtable ID on every request.

CREATE TABLE IF NOT EXISTS email_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_email         TEXT NOT NULL,
  recipient_type          TEXT NOT NULL CHECK (recipient_type IN ('customer', 'contractor')),
  event_type              TEXT NOT NULL,
  related_job_id          UUID REFERENCES jobs(id) ON DELETE SET NULL,
  related_contractor_id   UUID REFERENCES contractors(id) ON DELETE SET NULL,
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'sent', 'failed')),
  provider_message_id     TEXT,
  error_message           TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at                 TIMESTAMPTZ
);

-- One row per (event_type, job) regardless of status.
-- Reserves the event on INSERT so concurrent requests cannot create duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS email_events_job_event_type_idx
  ON email_events(event_type, related_job_id)
  WHERE related_job_id IS NOT NULL;

-- One row per (event_type, contractor) regardless of status.
CREATE UNIQUE INDEX IF NOT EXISTS email_events_contractor_event_type_idx
  ON email_events(event_type, related_contractor_id)
  WHERE related_contractor_id IS NOT NULL;

ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS airtable_record_id TEXT;
