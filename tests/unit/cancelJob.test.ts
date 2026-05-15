/**
 * Unit tests for cancelJob()
 *
 * The service does ALL reads and writes inside a single withTransaction() call.
 * We mock withTransaction to execute the callback with a fake client whose
 * query() responses are queued in order:
 *   call 1 → SELECT id, status FROM jobs ... FOR UPDATE
 *   call 2 → UPDATE contractor_assignments ... RETURNING id, dispatch_id
 *   call 3 → (optional) UPDATE dispatches ... WHERE id = ANY(...)
 *   call 4 → UPDATE jobs SET status = 'cancelled' ...
 *   call 5 → recordAuditEvent (mocked separately)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist mock variables ──────────────────────────────────────────────────────
const {
  mockWithTransaction,
  mockRecordAuditEvent,
  mockEnqueueAirtableSync,
  mockSendSms,
} = vi.hoisted(() => ({
  mockWithTransaction: vi.fn(),
  mockRecordAuditEvent: vi.fn(),
  mockEnqueueAirtableSync: vi.fn(),
  mockSendSms: vi.fn(),
}));

vi.mock('../../src/db/pool', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: mockWithTransaction,
}));

vi.mock('../../src/modules/jobs/job.repository', () => ({
  getJobById: vi.fn(),
  updateJobStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/modules/audit/audit.service', () => ({
  recordAuditEvent: mockRecordAuditEvent,
}));

vi.mock('../../src/modules/airtable-sync/airtableSync.queue', () => ({
  enqueueAirtableSync: mockEnqueueAirtableSync,
}));

vi.mock('../../src/modules/sms/quo.adapter', () => ({
  sendSms: mockSendSms,
}));

vi.mock('../../src/common/utils/scheduleUtils', () => ({
  parseSchedule: vi.fn(),
}));

import { cancelJob } from '../../src/modules/dispatch/dispatch.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a mock client whose query() calls return pre-queued responses in order.
 * Each call pops the next response from the queue.
 */
function makeClient(responses: Array<{ rows: any[]; rowCount: number }>) {
  let callIndex = 0;
  return {
    query: vi.fn(async () => {
      const res = responses[callIndex] ?? { rows: [], rowCount: 0 };
      callIndex++;
      return res;
    }),
  };
}

function setupTransaction(responses: Array<{ rows: any[]; rowCount: number }>) {
  mockWithTransaction.mockImplementation(async (fn: (client: any) => Promise<any>) => {
    mockRecordAuditEvent.mockResolvedValue(undefined);
    return fn(makeClient(responses));
  });
}

/**
 * Standard success responses for a job with one active assignment that has a dispatch_id.
 *
 * call 1: SELECT ... FOR UPDATE → job row
 * call 2: UPDATE contractor_assignments RETURNING id, dispatch_id → 1 cancelled
 * call 3: UPDATE dispatches WHERE id = ANY(...) → 1 expired
 * call 4: UPDATE jobs SET status = 'cancelled'
 */
