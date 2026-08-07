/**
 * Unit tests for cancelContractorAssignment()
 *
 * The service does ALL reads and writes inside a single withTransaction() call.
 * We mock withTransaction to execute the callback with a fake client whose
 * query() responses are queued in order:
 *   call 1 → SELECT id, status FROM jobs ... FOR UPDATE
 *   call 2 → SELECT id, contractor_id, dispatch_id, status FROM contractor_assignments
 *   call 3 → UPDATE contractor_assignments ... RETURNING id
 *   call 4 → (optional) UPDATE dispatches ...
 *   call 5 → UPDATE jobs SET status = 'ready_for_dispatch' ...
 *   call 6 → recordAuditEvent (mocked separately)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist mock variables ──────────────────────────────────────────────────────
const {
  mockWithTransaction,
  mockRecordAuditEvent,
  mockEnqueueAirtableSync,
  mockSendSms,
  mockParseSchedule,
  mockLogWarn,
} = vi.hoisted(() => ({
  mockWithTransaction: vi.fn(),
  mockRecordAuditEvent: vi.fn(),
  mockEnqueueAirtableSync: vi.fn(),
  mockSendSms: vi.fn(),
  mockParseSchedule: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('../../src/db/pool', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: mockWithTransaction,
}));

vi.mock('../../src/modules/jobs/job.repository', () => ({
  getJobById: vi.fn(),
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
  parseSchedule: mockParseSchedule,
}));

vi.mock('../../src/common/logger', () => {
  const log = { info: vi.fn(), warn: mockLogWarn, error: vi.fn(), debug: vi.fn() };
  return { logger: { ...log, child: vi.fn(() => log) } };
});

import { cancelContractorAssignment } from '../../src/modules/dispatch/dispatch.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface MockAssignment {
  id: string;
  contractor_id: string;
  dispatch_id: string | null;
  status: string;
  phone_e164: string;
}

function makeAssignment(overrides: Partial<MockAssignment> = {}): MockAssignment {
  return {
    id: 'assign-uuid-1',
    contractor_id: 'contractor-uuid-1',
    dispatch_id: 'dispatch-uuid-1',
    status: 'pending',
    phone_e164: '+14045550100',
    ...overrides,
  };
}

function makeJob(status = 'assigned', overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-uuid-1',
    status,
    job_key: 'AC-2026-CANCEL',
    scheduled_start_at: new Date('2026-08-10T13:00:00.000Z'),
    scheduled_end_at: new Date('2026-08-10T15:00:00.000Z'),
    appointment_date: '2026-08-10',
    appointment_window: '9:00 AM - 11:00 AM',
    timezone: 'America/New_York',
    ...overrides,
  };
}

const EXPECTED_CANCELLATION_SMS =
  'AC UPDATE - Job AC-2026-CANCEL scheduled Mon, Aug 10, 2026, 9:00 AM-11:00 AM EDT '
  + 'has been cancelled. You are no longer assigned. No action needed.';

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

/**
 * Standard success scenario responses for a job in `assigned` state with one
 * active assignment that has a dispatch_id.
 */
function successResponses(
  jobStatus = 'assigned',
  assignment = makeAssignment(),
  job = makeJob(jobStatus),
) {
  return [
    // Step 0: SELECT ... FOR UPDATE on jobs
    { rows: [job], rowCount: 1 },
    // Step 1: SELECT active contractor_assignments
    { rows: [assignment], rowCount: 1 },
    // Step 2: UPDATE contractor_assignments RETURNING id
    { rows: [{ id: assignment.id }], rowCount: 1 },
    // Step 3: UPDATE dispatches (only if dispatch_id is set)
    ...(assignment.dispatch_id ? [{ rows: [], rowCount: 1 }] : []),
    // Step 4: UPDATE jobs SET status = 'ready_for_dispatch'
    { rows: [], rowCount: 1 },
  ];
}

