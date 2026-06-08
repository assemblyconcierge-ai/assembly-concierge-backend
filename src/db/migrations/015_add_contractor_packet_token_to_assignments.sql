ALTER TABLE contractor_assignments
  ADD COLUMN IF NOT EXISTS contractor_packet_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS contractor_assignments_contractor_packet_token_idx
  ON contractor_assignments (contractor_packet_token)
  WHERE contractor_packet_token IS NOT NULL;
