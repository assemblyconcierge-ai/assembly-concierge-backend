-- Assembly Concierge Backend — Seed Data
-- Migration 002: Initial service types, service areas, and pricing rules

-- ─────────────────────────────────────────────
-- SERVICE TYPES
-- ─────────────────────────────────────────────
INSERT INTO service_types (id, code, display_name, is_active) VALUES
  (gen_random_uuid(), 'small',     'Small Assembly',     TRUE),
  (gen_random_uuid(), 'medium',    'Medium Assembly',    TRUE),
  (gen_random_uuid(), 'large',     'Large Assembly',     TRUE),
  (gen_random_uuid(), 'treadmill', 'Treadmill Assembly', TRUE),
  (gen_random_uuid(), 'custom',    'Custom Job',         TRUE)
ON CONFLICT (code) DO NOTHING;

-- ─────────────────────────────────────────────
-- SERVICE AREAS
-- Initial in-area cities: Hampton, Stockbridge, McDonough (Georgia)
-- All others default to quote_only
-- ─────────────────────────────────────────────
INSERT INTO service_areas (id, city, state, is_active, serviceability_status) VALUES
  (gen_random_uuid(), 'Hampton',     'GA', TRUE, 'in_area'),
  (gen_random_uuid(), 'Stockbridge', 'GA', TRUE, 'in_area'),
  (gen_random_uuid(), 'McDonough',   'GA', TRUE, 'in_area')
ON CONFLICT (LOWER(city), state) DO NOTHING;

-- ─────────────────────────────────────────────
-- PRICING RULES
-- All prices in integer cents.
-- Small = $109.00 = 10900 cents (confirmed by user)
-- Medium, Large, Treadmill: placeholder values to be updated from
--   production config before cutover. Rush = $30 default.
-- Deposit = 50% of base price by default.
-- ─────────────────────────────────────────────
INSERT INTO pricing_rules (
  id, service_type_code, base_price_cents, rush_price_cents,
  default_deposit_cents, payout_cents, is_active
) VALUES
  (gen_random_uuid(), 'small',     10900, 3000, 5450, 6000, TRUE),
  (gen_random_uuid(), 'medium',    14900, 3000, 7450, 8000, TRUE),
  (gen_random_uuid(), 'large',     19900, 3000, 9950, 11000, TRUE),
  (gen_random_uuid(), 'treadmill', 14900, 3000, 7450, 8000, TRUE),
  (gen_random_uuid(), 'custom',        0, 0,    0,    0,    TRUE)
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────
-- CONFIG ENTRIES
-- ─────────────────────────────────────────────
INSERT INTO config_entries (config_group, config_key, config_value_json) VALUES
  ('pricing', 'deposit_percentage',     '50'),
  ('pricing', 'rush_label',             '"Same-Day Rush"'),
  ('intake',  'jotform_field_mapping',  '{"firstName":"q3_name[first]","lastName":"q3_name[last]","email":"q4_email","phone":"q5_phone","city":"q7_city","serviceType":"q8_serviceType","rushRequested":"q9_rush","appointmentDate":"q10_date","appointmentWindow":"q11_window","customDetails":"q12_customDetails"}'),
  ('notifications', 'admin_email',      '"admin@assemblyconcierge.com"')
ON CONFLICT (config_group, config_key) DO NOTHING;