function setupTransaction(responses: Array<{ rows: any[]; rowCount: number }>) {
  mockWithTransaction.mockImplementation(async (fn: (client: any) => Promise<any>) => {
    mockRecordAuditEvent.mockResolvedValue(undefined);
    return fn(makeClient(responses));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSendSms.mockResolvedValue({ messageId: 'quo-message-1' });
  mockParseSchedule.mockReturnValue({
    scheduledStartAt: new Date('2026-08-10T13:00:00.000Z'),
    scheduledEndAt: new Date('2026-08-10T15:00:00.000Z'),
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cancelContractorAssignment', () => {
  it('cancels active assignment and returns job to ready_for_dispatch', async () => {
    setupTransaction(successResponses('assigned'));

    const result = await cancelContractorAssignment('job-uuid-1', 'corr-1');

    expect(result).toEqual({
      success: true,
      jobId: 'job-uuid-1',
      cancelledAssignmentId: 'assign-uuid-1',
      previousContractorId: 'contractor-uuid-1',
      jobStatus: 'ready_for_dispatch',
    });
  });

  it('also works when job is in dispatch_in_progress state', async () => {
    setupTransaction(successResponses('dispatch_in_progress'));

    const result = await cancelContractorAssignment('job-uuid-1', 'corr-1');
    expect(result.jobStatus).toBe('ready_for_dispatch');
  });

  it('rejects if job is in terminal state (closed_paid)', async () => {
    setupTransaction([
      { rows: [{ id: 'job-uuid-1', status: 'closed_paid' }], rowCount: 1 },
    ]);

    await expect(cancelContractorAssignment('job-uuid-1', 'corr-1')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'INVALID_JOB_STATE',
    });
  });

  it('rejects if job is in terminal state (cancelled)', async () => {
    setupTransaction([
      { rows: [{ id: 'job-uuid-1', status: 'cancelled' }], rowCount: 1 },
    ]);

    await expect(cancelContractorAssignment('job-uuid-1', 'corr-1')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'INVALID_JOB_STATE',
    });
  });

  it('rejects if job is in scheduled state', async () => {
    setupTransaction([
      { rows: [{ id: 'job-uuid-1', status: 'scheduled' }], rowCount: 1 },
    ]);

    await expect(cancelContractorAssignment('job-uuid-1', 'corr-1')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'INVALID_JOB_STATE',
    });
  });

  it('returns 404 if job row is not found', async () => {
    setupTransaction([
      { rows: [], rowCount: 0 },
    ]);

    await expect(cancelContractorAssignment('job-uuid-1', 'corr-1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('rejects if no active assignment exists', async () => {
    setupTransaction([
      { rows: [{ id: 'job-uuid-1', status: 'assigned' }], rowCount: 1 },
      { rows: [], rowCount: 0 }, // no active assignments
    ]);

    await expect(cancelContractorAssignment('job-uuid-1', 'corr-1')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'NO_ACTIVE_ASSIGNMENT',
    });
  });

  it('rejects if multiple active assignments exist and no assignmentId provided', async () => {
    setupTransaction([
      { rows: [{ id: 'job-uuid-1', status: 'assigned' }], rowCount: 1 },
      { rows: [makeAssignment(), makeAssignment({ id: 'assign-uuid-2' })], rowCount: 2 },
    ]);

    await expect(cancelContractorAssignment('job-uuid-1', 'corr-1')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'MULTIPLE_ACTIVE_ASSIGNMENTS',
    });
  });

  it('cancels a specific assignment when assignmentId is provided', async () => {
    const a1 = makeAssignment({ id: 'assign-uuid-1' });
    const a2 = makeAssignment({ id: 'assign-uuid-2' });
    setupTransaction([
      { rows: [{ id: 'job-uuid-1', status: 'assigned' }], rowCount: 1 },
      { rows: [a1, a2], rowCount: 2 },
      { rows: [{ id: 'assign-uuid-1' }], rowCount: 1 }, // UPDATE RETURNING id
      { rows: [], rowCount: 1 },                        // UPDATE dispatches
      { rows: [], rowCount: 1 },                        // UPDATE jobs
    ]);

    const result = await cancelContractorAssignment('job-uuid-1', 'corr-1', 'assign-uuid-1');
    expect(result.cancelledAssignmentId).toBe('assign-uuid-1');
  });

  it('returns 404 if assignmentId provided but not found as active', async () => {
    setupTransaction([
      { rows: [{ id: 'job-uuid-1', status: 'assigned' }], rowCount: 1 },
      { rows: [makeAssignment({ id: 'assign-uuid-1' })], rowCount: 1 },
    ]);

    await expect(
      cancelContractorAssignment('job-uuid-1', 'corr-1', 'assign-uuid-NONEXISTENT'),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('rejects with ASSIGNMENT_ALREADY_CANCELLED if UPDATE affects 0 rows (concurrent cancellation)', async () => {
    setupTransaction([
      { rows: [{ id: 'job-uuid-1', status: 'assigned' }], rowCount: 1 },
      { rows: [makeAssignment()], rowCount: 1 },
      { rows: [], rowCount: 0 }, // UPDATE RETURNING id → 0 rows = already cancelled
    ]);

    await expect(cancelContractorAssignment('job-uuid-1', 'corr-1')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'ASSIGNMENT_ALREADY_CANCELLED',
    });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('handles assignment with null dispatch_id gracefully (skips dispatch UPDATE)', async () => {
    const assignment = makeAssignment({ dispatch_id: null });
    setupTransaction([
      { rows: [{ id: 'job-uuid-1', status: 'assigned' }], rowCount: 1 },
      { rows: [assignment], rowCount: 1 },
      { rows: [{ id: assignment.id }], rowCount: 1 }, // UPDATE RETURNING id
      // no dispatch UPDATE step
      { rows: [], rowCount: 1 },                      // UPDATE jobs
    ]);

    const result = await cancelContractorAssignment('job-uuid-1', 'corr-1');
    expect(result.success).toBe(true);
  });

  it('sends the exact cancellation SMS with stored timestamps after commit', async () => {
    let committed = false;
    const client = makeClient(successResponses('assigned'));
    mockWithTransaction.mockImplementation(async (fn: (client: any) => Promise<any>) => {
      const value = await fn(client);
      committed = true;
      return value;
    });
    mockSendSms.mockImplementation(async () => {
      expect(committed).toBe(true);
      return { messageId: 'quo-message-1' };
    });

    await cancelContractorAssignment('job-uuid-1', 'corr-1');

    expect(mockSendSms).toHaveBeenCalledWith(
      '+14045550100',
      EXPECTED_CANCELLATION_SMS,
      'corr-1',
    );
  });

  it('uses a derived schedule when stored timestamps are null', async () => {
    const job = makeJob('assigned', {
      scheduled_start_at: null,
      scheduled_end_at: null,
      appointment_date: '2026-09-15',
      appointment_window: '1:00 PM - 4:00 PM',
    });
    mockParseSchedule.mockReturnValueOnce({
      scheduledStartAt: new Date('2026-09-15T17:00:00.000Z'),
      scheduledEndAt: new Date('2026-09-15T20:00:00.000Z'),
    });
    setupTransaction(successResponses('assigned', makeAssignment(), job));

    await cancelContractorAssignment('job-uuid-1', 'corr-derived');

    expect(mockParseSchedule).toHaveBeenCalledWith(
      '2026-09-15',
      '1:00 PM - 4:00 PM',
      'America/New_York',
    );
    expect(mockSendSms).toHaveBeenCalledWith(
      '+14045550100',
      'AC UPDATE - Job AC-2026-CANCEL scheduled Tue, Sep 15, 2026, 1:00 PM-4:00 PM EDT '
        + 'has been cancelled. You are no longer assigned. No action needed.',
      'corr-derived',
    );
  });

  it.each([
    ['missing', makeJob('assigned', {
      scheduled_start_at: null,
      scheduled_end_at: null,
      appointment_date: null,
      appointment_window: null,
    })],
    ['invalid', makeJob('assigned', {
      scheduled_start_at: new Date('invalid'),
      scheduled_end_at: new Date('invalid'),
    })],
  ])('uses safe fallback wording when the schedule is %s', async (_label, job) => {
    setupTransaction(successResponses('assigned', makeAssignment(), job));

    await cancelContractorAssignment('job-uuid-1', 'corr-fallback');

    expect(mockSendSms).toHaveBeenCalledWith(
      '+14045550100',
      'AC UPDATE - Job AC-2026-CANCEL has been cancelled. '
        + 'You are no longer assigned. No action needed.',
      'corr-fallback',
    );
  });

  it('sends no SMS when the cancellation fails', async () => {
    setupTransaction([
      { rows: [makeJob('assigned')], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);

    await expect(cancelContractorAssignment('job-uuid-1', 'corr-1')).rejects.toMatchObject({
      errorCode: 'NO_ACTIVE_ASSIGNMENT',
    });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('does not send twice when the cancelled assignment is requested again', async () => {
    const firstClient = makeClient(successResponses('assigned'));
    const secondClient = makeClient([
      { rows: [makeJob('ready_for_dispatch')], rowCount: 1 },
    ]);
    mockWithTransaction
      .mockImplementationOnce(async (fn: (client: any) => Promise<any>) => fn(firstClient))
      .mockImplementationOnce(async (fn: (client: any) => Promise<any>) => fn(secondClient));

    await cancelContractorAssignment('job-uuid-1', 'corr-first', 'assign-uuid-1');
    await expect(
      cancelContractorAssignment('job-uuid-1', 'corr-duplicate', 'assign-uuid-1'),
    ).rejects.toMatchObject({ errorCode: 'INVALID_JOB_STATE' });

    expect(mockSendSms).toHaveBeenCalledTimes(1);
  });

  it('sends no SMS when the cancellation transaction rolls back', async () => {
    const client = makeClient(successResponses('assigned'));
    mockWithTransaction.mockImplementation(async (fn: (client: any) => Promise<any>) => {
      await fn(client);
      throw new Error('commit failed');
    });

    await expect(cancelContractorAssignment('job-uuid-1', 'corr-1')).rejects.toThrow('commit failed');
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('keeps the successful cancellation result when SMS delivery fails', async () => {
    setupTransaction(successResponses('assigned'));
    mockSendSms.mockRejectedValueOnce(new Error('Quo unavailable'));

    const result = await cancelContractorAssignment('job-uuid-1', 'corr-1');

    expect(result).toEqual({
      success: true,
      jobId: 'job-uuid-1',
      cancelledAssignmentId: 'assign-uuid-1',
      previousContractorId: 'contractor-uuid-1',
      jobStatus: 'ready_for_dispatch',
    });
    expect(mockLogWarn).toHaveBeenCalledWith(
      {
        err: expect.any(Error),
        assignmentId: 'assign-uuid-1',
        jobKey: 'AC-2026-CANCEL',
      },
      '[CancelAssignment] Contractor cancellation SMS failed after commit',
    );
  });

  it('does not call enqueueAirtableSync', async () => {
    setupTransaction(successResponses('assigned'));

    await cancelContractorAssignment('job-uuid-1', 'corr-1');
    expect(mockEnqueueAirtableSync).not.toHaveBeenCalled();
  });
});
