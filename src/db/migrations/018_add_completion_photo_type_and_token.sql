-- Migration 018: add photo_type to uploaded_media and contractor_completion_token to contractor_assignments.
--
-- uploaded_media.photo_type distinguishes customer intake photos ('intake') from
-- contractor completion photos ('completion'). DEFAULT 'intake' ensures all existing
-- rows are unaffected and the customer intake presign route does not need to change.
--
-- contractor_assignments.contractor_completion_token is a one-time opaque token
-- generated after DONE/FINISH. Used to scope the contractor completion upload landing
-- page and presign/confirm routes. COALESCE in the UPDATE prevents token rotation on
-- duplicate DONE/FINISH messages.

ALTER TABLE uploaded_media
  ADD COLUMN IF NOT EXISTS photo_type TEXT NOT NULL DEFAULT 'intake'
  CHECK (photo_type IN ('intake', 'completion'));

ALTER TABLE contractor_assignments
  ADD COLUMN IF NOT EXISTS contractor_completion_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS contractor_assignments_completion_token_idx
  ON contractor_assignments(contractor_completion_token)
  WHERE contractor_completion_token IS NOT NULL;
