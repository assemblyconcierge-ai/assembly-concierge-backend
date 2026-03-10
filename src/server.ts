import 'dotenv/config';
import { createApp } from './app';
import { config } from './common/config';
import { logger } from './common/logger';
import { getPool, closePool } from './db/pool';
import { MIGRATIONS } from './db/embeddedMigrations';

// ---------------------------------------------------------------------------
// Schema readiness flag — set to true only after migrations AND verification
// pass. Used by /ready and the intake webhook route to refuse requests when
// the database schema is not in the expected state.
// ---------------------------------------------------------------------------
export let schemaReady = false;

// ---------------------------------------------------------------------------
// SCHEMA CONTRACT
// These are the minimum tables, columns, and indexes the API requires.
// All checks use pg_catalog views (pg_class, pg_attribute, pg_indexes) which
// are ALWAYS authoritative. information_schema views have visibility rules
// that can return stale data immediately after DDL in some Postgres configs.
// ---------------------------------------------------------------------------
const REQUIRED_TABLES = [
  'customers',
  'addresses',
  'intake_submissions',
  'service_types',
  'service_areas',
  'pricing_rules',
  'contractors',
  'jobs',
  'payments',
  'payment_events',
  'audit_events',
];

const REQUIRED_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'customers',          column: 'phone_e164' },
  { table: 'customers',          column: 'email' },
  { table: 'customers',          column: 'first_name' },
  { table: 'intake_submissions', column: 'idempotency_key' },
  { table: 'intake_submissions', column: 'raw_payload_json' },
  { table: 'intake_submissions', column: 'processing_status' },
  { table: 'jobs',               column: 'total_amount_cents' },
  { table: 'jobs',               column: 'status' },
  { table: 'jobs',               column: 'city_detected' },
];

const REQUIRED_INDEXES = [
  'intake_submissions_idempotency_idx',
  'customers_email_idx',
  'jobs_job_key_idx',
];

// ---------------------------------------------------------------------------
// Table existence check using pg_class (authoritative, always current)
// ---------------------------------------------------------------------------
async function tableExists(client: import('pg').PoolClient, tableName: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
       AND   c.relname = $1
       AND   c.relkind = 'r'
     ) AS exists`,
    [tableName],
  );
  return rows[0].exists;
}

// ---------------------------------------------------------------------------
// Migration runner
// Runs all pending migrations in order. If a migration is recorded in
// _migrations but its key tables are missing (partial/failed previous run),
// it deletes the stale record and re-runs the migration.
// ---------------------------------------------------------------------------
async function runMigrations(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    // Tracking table — safe to run every startup
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         SERIAL      PRIMARY KEY,
        filename   TEXT        NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const migration of MIGRATIONS) {
      const { rows } = await client.query<{ id: number }>(
        'SELECT id FROM _migrations WHERE filename = $1',
        [migration.filename],
      );

      if (rows.length > 0) {
        // Migration is recorded — but for 001, verify the tables actually exist.
        // This handles the case where a previous deploy recorded the migration
        // in _migrations but the actual DDL failed (partial apply).
        if (migration.filename === '001_initial_schema.sql') {
          const exists = await tableExists(client, 'intake_submissions');
          if (!exists) {
            logger.warn(
              `[Migrate] ${migration.filename} is recorded but intake_submissions is missing — re-running migration`,
            );
            await client.query('DELETE FROM _migrations WHERE filename = $1', [migration.filename]);
            // Fall through to the apply block below
          } else {
            logger.info(`[Migrate] Already applied: ${migration.filename}`);
            continue;
          }
        } else {
          logger.info(`[Migrate] Already applied: ${migration.filename}`);
          continue;
        }
      }

      logger.info(`[Migrate] Applying: ${migration.filename}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO _migrations (filename) VALUES ($1)',
          [migration.filename],
        );
        await client.query('COMMIT');
        logger.info(`[Migrate] Applied: ${migration.filename}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    logger.info('[Migrate] All migrations complete');
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Schema verifier
// Runs after migrations. Checks that all required tables, columns, and
// indexes exist using pg_catalog views (always authoritative).
// Returns a list of missing items (empty = all good).
// ---------------------------------------------------------------------------
async function verifySchema(): Promise<string[]> {
  const pool = getPool();
  const missing: string[] = [];

  // Check tables via pg_class
  for (const table of REQUIRED_TABLES) {
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
         AND   c.relname = $1
         AND   c.relkind = 'r'
       ) AS exists`,
      [table],
    );
    if (!rows[0].exists) missing.push(`TABLE: ${table}`);
  }

  // Check columns via pg_attribute
  for (const { table, column } of REQUIRED_COLUMNS) {
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
         AND   c.relname = $1
         AND   a.attname = $2
         AND   a.attnum > 0
         AND   NOT a.attisdropped
       ) AS exists`,
      [table, column],
    );
    if (!rows[0].exists) missing.push(`COLUMN: ${table}.${column}`);
  }

  // Check indexes via pg_indexes
  for (const idx of REQUIRED_INDEXES) {
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = $1
       ) AS exists`,
      [idx],
    );
    if (!rows[0].exists) missing.push(`INDEX: ${idx}`);
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Startup sequence: migrate → verify schema → listen
// ---------------------------------------------------------------------------
async function start(): Promise<void> {
  logger.info('[AC-API] Running database migrations…');
  try {
    await runMigrations();
    logger.info('[AC-API] Migrations complete — verifying schema contract…');

    const missing = await verifySchema();
    if (missing.length > 0) {
      logger.error(
        { missing },
        '[AC-API] SCHEMA VERIFICATION FAILED — the following required items are missing:',
      );
      missing.forEach((item) => logger.error(`[Schema] MISSING: ${item}`));
      logger.error(
        '[AC-API] Server will start but /ready will return 503 and webhook routes will reject requests.',
      );
      schemaReady = false;
    } else {
      logger.info('[AC-API] Schema verification passed — all required tables, columns, and indexes present');
      schemaReady = true;
    }
  } catch (migrationErr) {
    logger.error(
      { err: migrationErr },
      '[AC-API] Migration/verification failed — server will start but DB may be unavailable.',
    );
    schemaReady = false;
  }

  const app = createApp();
  const PORT = config.PORT;

  const server = app.listen(PORT, () => {
    logger.info(`[AC-API] Assembly Concierge API v2.0.0 running on port ${PORT}`);
    logger.info(`[AC-API] Environment: ${config.NODE_ENV}`);
    logger.info(`[AC-API] Schema ready: ${schemaReady}`);
    logger.info(`[AC-API] Health: http://localhost:${PORT}/health`);
  });

  async function shutdown(signal: string): Promise<void> {
    logger.info(`[AC-API] ${signal} received — shutting down gracefully`);
    server.close(async () => {
      await closePool();
      logger.info('[AC-API] Server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('uncaughtException', (err) => {
  logger.error({ err }, '[AC-API] Uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[AC-API] Unhandled rejection');
  process.exit(1);
});

start().catch((err) => {
  logger.error({ err }, '[AC-API] Startup failed');
  process.exit(1);
});
