-- Migration 019: add job-level customer contact snapshot fields.
-- Captures name, email, and phone at booking time so later upserts to the
-- shared customers record cannot silently change job-specific notifications.
-- All columns are nullable: existing jobs without snapshots fall back to the
-- live customers lookup at read time.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS customer_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS customer_email_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS customer_phone_snapshot TEXT;
