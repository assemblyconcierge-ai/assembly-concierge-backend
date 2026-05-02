/**
 * dispatchConflict.ts
 *
 * Shared schedule-overlap logic used by:
 *   - dispatchJobToContractor (inside a transaction, via a PoolClient)
 *   - checkContractorAvailability (read-only precheck, uses a standalone query)
 *
 * Design:
 *   - No writes. No SMS. No Airtable sync.
 *   - Accepts either a PoolClient (for use inside a transaction) or uses the
 *     standalone `query` helper (for the read-only precheck path).
 */
import { PoolClient } from 'pg';
import { query } from '../../db/pool';
import { parseSchedule } from '../../common/utils/scheduleUtils';
import { logger } from '../../common/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScheduleConflictRow {
  job_key: string;
  appointment_date: string | null;
  appointment_window: string | null;
}

export interface ResolvedSchedule {
  scheduledStart: Date;
  scheduledEnd: Date;
  appointmentDate: string | null;
  appointmentWindow: string | null;
}

export interface ConflictCheckResult {
  conflict: false;
  resolvedSchedule: ResolvedSchedule;
}

export interface ConflictFoundResult {
  conflict: true;
  conflictingJobKey: string;
  conflictingDate: string | null;
  conflictingWindow: string | null;
  resolvedSchedule: ResolvedSchedule;
}

export type ScheduleCheckResult = ConflictCheckResult | ConflictFoundResult;

// ── Shared conflict SQL ───────────────────────────────────────────────────────

const CONFLICT_SQL = `
  SELECT j.job_key,
         j.appointment_date::text AS appointment_date,
         j.appointment_window
    FROM contractor_assignments ca
    JOIN jobs j ON j.id = ca.job_id
   WHERE ca.contractor_id = $1
     AND ca.status IN ('pending', 'accepted')
     AND j.status IN (
           'ready_for_dispatch', 'dispatch_in_progress', 'assigned',
           'scheduled', 'dispatch_ready', 'completion_reported'
         )
     AND j.id <> $2
     AND (
       -- Mode A: time-range overlap (both jobs have computed timestamps)
       (
         j.scheduled_start_at IS NOT NULL
         AND j.scheduled_end_at IS NOT NULL
         AND j.scheduled_start_at < $4
         AND j.scheduled_end_at   > $3
       )
       OR
       -- Mode B: no computed times — same date + window (exact match)
       (
         j.scheduled_start_at IS NULL
         AND j.scheduled_end_at IS NULL
         AND j.appointment_date   = $5::date
         AND j.appointment_window = $6
       )
     )
   ORDER BY ca.assigned_at DESC
   LIMIT 1
`;

// ── Core helper ───────────────────────────────────────────────────────────────

/**
 * Resolve the schedule for a job and check for contractor conflicts.
 *
 * @param contractorId  UUID of the contractor to check
 * @param jobId         UUID of the job being dispatched/prechecked (excluded from self-conflict)
 * @param sr            Schedule row read from the jobs table
 * @param client        Optional PoolClient — if provided, runs inside the caller's transaction;
 *                      if omitted, uses the standalone `query` helper (read-only precheck)
 */
export async function checkScheduleConflict(
  contractorId: string,
  jobId: string,
  sr: {
    scheduled_start_at: Date | null;
    scheduled_end_at: Date | null;
    timezone: string | null;
    appointment_date: string | null;
    appointment_window: string | null;
  },
  client?: PoolClient,
): Promise<ScheduleCheckResult> {
  const tz = sr.timezone ?? 'America/New_York';
  let scheduledStart: Date;
  let scheduledEnd: Date;

  if (sr.scheduled_start_at && sr.scheduled_end_at) {
    scheduledStart = sr.scheduled_start_at;
    scheduledEnd   = sr.scheduled_end_at;
  } else {
    if (!sr.appointment_date || !sr.appointment_window) {
      throw Object.assign(
        new Error('Cannot check availability: job has no appointment schedule.'),
        { statusCode: 409, errorCode: 'SCHEDULE_PARSE_FAILED' },
      );
    }
    let parsed: { scheduledStartAt: Date; scheduledEndAt: Date };
    try {
      parsed = parseSchedule(sr.appointment_date, sr.appointment_window, tz);
    } catch {
      throw Object.assign(
        new Error('Cannot check availability: appointment schedule could not be parsed.'),
        { statusCode: 409, errorCode: 'SCHEDULE_PARSE_FAILED' },
      );
    }
    scheduledStart = parsed.scheduledStartAt;
    scheduledEnd   = parsed.scheduledEndAt;
  }

  const params = [
    contractorId,
    jobId,
    scheduledStart,
    scheduledEnd,
    sr.appointment_date,
    sr.appointment_window,
  ];

  // client.query returns QueryResult (.rows); standalone query() returns T[] directly
  const conflictRows: ScheduleConflictRow[] = client
    ? (await client.query<ScheduleConflictRow>(CONFLICT_SQL, params)).rows
    : await query<ScheduleConflictRow>(CONFLICT_SQL, params);

  const resolvedSchedule: ResolvedSchedule = {
    scheduledStart,
    scheduledEnd,
    appointmentDate: sr.appointment_date,
    appointmentWindow: sr.appointment_window,
  };

  if (conflictRows.length > 0) {
    const c = conflictRows[0];
    return {
      conflict: true,
      conflictingJobKey: c.job_key,
      conflictingDate: c.appointment_date,
      conflictingWindow: c.appointment_window,
      resolvedSchedule,
    } satisfies ConflictFoundResult;
  }

  return { conflict: false, resolvedSchedule } satisfies ConflictCheckResult;
}

