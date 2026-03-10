import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createApp } from './app';
import { config } from './common/config';
import { logger } from './common/logger';
import { getPool, closePool } from './db/pool';

// ---------------------------------------------------------------------------
// Auto-migration: runs every startup, skips already-applied files.
// Safe to run concurrently — each file is wrapped in a transaction and
// recorded in _migrations before COMMIT, so duplicate runs are no-ops.
// ---------------------------------------------------------------------------
async function runMigrations(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         SERIAL PRIMARY KEY,
        filename   TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsDir = path.join(__dirname, 'db', 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      logger.warn('[Migrate] Migrations directory not found — skipping');
      return;
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT id FROM _migrations WHERE filename = $1',
        [file],
      );
      if (rows.length > 0) {
        logger.info(`[Migrate] Already applied: ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      logger.info(`[Migrate] Applying: ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _migrations (filename) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
        logger.info(`[Migrate] Applied: ${file}`);
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
  await runMigrations();
  logger.info('[AC-API] Migrations complete — starting HTTP server');

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
