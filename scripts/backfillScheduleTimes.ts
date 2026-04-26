/**
 * scripts/backfillScheduleTimes.ts
 *
 * Backfill scheduled_start_at, scheduled_end_at, and timezone for existing jobs
 * that have appointment_date and appointment_window but null schedule fields.
 *
 * Usage:
 *   tsx scripts/backfillScheduleTimes.ts          # dry-run (default) — preview only, no DB writes
 *   tsx scripts/backfillScheduleTimes.ts --apply  # live run — writes to DB
 *
 * Safe to re-run: only touches rows where scheduled_start_at IS NULL OR scheduled_end_at IS NULL.
 */

import 'dotenv/config';
import { getPool, closePool } from '../src/db/pool';
import { parseSchedule } from '../src/common/utils/scheduleUtils';
import { logger } from '../src/common/logger';

const DRY_RUN = !process.argv.includes('--apply');
const DEFAULT_TIMEZONE = 'America/New_York';

interface JobRow {
  id: string;
  job_key: string;
  appointment_date: string; // DATE comes back as string from pg when not parsed
  appointment_window: string;
  timezone: string | null;
}

async function backfill(): Promise<void> {
  const log = logger.child({ script: 'backfillScheduleTimes', dryRun: DRY_RUN });
  log.info(DRY_RUN ? 'DRY-RUN mode (default) — no DB writes will occur. Pass --apply to write.' : 'LIVE mode (--apply) — DB will be updated');

  const pool = getPool();
  const client = await pool.connect();

  try {
    const { rows } = await client.query<JobRow>(`
      SELECT id, job_key, appointment_date::text, appointment_window, timezone
      FROM jobs
      WHERE appointment_date  IS NOT NULL
        AND appointment_window IS NOT NULL
        AND (scheduled_start_at IS NULL OR scheduled_end_at IS NULL)
      ORDER BY created_at ASC
    `);

    log.info({ count: rows.length }, `Found ${rows.length} job(s) to backfill`);

    if (rows.length === 0) {
      log.info('Nothing to backfill — exiting');
      return;
    }

    let succeeded = 0;
    let failed = 0;

    for (const row of rows) {
      const tz = row.timezone ?? DEFAULT_TIMEZONE;
      try {
        const { scheduledStartAt, scheduledEndAt } = parseSchedule(
          row.appointment_date,
          row.appointment_window,
          tz,
        );

        if (DRY_RUN) {
          log.info({
            job_key: row.job_key,
            appointment_date: row.appointment_date,
            appointment_window: row.appointment_window,
            timezone: tz,
            scheduledStartAt,
            scheduledEndAt,
            action: 'DRY_RUN (default) — would update; pass --apply to write',
          }, `[DRY-RUN] ${row.job_key}`);
        } else {
          await client.query(
            `UPDATE jobs
             SET scheduled_start_at = $1,
                 scheduled_end_at   = $2,
                 timezone           = $3,
                 updated_at         = NOW()
             WHERE id = $4`,
            [scheduledStartAt, scheduledEndAt, tz, row.id],
          );
          log.info({
            job_key: row.job_key,
            appointment_date: row.appointment_date,
            appointment_window: row.appointment_window,
            timezone: tz,
            scheduledStartAt,
            scheduledEndAt,
            action: 'updated',
          }, `Updated ${row.job_key}`);
        }
        succeeded++;
      } catch (err) {
        failed++;
        log.warn({
          job_key: row.job_key,
          appointment_date: row.appointment_date,
          appointment_window: row.appointment_window,
          err,
        }, `Failed to parse schedule for ${row.job_key} — skipping`);
      }
    }

    log.info(
      { total: rows.length, succeeded, failed, dryRun: DRY_RUN },
      `Backfill complete: ${succeeded} succeeded, ${failed} failed`,
    );
  } finally {
    client.release();
    await closePool();
  }
}

backfill().catch((err) => {
  logger.error({ err }, 'Backfill script crashed');
  process.exit(1);
});
