-- Add confirmed_at to uploaded_media for Phase 1.5 photo upload tracking
ALTER TABLE uploaded_media
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