function successResponses(
  jobStatus: string,
  assignments: Array<{ id: string; dispatch_id: string | null }> = [
    { id: 'assign-uuid-1', dispatch_id: 'dispatch-uuid-1' },
  ],
) {
  const hasDispatches = assignments.some((a) => a.dispatch_id !== null);
  return [
    // call 1: lock job row
    { rows: [{ id: 'job-uuid-1', status: jobStatus }], rowCount: 1 },
    // call 2: bulk-cancel assignments
    { rows: assignments, rowCount: assignments.length },
    // call 3: expire dispatches (only if at least one dispatch_id is non-null)
    ...(hasDispatches ? [{ rows: [], rowCount: assignments.filter((a) => a.dispatch_id).length }] : []),
    // call 4: update job status
    { rows: [], rowCount: 1 },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cancelJob', () => {
  it('cancels a ready_for_dispatch job with no active assignment', async () => {
    setupTransaction([
      // call 1: lock job row
      { rows: [{ id: 'job-uuid-1', status: 'ready_for_dispatch' }], rowCount: 1 },
      // call 2: bulk-cancel assignments → 0 rows (no active assignments)
      { rows: [], rowCount: 0 },
      // no dispatch expire step (no dispatch_ids)
      // call 3: update job status
      { rows: [], rowCount: 1 },
    ]);

    const result = await cancelJob('job-uuid-1', 'corr-1');

    expect(result).toEqual({
      success: true,
      jobId: 'job-uuid-1',
      previousJobStatus: 'ready_for_dispatch',
      cancelledAssignmentCount: 0,
      expiredDispatchCount: 0,
    });
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.cancelled',
        actorType: 'admin',
        payload: expect.objectContaining({
          previousJobStatus: 'ready_for_dispatch',
          cancelledAssignmentCount: 0,
          expiredDispatchCount: 0,
        }),
      }),
    );
  });

  it('cancels a dispatch_in_progress job with active assignment and dispatch', async () => {
    setupTransaction(successResponses('dispatch_in_progress'));

    const result = await cancelJob('job-uuid-1', 'corr-1');

    expect(result.previousJobStatus).toBe('dispatch_in_progress');
    expect(result.cancelledAssignmentCount).toBe(1);
    expect(result.expiredDispatchCount).toBe(1);
    expect(result.success).toBe(true);
  });

  it('cancels an assigned job with active assignment and dispatch', async () => {
    setupTransaction(successResponses('assigned'));

    const result = await cancelJob('job-uuid-1', 'corr-1');

    expect(result.previousJobStatus).toBe('assigned');
    expect(result.cancelledAssignmentCount).toBe(1);
    expect(result.expiredDispatchCount).toBe(1);
  });

  it('rejects cancellation of a closed_paid job', async () => {
    setupTransaction([
      { rows: [{ id: 'job-uuid-1', status: 'closed_paid' }], rowCount: 1 },
    ]);

    await expect(cancelJob('job-uuid-1', 'corr-1')).rejects.toThrow(
      'Invalid job state transition: closed_paid → cancelled',
    );
  });

  it('rejects cancellation of an already-cancelled job', async () => {
    setupTransaction([
      { rows: [{ id: 'job-uuid-1', status: 'cancelled' }], rowCount: 1 },
    ]);

    await expect(cancelJob('job-uuid-1', 'corr-1')).rejects.toThrow(
      'Invalid job state transition: cancelled → cancelled',
    );
  });

  it('handles multiple active assignments without 409 — bulk cancels all', async () => {
    setupTransaction(
      successResponses('assigned', [
        { id: 'assign-uuid-1', dispatch_id: 'dispatch-uuid-1' },
        { id: 'assign-uuid-2', dispatch_id: 'dispatch-uuid-2' },
      ]),
    );

    const result = await cancelJob('job-uuid-1', 'corr-1');

    expect(result.cancelledAssignmentCount).toBe(2);
    expect(result.expiredDispatchCount).toBe(2);
  });

  it('stores reason in audit payload', async () => {
    setupTransaction(successResponses('ready_for_dispatch', []));

    await cancelJob('job-uuid-1', 'corr-1', 'Customer requested cancellation');

    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          reason: 'Customer requested cancellation',
        }),
      }),
    );
  });

  it('stores null reason in audit payload when no reason provided', async () => {
    setupTransaction(successResponses('ready_for_dispatch', []));

    await cancelJob('job-uuid-1', 'corr-1');

    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ reason: null }),
      }),
    );
  });

  it('does not call sendSms', async () => {
    setupTransaction(successResponses('assigned'));

    await cancelJob('job-uuid-1', 'corr-1');
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('does not call enqueueAirtableSync (caller responsibility)', async () => {
    setupTransaction(successResponses('assigned'));

    await cancelJob('job-uuid-1', 'corr-1');
    expect(mockEnqueueAirtableSync).not.toHaveBeenCalled();
  });

  it('returns 404 if job row is not found', async () => {
    setupTransaction([
      { rows: [], rowCount: 0 },
    ]);

    await expect(cancelJob('job-uuid-1', 'corr-1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
