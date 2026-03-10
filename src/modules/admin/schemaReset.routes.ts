/**
 * Schema Reset Route — ONE-TIME USE ONLY
 *
 * POST /admin/reset-schema
 *   - Requires header: X-Reset-Token: <ADMIN_JWT_SECRET>
 *   - Drops ALL application tables and the _migrations tracking table
 *   - Does NOT restart the server — caller must trigger a Render redeploy
 *     after calling this endpoint so migrations re-run from scratch
 *
 * This endpoint exists solely to recover from a corrupted partial migration
 * state on a managed Postgres instance where direct DB access is unavailable.
 * Remove this route once the schema is stable.
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../../db/pool';
import { logger } from '../../common/logger';
import { config } from '../../common/config';

export const schemaResetRouter = Router();

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
  // Require the admin token — refuse if missing or wrong
  const token =
    (req.headers['x-reset-token'] as string | undefined) ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  if (!token || token !== config.ADMIN_JWT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — provide X-Reset-Token header' });
  }

  // Extra safety: refuse in production unless ALLOW_SCHEMA_RESET=true is set
  if (config.NODE_ENV === 'production' && process.env.ALLOW_SCHEMA_RESET !== 'true') {
    return res.status(403).json({
      error: 'Schema reset is disabled in production. Set ALLOW_SCHEMA_RESET=true env var to enable.',
    });
  }

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

    logger.info('[SchemaReset] Schema reset complete — redeploy the service to re-run migrations from scratch');

    return res.status(200).json({
      status: 'reset_complete',
      message: 'All application tables dropped. Trigger a Render redeploy now to re-run migrations from scratch.',
      dropped,
      skipped,
    });
  } catch (err: any) {
    logger.error({ err }, '[SchemaReset] Unexpected error during schema reset');
    return res.status(500).json({ error: err.message });
  }
});
