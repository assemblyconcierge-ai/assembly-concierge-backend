-- Assembly Concierge Backend — Operator Photo Token
-- Migration 014: Add operator_photo_token column to jobs table
--
-- operator_photo_token is a scoped, read-only, opaque token used exclusively
-- to build the Airtable Operator Photo Link. It grants access only to the
-- photo review endpoint for the specific job it belongs to.
--
-- It must never be:
--   - logged
--   - returned in general API responses
--   - used to call admin routes or mutate state
--   - stored in Airtable (only the full URL is stored)
--
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS operator_photo_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_operator_photo_token_idx
  ON jobs (operator_photo_token)
  WHERE operator_photo_token IS NOT NULL;
