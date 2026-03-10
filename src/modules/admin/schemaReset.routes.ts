/**
 * Schema Reset Route — STRICTLY ONE-TIME USE
 *
 * POST /admin/reset-schema
 *   Header required: X-Reset-Token: <value of RESET_SCHEMA_TOKEN env var>
 *
 * Activation:
 *   - Only active when RESET_SCHEMA_TOKEN is set in the environment.
 *   - After one successful reset, the endpoint disables itself for the
 *     lifetime of the process (in-memory flag) AND deletes the env var
 *     from the process so subsequent calls within the same process also fail.
 *   - To permanently disable: remove RESET_SCHEMA_TOKEN from Render env vars
 *     and redeploy. The endpoint will return 404 when the env var is absent.
 *
 * Purpose:
 *   Recovers from a corrupted partial migration state on a managed Postgres
 *   instance where direct DB access is unavailable (e.g. Render free tier).
 *   Drops all application tables and _migrations so the next startup runs
 *   migrations from a completely empty schema.
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../../db/pool';
import { logger } from '../../common/logger';

export const schemaResetRouter = Router();

// In-memory one-time-use flag — set to true after a successful reset.
// Prevents a second call within the same process lifetime.
let resetAlreadyUsed = false;

// All application tables in reverse dependency order (children before parents)
const DROP_ORDER = [
  'integration_failures',
  'audit_events',
  'payment_events',
  'payments',
  'contractor_assignments',
  'dispatches',
  'notifications',
  'uploaded_media',
  'jobs',
  'intake_submissions',
  'addresses',
  'customers',
  'pricing_rules',
  'service_areas',
  'service_types',
  'contractors',
  'config_entries',
  '_migrations',
];

schemaResetRouter.post('/reset-schema', async (req: Request, res: Response) => {
  // ── Guard 1: env var must be present ──────────────────────────────────────
  const configuredToken = process.env.RESET_SCHEMA_TOKEN;
  if (!configuredToken) {
    // Return 404 so the endpoint is not discoverable when disabled
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found' });
  }

  // ── Guard 2: one-time-use flag ────────────────────────────────────────────
  if (resetAlreadyUsed) {
    return res.status(410).json({
      error: 'ALREADY_USED',
      message: 'Schema reset has already been used in this process. Remove RESET_SCHEMA_TOKEN from env vars and redeploy.',
    });
  }

  // ── Guard 3: token must match ─────────────────────────────────────────────
  const providedToken =
    (req.headers['x-reset-token'] as string | undefined) ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  if (!providedToken || providedToken !== configuredToken) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or missing X-Reset-Token header' });
  }

  // ── Perform the reset ─────────────────────────────────────────────────────
  const pool = getPool();
  const dropped: string[] = [];
  const skipped: string[] = [];

  try {
    for (const table of DROP_ORDER) {
      try {
        await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
        dropped.push(table);
        logger.info(`[SchemaReset] Dropped: ${table}`);
      } catch (err: any) {
        skipped.push(table);
        logger.warn(`[SchemaReset] Could not drop ${table}: ${err.message}`);
      }
    }

    // ── Self-disable: set flag AND remove token from process env ─────────────
    resetAlreadyUsed = true;
    delete process.env.RESET_SCHEMA_TOKEN;

    logger.info('[SchemaReset] Schema reset completed – next startup will run migrations from empty DB');
    logger.info('[SchemaReset] Endpoint is now disabled for this process. Remove RESET_SCHEMA_TOKEN env var and redeploy to permanently disable.');

    return res.status(200).json({
      status: 'reset_complete',
      message: 'Schema reset completed – next startup will run migrations from empty DB. Trigger a Render redeploy now.',
      dropped,
      skipped,
    });
  } catch (err: any) {
    logger.error({ err }, '[SchemaReset] Unexpected error during schema reset');
    return res.status(500).json({ error: err.message });
  }
});
