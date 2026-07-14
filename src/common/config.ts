import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),

  // Database
  DATABASE_URL: z.string().optional(),

  // Redis (optional — queues degrade gracefully without it)
  REDIS_URL: z.string().optional(),

  // Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Airtable
  AIRTABLE_API_KEY: z.string().optional(),
  AIRTABLE_BASE_ID: z.string().optional(),
  AIRTABLE_TABLE_JOBS: z.string().default('Backend Intake Sandbox V2'),
  // Child table for payment transaction rows linked to the jobs parent table
  AIRTABLE_TABLE_PAYMENTS: z.string().default('Payments'),

  // Email — Resend
  // RESEND_API_KEY: set in Render env vars
  // CUSTOMER_EMAIL_FROM: e.g. "Assembly Concierge <support@notifications.assemblyconcierge.com>"
  // CUSTOMER_EMAIL_REPLY_TO: e.g. "support@assemblyconcierge.com"
  RESEND_API_KEY: z.string().optional(),
  CUSTOMER_EMAIL_FROM: z.string().default('Assembly Concierge <support@notifications.assemblyconcierge.com>'),
  CUSTOMER_EMAIL_REPLY_TO: z.string().default('support@assemblyconcierge.com'),
  // EMAIL_SEND_MODE controls whether emails are actually sent via Resend.
  // 'log_only' (default): generate payload, log event, do NOT call Resend.
  // 'send': call Resend, record provider_message_id and sent_at.
  EMAIL_SEND_MODE: z.enum(['log_only', 'send']).default('log_only'),

  // Jotform
  JOTFORM_ONBOARDING_FORM_ID: z.string().default('261801729818060'),

  // SMS
  SMS_PROVIDER_API_KEY: z.string().optional(),
  SMS_FROM: z.string().optional(),

  // Quo (OpenPhone-compatible) — outbound contractor SMS dispatch
  QUO_API_KEY: z.string().optional(),
  QUO_PHONE_NUMBER: z.string().optional(),       // E.164, e.g. +14705742191
  QUO_PHONE_NUMBER_ID: z.string().optional(),    // e.g. PNLQwgD2g3
  QUO_WEBHOOK_SIGNING_SECRET: z.string().optional(), // Base64 secret from Quo webhook details

  // Storage
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),
  STORAGE_ENDPOINT: z.string().optional(),

  // App
  APP_BASE_URL: z.string().default('http://localhost:3000'),
  // Frontend public URL — used for Stripe checkout redirect URLs.
  // Set to the customer-facing website domain (not the API domain).
  // Falls back to APP_BASE_URL if not set.
  FRONTEND_BASE_URL: z.string().optional(),
  // Comma-separated allowed CORS origins, for example:
  // "http://localhost:3000,https://staging.example.com"
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  ADMIN_JWT_SECRET: z.string().min(1),

  // Public booking launch guards
  PUBLIC_BOOKING_SAME_DAY_ENABLED: z.string().default('false'),
  PUBLIC_BOOKING_FALLBACK_CONTRACTOR_COUNT: z.coerce.number().int().positive().default(2),
  PUBLIC_BOOKING_UNITS_PER_CONTRACTOR_WINDOW: z.coerce.number().int().positive().default(2),
  PUBLIC_BOOKING_SMALL_UNITS: z.coerce.number().int().positive().default(1),
  PUBLIC_BOOKING_MEDIUM_UNITS: z.coerce.number().int().positive().default(1),
  PUBLIC_BOOKING_LARGE_UNITS: z.coerce.number().int().positive().default(2),
  PUBLIC_BOOKING_TREADMILL_UNITS: z.coerce.number().int().positive().default(2),

  // Webhook security
  JOTFORM_WEBHOOK_SECRET: z.string().optional(),
  MAKE_WEBHOOK_SECRET: z.string().optional(),
  // Contractor onboarding webhook — query token for Jotform direct webhook
  JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN: z.string().optional(),

  // Google Drive — Service Account credentials (base64-encoded JSON key)
  GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: z.string().optional(),
  GOOGLE_DRIVE_PARENT_FOLDER_ID: z.string().default('13UQ9eDCn9k2I19-BvijhFsfX2RcAqOBv'),

  // Jotform API key — for downloading protected files if needed
  JOTFORM_API_KEY: z.string().optional(),

  // Airtable — Contractors table (separate from Jobs table)
  AIRTABLE_TABLE_CONTRACTORS: z.string().default('tblQzDt6XtSSaFAlX'),

  // Validation / test routes — explicitly enabled outside production only
  ENABLE_TEST_ROUTES: z.string().optional(),

  // Owner alerting — POST alert payload here on final async failure
  // Accepts any HTTPS URL (Make.com scenario webhook, Zapier, Slack incoming webhook, etc.)
  ALERT_WEBHOOK_URL: z.string().url().optional(),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[Config] Invalid environment variables:', result.error.flatten());
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
export type Config = typeof config;
