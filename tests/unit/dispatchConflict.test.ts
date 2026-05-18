/**
 * Unit tests for checkScheduleConflict() and checkContractorAvailability()
 *
 * dispatchConflict.ts is pure query logic — no writes, no SMS, no Airtable.
 * All DB interaction is mocked; no real connection is used.
 *
 * checkScheduleConflict() has two execution paths:
 *   - With a PoolClient (dispatch path — runs inside caller's transaction)
 *   - Without a client (standalone query — read-only precheck path)
 *
 * In both paths the same CONFLICT_SQL is executed.  The function returns
 *   { conflict: true,  conflictingJobKey, ... }  when the query returns a row,
 *   { conflict: false, resolvedSchedule }          when the query returns empty.
 *
 * checkContractorAvailability() is the public precheck entry-point.  It issues
 * three consecutive standalone query() calls:
 *   call 1 → SELECT id, is_active FROM contractors WHERE id = $1
 *   call 2 → SELECT id, scheduled_start_at, … FROM jobs WHERE id = $1
 *   call 3 → CONFLICT_SQL (delegated to checkScheduleConflict without client)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist mock variables ──────────────────────────────────────────────────────
// mockQuery is used by the standalone (no-client) path in checkScheduleConflict
// and by all three query calls inside checkContractorAvailability.
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock('../../src/db/pool', () => ({
  query: mockQuery,
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../../src/common/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

import {
  checkScheduleConflict,
  checkContractorAvailability,
} from '../../src/modules/dispatch/dispatchConflict';

// ── Shared constants ──────────────────────────────────────────────────────────

const CONTRACTOR_ID = 'contractor-uuid-1';
const JOB_ID        = 'job-uuid-target';

// Morning window on 2026-06-01 (EDT = UTC-4): 8am–12pm EDT = 12:00Z–16:00Z
const MORNING_START = new Date('2026-06-01T12:00:00.000Z');
const MORNING_END   = new Date('2026-06-01T16:00:00.000Z');

// Evening window on same day: 4pm–8pm EDT = 20:00Z–00:00Z(+1)
const EVENING_START = new Date('2026-06-01T20:00:00.000Z');
const EVENING_END   = new Date('2026-06-02T00:00:00.000Z');

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Schedule row with pre-computed UTC timestamps (Mode A). */
function modeASchedule(start: Date, end: Date) {
  return {
    scheduled_start_at: start,
    scheduled_end_at:   end,
    timezone:           'America/New_York',
    appointment_date:   '2026-06-01',
    appointment_window: 'Morning(8am-12pm)',
  };
}

/** A CONFLICT_SQL result row representing a conflicting job in the DB. */
function conflictRow(jobKey = 'AC-2026-CONF') {
  return {
    job_key:            jobKey,
    appointment_date:   '2026-06-01',
    appointment_window: 'Morning(8am-12pm)',
  };
}

/**
 * Mock PoolClient for the transactional dispatch path.
 * client.query() always returns the supplied rows (wraps in { rows }).
 */
function makeClient(rows: object[]) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

