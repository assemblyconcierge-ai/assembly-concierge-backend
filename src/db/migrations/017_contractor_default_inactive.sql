-- Migration 017: change contractors.is_active DB default from TRUE to FALSE.
-- Existing rows are unaffected. Forward-only; no data change.
ALTER TABLE contractors ALTER COLUMN is_active SET DEFAULT FALSE;
