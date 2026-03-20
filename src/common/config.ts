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
  AIRTABLE_TABLE_JOBS: z.string().default('Jobs'),

  // Email
  EMAIL_PROVIDER_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('noreply@assemblyconcierge.com'),

  // SMS
  SMS_PROVIDER_API_KEY: z.string().optional(),
  SMS_FROM: z.string().optional(),

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
  ADMIN_JWT_SECRET: z.string().default('change-me-in-production'),

  // Webhook security
  JOTFORM_WEBHOOK_SECRET: z.string().optional(),
  MAKE_WEBHOOK_SECRET: z.string().optional(),

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