// ── Read-only precheck ────────────────────────────────────────────────────────

export interface PrecheckResult {
  status: 'Available' | 'Conflict' | 'Missing Contractor' | 'Missing Schedule' | 'Error';
  available: boolean;
  note: string;
  conflictingJobKey: string | null;
  conflictWindow: string | null;
}

/**
 * Read-only availability precheck — no writes, no SMS, no Airtable sync.
 *
 * Returns a structured result suitable for direct JSON response.
 */
export async function checkContractorAvailability(
  jobId: string,
  contractorId: string,
  correlationId: string,
): Promise<PrecheckResult> {
  const log = logger.child({ correlationId, jobId, contractorId, service: 'precheck' });

  // Verify contractor exists and is active
  const contractorRows = await query<{ id: string; is_active: boolean }>(
    'SELECT id, is_active FROM contractors WHERE id = $1',
    [contractorId],
  );
  if (contractorRows.length === 0 || !contractorRows[0].is_active) {
    log.warn('[Precheck] Contractor not found or inactive');
    return {
      status: 'Missing Contractor',
      available: false,
      note: 'Contractor not found or is not active.',
      conflictingJobKey: null,
      conflictWindow: null,
    };
  }

  // Read job schedule fields
  const jobRows = await query<{
    id: string;
    scheduled_start_at: Date | null;
    scheduled_end_at: Date | null;
    timezone: string | null;
    appointment_date: string | null;
    appointment_window: string | null;
  }>(
    `SELECT id, scheduled_start_at, scheduled_end_at, timezone,
            appointment_date::text, appointment_window
       FROM jobs WHERE id = $1`,
    [jobId],
  );
  if (jobRows.length === 0) {
    return {
      status: 'Error',
      available: false,
      note: 'Job not found.',
      conflictingJobKey: null,
      conflictWindow: null,
    };
  }
  const sr = jobRows[0];

  // Check for missing schedule
  if (
    !sr.scheduled_start_at &&
    !sr.scheduled_end_at &&
    (!sr.appointment_date || !sr.appointment_window)
  ) {
    log.warn('[Precheck] Job has no usable schedule');
    return {
      status: 'Missing Schedule',
      available: false,
      note: 'Job has no appointment schedule. Cannot check availability.',
      conflictingJobKey: null,
      conflictWindow: null,
    };
  }

  try {
    const result = await checkScheduleConflict(contractorId, jobId, sr);

    if (result.conflict) {
      const conflictWindow =
        result.conflictingDate && result.conflictingWindow
          ? `${result.conflictingDate} ${result.conflictingWindow}`
          : result.conflictingDate ?? result.conflictingWindow ?? null;
      log.info(
        { conflictingJobKey: result.conflictingJobKey },
        '[Precheck] Contractor has a conflicting job',
      );
      return {
        status: 'Conflict',
        available: false,
        note: 'Contractor has an overlapping job during this appointment window.',
        conflictingJobKey: result.conflictingJobKey,
        conflictWindow,
      };
    }

    log.info('[Precheck] Contractor is available');
    return {
      status: 'Available',
      available: true,
      note: 'Contractor is available for this appointment window.',
      conflictingJobKey: null,
      conflictWindow: null,
    };
  } catch (err: any) {
    if (err?.errorCode === 'SCHEDULE_PARSE_FAILED') {
      return {
        status: 'Missing Schedule',
        available: false,
        note: err.message,
        conflictingJobKey: null,
        conflictWindow: null,
      };
    }
    log.error({ err }, '[Precheck] Unexpected error during availability check');
    return {
      status: 'Error',
      available: false,
      note: 'An unexpected error occurred during the availability check.',
      conflictingJobKey: null,
      conflictWindow: null,
    };
  }
}
