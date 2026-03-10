import 'dotenv/config';
import { createApp } from './app';
import { config } from './common/config';
import { logger } from './common/logger';
import { getPool, closePool } from './db/pool';
import { MIGRATIONS } from './db/embeddedMigrations';

// ---------------------------------------------------------------------------
// Auto-migration: SQL is embedded in TypeScript so it is always present in
// the compiled dist/ output — no file-system path resolution needed.
// Each migration is idempotent (IF NOT EXISTS guards + _migrations table).
// ---------------------------------------------------------------------------
async function runMigrations(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    // Tracking table — safe to run every startup
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         SERIAL PRIMARY KEY,
        filename   TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const migration of MIGRATIONS) {
      const { rows } = await client.query(
        'SELECT id FROM _migrations WHERE filename = $1',
        [migration.filename],
      );
      if (rows.length > 0) {
        logger.info(`[Migrate] Already applied: ${migration.filename}`);
        continue;
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
// Startup sequence: migrate → listen
// ---------------------------------------------------------------------------
async function start(): Promise<void> {
  logger.info('[AC-API] Running database migrations…');
  try {
    await runMigrations();
    logger.info('[AC-API] Migrations complete — starting HTTP server');
  } catch (migrationErr) {
    // Log the failure but do NOT crash — Render needs the HTTP server to
    // start so /health can respond. On a real Postgres DATABASE_URL this
    // path should never be hit; it only fires on transient connection errors.
    logger.error(
      { err: migrationErr },
      '[AC-API] Migration failed — server will start but DB may be unavailable. Check DATABASE_URL and Postgres connectivity.',
    );
  }

  const app = createApp();
  const PORT = config.PORT;

  const server = app.listen(PORT, () => {
    logger.info(`[AC-API] Assembly Concierge API v2.0.0 running on port ${PORT}`);
    logger.info(`[AC-API] Environment: ${config.NODE_ENV}`);
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
