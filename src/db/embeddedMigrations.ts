/**
 * Embedded SQL migrations — compiled into dist/ so they are always available
 * at runtime on Render (and any other host) without needing to copy .sql files.
 *
 * To add a new migration: append a new entry to the MIGRATIONS array.
 * The filename is used as the idempotency key in the _migrations table.
 */

export interface Migration {
  filename: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    filename: '001_initial_schema.sql',
    sql: `
-- Assembly Concierge Backend — Initial Schema
-- Migration 001: Full initial schema per Build Specification
-- All monetary values stored as integer cents.

-- ENUMS (use IF NOT EXISTS guard so re-runs are safe)
DO $$ BEGIN
  CREATE TYPE job_status AS ENUM (
    'intake_received','intake_validated','quoted_outside_area',
    'awaiting_payment','deposit_paid','paid_in_full','ready_for_dispatch',
    'dispatch_in_progress','assigned','scheduled','work_completed',
    'awaiting_remainder_payment','closed_paid','cancelled','error_review'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM (
    'unpaid','checkout_created','deposit_paid','paid_in_full',
    'partially_paid','remainder_due','remainder_paid',
    'payment_failed','refunded','voided'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE dispatch_status AS ENUM (
    'not_ready','ready','sent','accepted','declined','expired','assigned','failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE service_area_status AS ENUM ('in_area','quote_only','blocked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_mode AS ENUM ('full','deposit','quote_only','custom_review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_type AS ENUM ('full','deposit','remainder');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_status AS ENUM ('pending','sent','failed','retrying','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_channel AS ENUM ('email','sms');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE actor_type AS ENUM ('system','admin','provider','customer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE intake_processing_status AS ENUM ('received','processing','processed','failed','duplicate');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE contractor_assignment_status AS ENUM ('pending','accepted','declined','completed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CORE TABLES

CREATE TABLE IF NOT EXISTS customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  full_name       TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone_e164      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_email_idx ON customers(email);
CREATE INDEX IF NOT EXISTS customers_phone_idx ON customers(phone_e164);

CREATE TABLE IF NOT EXISTS addresses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line1           TEXT NOT NULL,
  line2           TEXT,
  city            TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'GA',
  postal_code     TEXT,
  country         TEXT NOT NULL DEFAULT 'US',
  latitude        NUMERIC(10,7),
  longitude       NUMERIC(10,7),
  normalized_text TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS addresses_city_idx ON addresses(city);

CREATE TABLE IF NOT EXISTS intake_submissions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source                  TEXT NOT NULL DEFAULT 'jotform',
  external_submission_id  TEXT NOT NULL,
  raw_payload_json        JSONB NOT NULL,
  normalized_payload_json JSONB,
  received_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at            TIMESTAMPTZ,
  processing_status       intake_processing_status NOT NULL DEFAULT 'received',
  idempotency_key         TEXT NOT NULL,
  correlation_id          TEXT NOT NULL,
  error_message           TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS intake_submissions_idempotency_idx ON intake_submissions(idempotency_key);
CREATE INDEX IF NOT EXISTS intake_submissions_external_id_idx ON intake_submissions(external_submission_id);

CREATE TABLE IF NOT EXISTS service_types (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS service_types_code_idx ON service_types(code);

CREATE TABLE IF NOT EXISTS service_areas (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city                  TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'GA',
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  serviceability_status service_area_status NOT NULL DEFAULT 'in_area',
  notes                 TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS service_areas_city_state_idx ON service_areas(LOWER(city), state);

CREATE TABLE IF NOT EXISTS pricing_rules (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type_code     TEXT NOT NULL,
  base_price_cents      INTEGER NOT NULL CHECK (base_price_cents >= 0),
  rush_price_cents      INTEGER NOT NULL DEFAULT 0 CHECK (rush_price_cents >= 0),
  default_deposit_cents INTEGER,
  payout_cents          INTEGER,
  active_from           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_to             TIMESTAMPTZ,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS pricing_rules_code_active_idx ON pricing_rules(service_type_code, is_active);

CREATE TABLE IF NOT EXISTS contractors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   TEXT NOT NULL,
  phone_e164  TEXT NOT NULL,
  email       TEXT,
  city        TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_key                 TEXT NOT NULL,
  customer_id             UUID NOT NULL REFERENCES customers(id),
  address_id              UUID NOT NULL REFERENCES addresses(id),
  intake_submission_id    UUID REFERENCES intake_submissions(id),
  service_type_id         UUID REFERENCES service_types(id),
  source_channel          TEXT NOT NULL DEFAULT 'jotform',
  service_area_status     service_area_status NOT NULL DEFAULT 'in_area',
  city_detected           TEXT,
  rush_requested          BOOLEAN NOT NULL DEFAULT FALSE,
  payment_mode            payment_mode NOT NULL DEFAULT 'full',
  subtotal_amount_cents   INTEGER NOT NULL DEFAULT 0,
  rush_amount_cents       INTEGER NOT NULL DEFAULT 0,
  deposit_amount_cents    INTEGER NOT NULL DEFAULT 0,
  remainder_amount_cents  INTEGER NOT NULL DEFAULT 0,
  total_amount_cents      INTEGER NOT NULL DEFAULT 0,
  status                  job_status NOT NULL DEFAULT 'intake_received',
  appointment_date        DATE,
  appointment_window      TEXT,
  special_instructions    TEXT,
  custom_job_details      TEXT,
  public_pay_token        TEXT,
  airtable_record_id      TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_job_key_idx ON jobs(job_key);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_public_pay_token_idx ON jobs(public_pay_token) WHERE public_pay_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_customer_id_idx ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS payments (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                      UUID NOT NULL REFERENCES jobs(id),
  payment_type                payment_type NOT NULL,
  provider                    TEXT NOT NULL DEFAULT 'stripe',
  provider_session_id         TEXT,
  provider_payment_intent_id  TEXT,
  amount_due_cents            INTEGER NOT NULL,
  amount_paid_cents           INTEGER NOT NULL DEFAULT 0,
  currency                    TEXT NOT NULL DEFAULT 'usd',
  status                      payment_status NOT NULL DEFAULT 'unpaid',
  checkout_url                TEXT,
  paid_at                     TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payments_job_id_idx ON payments(job_id);
CREATE INDEX IF NOT EXISTS payments_provider_session_idx ON payments(provider_session_id) WHERE provider_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_provider_intent_idx ON payments(provider_payment_intent_id) WHERE provider_payment_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id        UUID NOT NULL REFERENCES payments(id),
  provider_event_id TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  payload_json      JSONB NOT NULL,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idempotency_key   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_events_idempotency_idx ON payment_events(idempotency_key);
CREATE INDEX IF NOT EXISTS payment_events_payment_id_idx ON payment_events(payment_id);

CREATE TABLE IF NOT EXISTS uploaded_media (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID NOT NULL REFERENCES jobs(id),
  source_file_url   TEXT,
  storage_key       TEXT,
  mime_type         TEXT,
  original_filename TEXT,
  file_size_bytes   BIGINT,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS uploaded_media_job_id_idx ON uploaded_media(job_id);

CREATE TABLE IF NOT EXISTS dispatches (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                    UUID NOT NULL REFERENCES jobs(id),
  status                    dispatch_status NOT NULL DEFAULT 'not_ready',
  sent_at                   TIMESTAMPTZ,
  accepted_at               TIMESTAMPTZ,
  assigned_contractor_id    UUID REFERENCES contractors(id),
  provider_message_group_id TEXT,
  last_error                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dispatches_job_id_idx ON dispatches(job_id);
CREATE INDEX IF NOT EXISTS dispatches_status_idx ON dispatches(status);

CREATE TABLE IF NOT EXISTS contractor_assignments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              UUID NOT NULL REFERENCES jobs(id),
  contractor_id       UUID NOT NULL REFERENCES contractors(id),
  dispatch_id         UUID REFERENCES dispatches(id),
  payout_amount_cents INTEGER NOT NULL DEFAULT 0,
  assigned_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at         TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  status              contractor_assignment_status NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS contractor_assignments_job_id_idx ON contractor_assignments(job_id);
CREATE INDEX IF NOT EXISTS contractor_assignments_contractor_id_idx ON contractor_assignments(contractor_id);

CREATE TABLE IF NOT EXISTS notifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              UUID REFERENCES jobs(id),
  channel             notification_channel NOT NULL,
  template_key        TEXT NOT NULL,
  recipient           TEXT NOT NULL,
  payload_json        JSONB NOT NULL DEFAULT '{}',
  provider_message_id TEXT,
  status              notification_status NOT NULL DEFAULT 'pending',
  sent_at             TIMESTAMPTZ,
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_job_id_idx ON notifications(job_id);
CREATE INDEX IF NOT EXISTS notifications_status_idx ON notifications(status);

CREATE TABLE IF NOT EXISTS audit_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type      TEXT NOT NULL,
  aggregate_id        TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  actor_type          actor_type NOT NULL DEFAULT 'system',
  event_payload_json  JSONB NOT NULL DEFAULT '{}',
  correlation_id      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_events_aggregate_idx ON audit_events(aggregate_type, aggregate_id);
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS integration_failures (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_name    TEXT NOT NULL,
  related_entity_type TEXT,
  related_entity_id   TEXT,
  operation_name      TEXT NOT NULL,
  payload_json        JSONB NOT NULL DEFAULT '{}',
  error_message       TEXT NOT NULL,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  next_retry_at       TIMESTAMPTZ,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS integration_failures_unresolved_idx ON integration_failures(resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS integration_failures_entity_idx ON integration_failures(related_entity_type, related_entity_id);

CREATE TABLE IF NOT EXISTS config_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_group      TEXT NOT NULL,
  config_key        TEXT NOT NULL,
  config_value_json JSONB NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS config_entries_group_key_idx ON config_entries(config_group, config_key);
`,
  },
  {
    filename: '002_seed_data.sql',
    sql: `
-- Assembly Concierge Backend — Seed Data
-- Migration 002: Initial service types, service areas, and pricing rules

INSERT INTO service_types (id, code, display_name, is_active) VALUES
  (gen_random_uuid(), 'small',     'Small Assembly',     TRUE),
  (gen_random_uuid(), 'medium',    'Medium Assembly',    TRUE),
  (gen_random_uuid(), 'large',     'Large Assembly',     TRUE),
  (gen_random_uuid(), 'treadmill', 'Treadmill Assembly', TRUE),
  (gen_random_uuid(), 'custom',    'Custom Job',         TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO service_areas (id, city, state, is_active, serviceability_status) VALUES
  (gen_random_uuid(), 'Hampton',     'GA', TRUE, 'in_area'),
  (gen_random_uuid(), 'Stockbridge', 'GA', TRUE, 'in_area'),
  (gen_random_uuid(), 'McDonough',   'GA', TRUE, 'in_area')
ON CONFLICT (LOWER(city), state) DO NOTHING;

-- Small = $109.00 = 10900 cents (confirmed). Rush = $30 = 3000 cents.
-- Deposit = 50% of base. Update medium/large/treadmill before cutover.
INSERT INTO pricing_rules (
  id, service_type_code, base_price_cents, rush_price_cents,
  default_deposit_cents, payout_cents, is_active
) VALUES
  (gen_random_uuid(), 'small',     10900, 3000, 5450,  6000,  TRUE),
  (gen_random_uuid(), 'medium',    14900, 3000, 7450,  8000,  TRUE),
  (gen_random_uuid(), 'large',     19900, 3000, 9950,  11000, TRUE),
  (gen_random_uuid(), 'treadmill', 14900, 3000, 7450,  8000,  TRUE),
  (gen_random_uuid(), 'custom',        0,    0,    0,     0,  TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO config_entries (config_group, config_key, config_value_json) VALUES
  ('pricing', 'deposit_percentage',    '50'),
  ('pricing', 'rush_label',            '"Same-Day Rush"'),
  ('intake',  'jotform_field_mapping', '{"firstName":"q3_name[first]","lastName":"q3_name[last]","email":"q4_email","phone":"q5_phone","city":"q7_city","serviceType":"q8_serviceType","rushRequested":"q9_rush","appointmentDate":"q10_date","appointmentWindow":"q11_window","customDetails":"q12_customDetails"}'),
  ('notifications', 'admin_email',     '"admin@assemblyconcierge.com"')
ON CONFLICT (config_group, config_key) DO NOTHING;
`,
  },
  {
    filename: '003_fix_pricing.sql',
    sql: `
-- Assembly Concierge Backend -- Pricing Corrections
-- Migration 003: Fix seeded pricing_rules to match Airtable financial spec (2026-03-13)
--
-- Fix 1: Small Assembly contractor payout was $60, must be $55
-- Fix 2: Treadmill Assembly base price was $149, must be $189
--        Treadmill deposit was $74.50 (50% of wrong $149), must be $94.50 (50% of $189)
--        Treadmill contractor payout was $80, must be $130
-- Fix 3: All non-custom deposit amounts set to fixed $25 (was 50% of base)
--
-- These UPDATE statements are idempotent -- safe to re-run.

UPDATE pricing_rules
  SET payout_cents = 5500
  WHERE service_type_code = 'small'
    AND is_active = TRUE;

UPDATE pricing_rules
  SET base_price_cents      = 18900,
      default_deposit_cents = 9450,
      payout_cents          = 13000
  WHERE service_type_code = 'treadmill'
    AND is_active = TRUE;

UPDATE pricing_rules
  SET default_deposit_cents = 2500
  WHERE service_type_code IN ('small', 'medium', 'large', 'treadmill')
    AND is_active = TRUE;

UPDATE config_entries
  SET config_value_json = '25'
  WHERE config_group = 'pricing'
    AND config_key    = 'deposit_percentage';
`,
  },
];