beforeEach(() => {
  // clearAllMocks() clears call history but keeps mock implementations intact —
  // important because the logger mock's child() factory must survive across tests.
  // mockQuery's once-queue is drained explicitly inside setup() for the
  // checkContractorAvailability tests that use it.
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// checkScheduleConflict
// ─────────────────────────────────────────────────────────────────────────────

describe('checkScheduleConflict', () => {

  // ── Mode A: pre-computed timestamps ────────────────────────────────────────
  describe('Mode A — pre-computed scheduled_start_at / scheduled_end_at', () => {

    it('case 1: overlapping windows → conflict: true with conflicting job key', async () => {
      const client = makeClient([conflictRow('AC-2026-CONF')]);
      const sr     = modeASchedule(MORNING_START, MORNING_END);

      const result = await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client);

      expect(result.conflict).toBe(true);
      if (result.conflict) {
        expect(result.conflictingJobKey).toBe('AC-2026-CONF');
        expect(result.conflictingDate).toBe('2026-06-01');
        expect(result.conflictingWindow).toBe('Morning(8am-12pm)');
      }
    });

    it('case 2: non-overlapping windows → conflict: false', async () => {
      // DB returns empty because the new evening slot does not overlap morning.
      const client = makeClient([]);
      const sr     = modeASchedule(EVENING_START, EVENING_END);

      const result = await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client);

      expect(result.conflict).toBe(false);
    });

    it('case 3: existing assignment status pending → blocked (DB returns row)', async () => {
      // CONFLICT_SQL includes ca.status IN ('pending', 'accepted').
      // Simulates: existing assignment is 'pending' and the time windows overlap.
      const client = makeClient([conflictRow()]);
      const sr     = modeASchedule(MORNING_START, MORNING_END);

      const result = await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client);

      expect(result.conflict).toBe(true);
    });

    it('case 4: existing assignment status accepted → blocked (DB returns row)', async () => {
      // CONFLICT_SQL includes ca.status = 'accepted'.
      // Simulates: contractor already accepted a job in the same window.
      const client = makeClient([conflictRow()]);
      const sr     = modeASchedule(MORNING_START, MORNING_END);

      const result = await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client);

      expect(result.conflict).toBe(true);
    });

    it('case 5: existing assignment status cancelled → allows (DB returns empty)', async () => {
      // CONFLICT_SQL excludes ca.status = 'cancelled'.
      // Simulates: prior assignment was cancelled — not a blocker.
      const client = makeClient([]);
      const sr     = modeASchedule(MORNING_START, MORNING_END);

      const result = await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client);

      expect(result.conflict).toBe(false);
    });

    it('case 6: existing assignment status declined → allows (DB returns empty)', async () => {
      // CONFLICT_SQL excludes ca.status = 'declined'.
      // Simulates: contractor declined the previous dispatch — slot is free.
      const client = makeClient([]);
      const sr     = modeASchedule(MORNING_START, MORNING_END);

      const result = await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client);

      expect(result.conflict).toBe(false);
    });

    it('case 7: existing job status assigned → blocked (DB returns row)', async () => {
      // CONFLICT_SQL includes j.status = 'assigned'.
      // Simulates: contractor has an accepted job (status assigned) in the same window.
      const client = makeClient([conflictRow('AC-2026-ASSIGNED')]);
      const sr     = modeASchedule(MORNING_START, MORNING_END);

      const result = await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client);

      expect(result.conflict).toBe(true);
      if (result.conflict) {
        expect(result.conflictingJobKey).toBe('AC-2026-ASSIGNED');
      }
    });

    it('case 8: existing job status ready_for_dispatch with assignment row → blocked', async () => {
      // CONFLICT_SQL includes j.status = 'ready_for_dispatch'.
      // Simulates: contractor was dispatched (assignment row exists with status
      // 'pending') for a future job that hasn't moved to dispatch_in_progress yet.
      const client = makeClient([conflictRow('AC-2026-RFD')]);
      const sr     = modeASchedule(MORNING_START, MORNING_END);

      const result = await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client);

      expect(result.conflict).toBe(true);
      if (result.conflict) {
        expect(result.conflictingJobKey).toBe('AC-2026-RFD');
      }
    });

    it('case 9: existing job status cancelled → allows (DB returns empty)', async () => {
      // CONFLICT_SQL excludes j.status = 'cancelled'.
      // Simulates: the other job was cancelled — assignment no longer holds the window.
      const client = makeClient([]);
      const sr     = modeASchedule(MORNING_START, MORNING_END);

      const result = await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client);

      expect(result.conflict).toBe(false);
    });

    it('case 10: existing job status closed_paid → allows (DB returns empty)', async () => {
      // CONFLICT_SQL excludes j.status = 'closed_paid'.
      // Simulates: the other job is fully complete — not a scheduling conflict.
      const client = makeClient([]);
      const sr     = modeASchedule(MORNING_START, MORNING_END);

      const result = await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client);

      expect(result.conflict).toBe(false);
    });

    it('resolvedSchedule carries timestamps on both conflict and clear paths', async () => {
      const srConflict = await checkScheduleConflict(
        CONTRACTOR_ID, JOB_ID,
        modeASchedule(MORNING_START, MORNING_END),
        makeClient([conflictRow()]),
      );
      const srClear = await checkScheduleConflict(
        CONTRACTOR_ID, JOB_ID,
        modeASchedule(MORNING_START, MORNING_END),
        makeClient([]),
      );

      expect(srConflict.resolvedSchedule.scheduledStart).toEqual(MORNING_START);
      expect(srConflict.resolvedSchedule.scheduledEnd).toEqual(MORNING_END);
      expect(srClear.resolvedSchedule.scheduledStart).toEqual(MORNING_START);
      expect(srClear.resolvedSchedule.scheduledEnd).toEqual(MORNING_END);
    });
  });

  // ── Mode B: no pre-computed timestamps — fallback to appointment fields ─────
  describe('Mode B — no timestamps, fallback to appointment_date + appointment_window', () => {

    it('case 11: same appointment_date + same appointment_window → blocked', async () => {
      // When scheduled_start_at/end_at are null the function calls parseSchedule()
      // to derive $3/$4 for Mode A overlap check, AND passes appointment_date/$window
      // as $5/$6 for the Mode B exact-match check.
      const client = makeClient([conflictRow('AC-2026-MODEB')]);
      const sr = {
        scheduled_start_at: null,
        scheduled_end_at:   null,
        timezone:           'America/New_York',
        appointment_date:   '2026-06-01',
        appointment_window: 'Morning(8am-12pm)',
      };

      const result = await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client);

      expect(result.conflict).toBe(true);
      if (result.conflict) {
        expect(result.conflictingJobKey).toBe('AC-2026-MODEB');
      }
    });

    it('case 11 (params): Mode B derives timestamps via parseSchedule and passes them to SQL', async () => {
      // Verifies that when timestamps are absent parseSchedule is invoked and the
      // derived UTC values are forwarded as $3/$4 in the SQL parameter list.
      const client = makeClient([]);
      const sr = {
        scheduled_start_at: null,
        scheduled_end_at:   null,
        timezone:           'America/New_York',
        appointment_date:   '2026-06-01',
        appointment_window: 'Morning(8am-12pm)',
      };

      await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client);

      // client.query was called once with CONFLICT_SQL and 6 params
      expect(client.query).toHaveBeenCalledTimes(1);
      const params: any[] = client.query.mock.calls[0][1];
      // $3 = scheduledStart derived from 8am EDT on 2026-06-01
      expect(params[2]).toEqual(new Date('2026-06-01T12:00:00.000Z'));
      // $4 = scheduledEnd derived from 12pm EDT on 2026-06-01
      expect(params[3]).toEqual(new Date('2026-06-01T16:00:00.000Z'));
      // $5 / $6 = raw appointment fields passed through for Mode B match
      expect(params[4]).toBe('2026-06-01');
      expect(params[5]).toBe('Morning(8am-12pm)');
    });

    it('case 12: same appointment_date + different appointment_window → allows', async () => {
      // DB returns empty: the Mode B exact-match on appointment_window finds no row
      // because the existing job is in a different window on the same date.
      const client = makeClient([]);
      const sr = {
        scheduled_start_at: null,
        scheduled_end_at:   null,
        timezone:           'America/New_York',
        appointment_date:   '2026-06-01',
        appointment_window: 'Afternoon(12pm-4pm)',
      };

      const result = await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client);

      expect(result.conflict).toBe(false);
    });

    it('missing appointment_date (both timestamps null) → throws SCHEDULE_PARSE_FAILED', async () => {
      const client = makeClient([]);
      const sr = {
        scheduled_start_at: null,
        scheduled_end_at:   null,
        timezone:           'America/New_York',
        appointment_date:   null,
        appointment_window: 'Morning(8am-12pm)',
      };

      await expect(
        checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client),
      ).rejects.toMatchObject({ errorCode: 'SCHEDULE_PARSE_FAILED' });
    });

    it('missing appointment_window (both timestamps null) → throws SCHEDULE_PARSE_FAILED', async () => {
      const client = makeClient([]);
      const sr = {
        scheduled_start_at: null,
        scheduled_end_at:   null,
        timezone:           'America/New_York',
        appointment_date:   '2026-06-01',
        appointment_window: null,
      };

      await expect(
        checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr, client),
      ).rejects.toMatchObject({ errorCode: 'SCHEDULE_PARSE_FAILED' });
    });
  });

  // ── Standalone query path (no PoolClient — read-only precheck) ─────────────
  describe('standalone path — no client argument', () => {

    it('uses standalone query() and returns conflict when CONFLICT_SQL returns a row', async () => {
      // Without a client the function calls the standalone query() from pool.
      // query() returns T[] directly (not wrapped in { rows }).
      mockQuery.mockResolvedValueOnce([conflictRow('AC-2026-STANDALONE')]);
      const sr = modeASchedule(MORNING_START, MORNING_END);

      const result = await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr);

      expect(result.conflict).toBe(true);
      if (result.conflict) {
        expect(result.conflictingJobKey).toBe('AC-2026-STANDALONE');
      }
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('uses standalone query() and returns no conflict when CONFLICT_SQL returns empty', async () => {
      mockQuery.mockResolvedValueOnce([]);
      const sr = modeASchedule(EVENING_START, EVENING_END);

      const result = await checkScheduleConflict(CONTRACTOR_ID, JOB_ID, sr);

      expect(result.conflict).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkContractorAvailability
// ─────────────────────────────────────────────────────────────────────────────

describe('checkContractorAvailability', () => {
  /**
   * Queue three consecutive mockQuery responses in execution order:
   *   call 1 → contractors lookup
   *   call 2 → jobs schedule lookup         (skipped when contractor not found/inactive)
   *   call 3 → CONFLICT_SQL                 (skipped when contractor not found/inactive)
   */
  function setup({
    contractorFound   = true,
    contractorActive  = true,
    jobFound          = true,
    jobSchedule       = {
      scheduled_start_at: MORNING_START,
      scheduled_end_at:   MORNING_END,
      timezone:           'America/New_York',
      appointment_date:   '2026-06-01',
      appointment_window: 'Morning(8am-12pm)',
    } as object,
    conflictRows      = [] as object[],
  } = {}) {
    // Drain any once-responses left unconsumed by a prior test.
    // vi.clearAllMocks() in beforeEach does NOT drain the mockResolvedValueOnce queue.
    mockQuery.mockReset();

    // call 1: contractor lookup
    mockQuery.mockResolvedValueOnce(
      contractorFound
        ? [{ id: CONTRACTOR_ID, is_active: contractorActive }]
        : [],
    );

    if (contractorFound && contractorActive) {
      // call 2: job schedule lookup
      mockQuery.mockResolvedValueOnce(
        jobFound ? [{ id: JOB_ID, ...jobSchedule }] : [],
      );
      if (jobFound) {
        // call 3: CONFLICT_SQL (delegated to checkScheduleConflict)
        mockQuery.mockResolvedValueOnce(conflictRows);
      }
    }
  }

  it('case 13: returns Conflict with conflictingJobKey when overlap exists', async () => {
    setup({ conflictRows: [conflictRow('AC-2026-AVAIL-CONF')] });

    const result = await checkContractorAvailability(JOB_ID, CONTRACTOR_ID, 'corr-1');

    expect(result.status).toBe('Conflict');
    expect(result.available).toBe(false);
    expect(result.conflictingJobKey).toBe('AC-2026-AVAIL-CONF');
    // conflictWindow is formatted as "<date> <window>"
    expect(result.conflictWindow).toContain('2026-06-01');
    expect(result.conflictWindow).toContain('Morning(8am-12pm)');
  });

  it('case 14: returns Available when no overlap exists', async () => {
    setup({ conflictRows: [] });

    const result = await checkContractorAvailability(JOB_ID, CONTRACTOR_ID, 'corr-1');

    expect(result.status).toBe('Available');
    expect(result.available).toBe(true);
    expect(result.conflictingJobKey).toBeNull();
    expect(result.conflictWindow).toBeNull();
  });

  it('case 15: returns Missing Schedule when job has no timestamps and no appointment fields', async () => {
    setup({
      jobSchedule: {
        scheduled_start_at: null,
        scheduled_end_at:   null,
        timezone:           'America/New_York',
        appointment_date:   null,
        appointment_window: null,
      },
    });

    const result = await checkContractorAvailability(JOB_ID, CONTRACTOR_ID, 'corr-1');

    expect(result.status).toBe('Missing Schedule');
    expect(result.available).toBe(false);
    expect(result.conflictingJobKey).toBeNull();
  });

  it('returns Missing Contractor when contractor row is not found', async () => {
    setup({ contractorFound: false });

    const result = await checkContractorAvailability(JOB_ID, CONTRACTOR_ID, 'corr-1');

    expect(result.status).toBe('Missing Contractor');
    expect(result.available).toBe(false);
  });

  it('returns Missing Contractor when contractor exists but is inactive', async () => {
    setup({ contractorFound: true, contractorActive: false });

    const result = await checkContractorAvailability(JOB_ID, CONTRACTOR_ID, 'corr-1');

    expect(result.status).toBe('Missing Contractor');
    expect(result.available).toBe(false);
  });

  it('returns Error when job is not found', async () => {
    setup({ jobFound: false });

    const result = await checkContractorAvailability(JOB_ID, CONTRACTOR_ID, 'corr-1');

    expect(result.status).toBe('Error');
    expect(result.available).toBe(false);
  });

  it('returns Missing Schedule when appointment fields are absent and no timestamps', async () => {
    // Handles the case where only one of date/window is missing.
    setup({
      jobSchedule: {
        scheduled_start_at: null,
        scheduled_end_at:   null,
        timezone:           'America/New_York',
        appointment_date:   '2026-06-01',
        appointment_window: null, // window missing
      },
    });

    const result = await checkContractorAvailability(JOB_ID, CONTRACTOR_ID, 'corr-1');

    // Early guard catches (!appointment_date || !appointment_window) when no timestamps
    expect(result.status).toBe('Missing Schedule');
    expect(result.available).toBe(false);
  });

  it('issues exactly 3 query calls for a contractor+job+conflict check', async () => {
    setup({ conflictRows: [] });

    await checkContractorAvailability(JOB_ID, CONTRACTOR_ID, 'corr-1');

    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('issues only 1 query call when contractor is not found (early exit)', async () => {
    setup({ contractorFound: false });

    await checkContractorAvailability(JOB_ID, CONTRACTOR_ID, 'corr-1');

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
