DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'job_status'
      AND e.enumlabel = 'dispatch_ready'
  ) THEN
    ALTER TYPE job_status ADD VALUE 'dispatch_ready';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'job_status'
      AND e.enumlabel = 'completion_reported'
  ) THEN
    ALTER TYPE job_status ADD VALUE 'completion_reported';
  END IF;
END $$;
