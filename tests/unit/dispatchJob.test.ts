import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  queryOne: vi.fn(),
  recordAuditEvent: vi.fn(),
  enqueueAirtableSync: vi.fn(),
  sendSms: vi.fn(),
  checkScheduleConflict: vi.fn(),
  parseSchedule: vi.fn(),
  generateContractorPacketToken: vi.fn(),
  uuidv4: vi.fn(),
}));

vi.mock('uuid', () => ({ v4: mocks.uuidv4 }));

vi.mock('../../src/db/pool', () => ({
  queryOne: mocks.queryOne,
  withTransaction: mocks.withTransaction,
}));

vi.mock('../../src/modules/jobs/job.repository', () => ({
  updateJobStatus: vi.fn(async (jobId: string, status: string, client: any) => {
    await client.query(
      'UPDATE jobs SET status = $2, updated_at = NOW() WHERE id = $1',
      [jobId, status],
    );
  }),
}));

vi.mock('../../src/modules/audit/audit.service', () => ({
  recordAuditEvent: mocks.recordAuditEvent,
}));

vi.mock('../../src/modules/airtable-sync/airtableSync.queue', () => ({
  enqueueAirtableSync: mocks.enqueueAirtableSync,
}));

vi.mock('../../src/modules/sms/quo.adapter', () => ({
  sendSms: mocks.sendSms,
}));

vi.mock('../../src/modules/dispatch/dispatchConflict', () => ({
  checkScheduleConflict: mocks.checkScheduleConflict,
}));

vi.mock('../../src/common/utils/scheduleUtils', () => ({
  parseSchedule: mocks.parseSchedule,
}));

vi.mock('../../src/common/utils', () => ({
  generateContractorPacketToken: mocks.generateContractorPacketToken,
}));

vi.mock('../../src/common/logger', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...log, child: vi.fn(() => log) } };
});

import {
  DuplicateDispatchError,
  cancelContractorAssignment,
  dispatchJobToContractor,
} from '../../src/modules/dispatch/dispatch.service';

interface AssignmentState {
  id: string;
  jobId: string;
  contractorId: string;
  dispatchId: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'completed' | 'cancelled';
}

interface DispatchState {
  id: string;
  jobId: string;
  contractorId: string | null;
  status: 'not_ready' | 'ready' | 'sent' | 'accepted' | 'declined' | 'expired' | 'assigned' | 'failed';
}

interface FakeState {
  job: Record<string, any>;
  contractor: {
    id: string;
    full_name: string;
    phone_e164: string;
    is_active: boolean;
  } | null;
  assignments: AssignmentState[];
  dispatches: DispatchState[];
}

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const CONTRACTOR_ID = '22222222-2222-4222-8222-222222222222';

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    job: {
      id: JOB_ID,
      job_key: 'AC-2026-LOCK',
      status: 'ready_for_dispatch',
      service_type_id: '33333333-3333-4333-8333-333333333333',
      city_detected: 'Atlanta',
      contractor_total_payout_cents: 7500,
      scheduled_start_at: new Date('2026-08-10T13:00:00.000Z'),
      scheduled_end_at: new Date('2026-08-10T15:00:00.000Z'),
      timezone: 'America/New_York',
      appointment_date: '2026-08-10',
      appointment_window: '9:00 AM - 11:00 AM',
    },
    contractor: {
      id: CONTRACTOR_ID,
      full_name: 'Test Contractor',
      phone_e164: '+14045550100',
      is_active: true,
    },
    assignments: [],
    dispatches: [],
    ...overrides,
  };
}

function hasActiveAssignment(state: FakeState): boolean {
  return state.assignments.some(
    (assignment) =>
      assignment.jobId === state.job.id
      && (assignment.status === 'pending' || assignment.status === 'accepted'),
  );
}

function hasActiveDispatch(state: FakeState): boolean {
  return state.dispatches.some((dispatch) => {
    if (
      dispatch.jobId !== state.job.id
      || !['sent', 'accepted', 'assigned'].includes(dispatch.status)
    ) {
      return false;
    }

    const linkedAssignments = state.assignments.filter(
      (assignment) => assignment.dispatchId === dispatch.id,
    );

    return linkedAssignments.length === 0 || linkedAssignments.some(
      (assignment) => assignment.status === 'pending' || assignment.status === 'accepted',
    );
  });
}

function createClient(state: FakeState) {
  return {
    query: vi.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('AS has_active_dispatch')) {
        return {
          rows: [{
            has_active_dispatch: hasActiveDispatch(state),
            has_active_assignment: hasActiveAssignment(state),
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('FROM jobs j') && sql.includes('FOR UPDATE')) {
        return { rows: state.job ? [{ ...state.job }] : [], rowCount: state.job ? 1 : 0 };
      }

      if (sql.includes('SELECT id, status FROM jobs') && sql.includes('FOR UPDATE')) {
        return {
          rows: state.job ? [{ id: state.job.id, status: state.job.status }] : [],
          rowCount: state.job ? 1 : 0,
        };
      }

      if (sql.includes('FROM contractors') && sql.includes('FOR UPDATE')) {
        return {
          rows: state.contractor ? [{ ...state.contractor }] : [],
          rowCount: state.contractor ? 1 : 0,
        };
      }

      if (sql.includes('SELECT display_name, code FROM service_types')) {
        return {
          rows: [{ display_name: 'Furniture Assembly', code: 'furniture' }],
          rowCount: 1,
        };
      }

      if (
        sql.includes('FROM contractor_assignments')
        && sql.includes("status IN ('pending', 'accepted')")
        && !sql.includes('UPDATE')
      ) {
        const rows = state.assignments
          .filter(
            (assignment) =>
              assignment.jobId === params[0]
              && (assignment.status === 'pending' || assignment.status === 'accepted'),
          )
          .map((assignment) => ({
            id: assignment.id,
            contractor_id: assignment.contractorId,
            dispatch_id: assignment.dispatchId,
            status: assignment.status,
          }));
        return { rows, rowCount: rows.length };
      }

      if (sql.includes('INSERT INTO dispatches')) {
        state.dispatches.push({
          id: params[0],
          jobId: params[1],
          status: 'sent',
          contractorId: params[3],
        });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('INSERT INTO contractor_assignments')) {
        state.assignments.push({
          id: params[0],
          jobId: params[1],
          contractorId: params[2],
          dispatchId: params[3],
          status: 'pending',
        });
        return { rows: [], rowCount: 1 };
      }

      if (
        sql.includes('UPDATE contractor_assignments')
        && sql.includes("SET status = 'cancelled'")
      ) {
        const assignment = state.assignments.find(
          (row) =>
            row.id === params[0]
            && row.jobId === params[1]
            && (row.status === 'pending' || row.status === 'accepted'),
        );
        if (!assignment) return { rows: [], rowCount: 0 };
        assignment.status = 'cancelled';
        return { rows: [{ id: assignment.id }], rowCount: 1 };
      }

      if (
        sql.includes('UPDATE dispatches')
        && sql.includes("SET status = 'expired'")
      ) {
        const dispatch = state.dispatches.find((row) => row.id === params[0]);
        if (dispatch) dispatch.status = 'expired';
        return { rows: [], rowCount: dispatch ? 1 : 0 };
      }

      if (sql.includes('UPDATE jobs SET status')) {
        state.job.status = params[1] ?? 'ready_for_dispatch';
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('UPDATE jobs') && sql.includes('scheduled_start_at')) {
        state.job.scheduled_start_at = params[0];
        state.job.scheduled_end_at = params[1];
        state.job.timezone = params[2];
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected SQL in dispatch test: ${sql}`);
    }),
  };
}

function installState(state: FakeState, events: string[] = []) {
  const client = createClient(state);
  mocks.withTransaction.mockImplementation(async (fn: (client: any) => Promise<any>) => {
    events.push('begin');
    const result = await fn(client);
    events.push('commit');
    return result;
  });
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();

  let uuidCounter = 0;
  mocks.uuidv4.mockImplementation(() => {
    uuidCounter += 1;
    return `00000000-0000-4000-8000-${uuidCounter.toString().padStart(12, '0')}`;
  });
  mocks.generateContractorPacketToken.mockReturnValue('packet-token');
  mocks.sendSms.mockResolvedValue({ messageId: null });
  mocks.enqueueAirtableSync.mockResolvedValue(undefined);
  mocks.recordAuditEvent.mockResolvedValue(undefined);
  mocks.queryOne.mockResolvedValue(null);
  mocks.checkScheduleConflict.mockResolvedValue({
    conflict: false,
    resolvedSchedule: {
      scheduledStart: new Date('2026-08-10T13:00:00.000Z'),
      scheduledEnd: new Date('2026-08-10T15:00:00.000Z'),
      appointmentDate: '2026-08-10',
      appointmentWindow: '9:00 AM - 11:00 AM',
    },
  });
  mocks.parseSchedule.mockReturnValue({
    scheduledStartAt: new Date('2026-08-10T13:00:00.000Z'),
    scheduledEndAt: new Date('2026-08-10T15:00:00.000Z'),
  });
});

describe('dispatchJobToContractor transactional winner gate', () => {
  const unrelatedJobId = '44444444-4444-4444-8444-444444444444';

  async function expectDispatchWinner(
    dispatch: DispatchState,
    assignments: AssignmentState[],
    correlationId: string,
  ) {
    const state = makeState({ dispatches: [dispatch], assignments });
    const client = installState(state);

    await expect(
      dispatchJobToContractor(JOB_ID, CONTRACTOR_ID, correlationId),
    ).rejects.toBeInstanceOf(DuplicateDispatchError);

    expect(state.dispatches).toHaveLength(1);
    expect(state.assignments).toHaveLength(assignments.length);
    expect(mocks.sendSms).not.toHaveBeenCalled();

    const winnerSql = client.query.mock.calls
      .map(([statement]) => String(statement))
      .find((statement) => statement.includes('AS has_active_dispatch'));
    expect(winnerSql).toContain('FROM contractor_assignments linked_ca');
    expect(winnerSql).toContain('FROM contractor_assignments active_linked_ca');
    expect(winnerSql).toContain("active_linked_ca.status IN ('pending', 'accepted')");
  }

  async function expectNoDispatchWinner(
    dispatch: DispatchState,
    assignments: AssignmentState[],
    correlationId: string,
  ) {
    const state = makeState({ dispatches: [dispatch], assignments });
    const initialDispatchCount = state.dispatches.length;
    const initialAssignmentCount = state.assignments.length;
    installState(state);

    const result = await dispatchJobToContractor(
      JOB_ID,
      CONTRACTOR_ID,
      correlationId,
    );

    expect(result).toMatchObject({
      dispatchId: expect.any(String),
      assignmentId: expect.any(String),
      jobId: JOB_ID,
    });
    expect(state.dispatches).toHaveLength(initialDispatchCount + 1);
    expect(state.assignments).toHaveLength(initialAssignmentCount + 1);
    expect(mocks.sendSms).toHaveBeenCalledTimes(1);
  }

  it('treats a sent dispatch with no linked assignment as a duplicate winner', async () => {
    await expectDispatchWinner({
      id: 'sent-no-assignment',
      jobId: JOB_ID,
      contractorId: CONTRACTOR_ID,
      status: 'sent',
    }, [], 'corr-sent-no-assignment');
  });

  it('treats a sent dispatch with one pending linked assignment as a duplicate winner', async () => {
    await expectDispatchWinner({
      id: 'sent-pending',
      jobId: JOB_ID,
      contractorId: CONTRACTOR_ID,
      status: 'sent',
    }, [{
      id: 'pending-assignment',
      jobId: unrelatedJobId,
      contractorId: CONTRACTOR_ID,
      dispatchId: 'sent-pending',
      status: 'pending',
    }], 'corr-sent-pending');
  });

  it('treats a sent dispatch with one accepted linked assignment as a duplicate winner', async () => {
    await expectDispatchWinner({
      id: 'sent-accepted',
      jobId: JOB_ID,
      contractorId: CONTRACTOR_ID,
      status: 'sent',
    }, [{
      id: 'accepted-assignment',
      jobId: unrelatedJobId,
      contractorId: CONTRACTOR_ID,
      dispatchId: 'sent-accepted',
      status: 'accepted',
    }], 'corr-sent-accepted');
  });

  it('does not treat a sent dispatch with only one cancelled linked assignment as a winner', async () => {
    await expectNoDispatchWinner({
      id: 'sent-cancelled',
      jobId: JOB_ID,
      contractorId: CONTRACTOR_ID,
      status: 'sent',
    }, [{
      id: 'cancelled-assignment',
      jobId: JOB_ID,
      contractorId: CONTRACTOR_ID,
      dispatchId: 'sent-cancelled',
      status: 'cancelled',
    }], 'corr-sent-cancelled');
  });

  it('treats a sent dispatch with cancelled and pending linked assignments as a duplicate winner', async () => {
    await expectDispatchWinner({
      id: 'sent-cancelled-pending',
      jobId: JOB_ID,
      contractorId: CONTRACTOR_ID,
      status: 'sent',
    }, [{
      id: 'cancelled-assignment',
      jobId: unrelatedJobId,
      contractorId: CONTRACTOR_ID,
      dispatchId: 'sent-cancelled-pending',
      status: 'cancelled',
    }, {
      id: 'pending-assignment',
      jobId: unrelatedJobId,
      contractorId: CONTRACTOR_ID,
      dispatchId: 'sent-cancelled-pending',
      status: 'pending',
    }], 'corr-sent-cancelled-pending');
  });

  it('treats an accepted dispatch with completed and accepted linked assignments as a duplicate winner', async () => {
    await expectDispatchWinner({
      id: 'accepted-completed-accepted',
      jobId: JOB_ID,
      contractorId: CONTRACTOR_ID,
      status: 'accepted',
    }, [{
      id: 'completed-assignment',
      jobId: unrelatedJobId,
      contractorId: CONTRACTOR_ID,
      dispatchId: 'accepted-completed-accepted',
      status: 'completed',
    }, {
      id: 'accepted-assignment',
      jobId: unrelatedJobId,
      contractorId: CONTRACTOR_ID,
      dispatchId: 'accepted-completed-accepted',
      status: 'accepted',
    }], 'corr-accepted-completed-accepted');
  });

  it('does not treat a dispatch with multiple inactive linked assignments as a winner', async () => {
    await expectNoDispatchWinner({
      id: 'sent-inactive-only',
      jobId: JOB_ID,
      contractorId: CONTRACTOR_ID,
      status: 'sent',
    }, [{
      id: 'declined-assignment',
      jobId: JOB_ID,
      contractorId: CONTRACTOR_ID,
      dispatchId: 'sent-inactive-only',
      status: 'declined',
    }, {
      id: 'completed-assignment',
      jobId: JOB_ID,
      contractorId: CONTRACTOR_ID,
      dispatchId: 'sent-inactive-only',
      status: 'completed',
    }, {
      id: 'cancelled-assignment',
      jobId: JOB_ID,
      contractorId: CONTRACTOR_ID,
      dispatchId: 'sent-inactive-only',
      status: 'cancelled',
    }], 'corr-inactive-only');
  });

  it('does not treat an expired dispatch with no assignments as a winner', async () => {
    await expectNoDispatchWinner({
      id: 'expired-no-assignment',
      jobId: JOB_ID,
      contractorId: CONTRACTOR_ID,
      status: 'expired',
    }, [], 'corr-expired-no-assignment');
  });

  it('does not treat a failed dispatch with no assignments as a winner', async () => {
    await expectNoDispatchWinner({
      id: 'failed-no-assignment',
      jobId: JOB_ID,
      contractorId: CONTRACTOR_ID,
      status: 'failed',
    }, [], 'corr-failed-no-assignment');
  });

  it('throws the typed duplicate error for an active winner and leaves no loser writes', async () => {
    const state = makeState({
      job: { ...makeState().job, status: 'dispatch_in_progress' },
      dispatches: [{
        id: 'existing-dispatch',
        jobId: JOB_ID,
        contractorId: CONTRACTOR_ID,
        status: 'sent',
      }],
      assignments: [{
        id: 'existing-assignment',
        jobId: JOB_ID,
        contractorId: CONTRACTOR_ID,
        dispatchId: 'existing-dispatch',
        status: 'pending',
      }],
    });
    const client = installState(state);

    await expect(
      dispatchJobToContractor(JOB_ID, CONTRACTOR_ID, 'corr-duplicate'),
    ).rejects.toMatchObject({
      name: 'DuplicateDispatchError',
      statusCode: 409,
      errorCode: 'DUPLICATE_DISPATCH',
      message: 'DUPLICATE_DISPATCH: a dispatch has already been committed for this job.',
    });

    expect(state.dispatches).toHaveLength(1);
    expect(state.assignments).toHaveLength(1);
    expect(state.job.status).toBe('dispatch_in_progress');
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();

    const sql = client.query.mock.calls.map(([statement]) => String(statement));
    expect(sql.some((statement) => statement.includes('INSERT INTO dispatches'))).toBe(false);
    expect(sql.some((statement) => statement.includes('INSERT INTO contractor_assignments'))).toBe(false);
    expect(sql.some((statement) => statement.includes('UPDATE jobs SET status'))).toBe(false);
  });

  it('preserves the generic stale-status conflict when there is no active winner', async () => {
    const state = makeState({
      job: { ...makeState().job, status: 'assigned' },
    });
    installState(state);

    const error = await dispatchJobToContractor(
      JOB_ID,
      CONTRACTOR_ID,
      'corr-stale',
    ).catch((err) => err);

    expect(error).toMatchObject({
      statusCode: 409,
      message: 'Job must be at ready_for_dispatch to dispatch (current: assigned)',
    });
    expect(error).not.toBeInstanceOf(DuplicateDispatchError);
    expect(error.message).not.toContain('DUPLICATE_DISPATCH');
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it('preserves cancelled-job generic conflict even if stale active rows remain', async () => {
    const state = makeState({
      job: { ...makeState().job, status: 'cancelled' },
      dispatches: [{
        id: 'stale-dispatch',
        jobId: JOB_ID,
        contractorId: CONTRACTOR_ID,
        status: 'sent',
      }],
      assignments: [{
        id: 'stale-assignment',
        jobId: JOB_ID,
        contractorId: CONTRACTOR_ID,
        dispatchId: 'stale-dispatch',
        status: 'pending',
      }],
    });
    installState(state);

    const error = await dispatchJobToContractor(
      JOB_ID,
      CONTRACTOR_ID,
      'corr-cancelled',
    ).catch((err) => err);

    expect(error).toMatchObject({
      statusCode: 409,
      message: 'Job must be at ready_for_dispatch to dispatch (current: cancelled)',
    });
    expect(error).not.toBeInstanceOf(DuplicateDispatchError);
    expect(error.message).not.toContain('DUPLICATE_DISPATCH');
  });

  it('keeps schedule conflicts on their existing non-duplicate code', async () => {
    const state = makeState();
    const client = installState(state);
    mocks.checkScheduleConflict.mockResolvedValueOnce({
      conflict: true,
      conflictingJobKey: 'AC-OTHER',
      conflictingDate: '2026-08-10',
      conflictingWindow: '9:00 AM - 11:00 AM',
      resolvedSchedule: {
        scheduledStart: new Date('2026-08-10T13:00:00.000Z'),
        scheduledEnd: new Date('2026-08-10T15:00:00.000Z'),
        appointmentDate: '2026-08-10',
        appointmentWindow: '9:00 AM - 11:00 AM',
      },
    });

    const error = await dispatchJobToContractor(
      JOB_ID,
      CONTRACTOR_ID,
      'corr-schedule',
    ).catch((err) => err);

    expect(error).toMatchObject({
      statusCode: 409,
      errorCode: 'CONTRACTOR_SCHEDULE_CONFLICT',
    });
    expect(error.message).not.toContain('DUPLICATE_DISPATCH');
    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(
      ([sql]) => String(sql).includes('INSERT INTO dispatches'),
    )).toBe(false);
  });

  it('keeps inactive-contractor conflicts free of the duplicate marker', async () => {
    const state = makeState({
      contractor: { ...makeState().contractor!, is_active: false },
    });
    installState(state);

    const error = await dispatchJobToContractor(
      JOB_ID,
      CONTRACTOR_ID,
      'corr-inactive',
    ).catch((err) => err);

    expect(error).toMatchObject({
      statusCode: 409,
      message: 'Contractor is not active',
    });
    expect(error).not.toBeInstanceOf(DuplicateDispatchError);
    expect(error.message).not.toContain('DUPLICATE_DISPATCH');
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it('keeps malformed-schedule conflicts free of the duplicate marker', async () => {
    const state = makeState({
      job: {
        ...makeState().job,
        scheduled_start_at: null,
        scheduled_end_at: null,
        appointment_date: 'not-a-date',
      },
    });
    installState(state);
    mocks.parseSchedule.mockImplementationOnce(() => {
      throw new Error('invalid schedule');
    });

    const error = await dispatchJobToContractor(
      JOB_ID,
      CONTRACTOR_ID,
      'corr-malformed',
    ).catch((err) => err);

    expect(error).toMatchObject({
      statusCode: 409,
      errorCode: 'SCHEDULE_PARSE_FAILED',
    });
    expect(error.message).not.toContain('DUPLICATE_DISPATCH');
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it('locks job before contractor, writes children before transition, and sends SMS after commit', async () => {
    const state = makeState();
    const events: string[] = [];
    const client = installState(state, events);
    mocks.sendSms.mockImplementationOnce(async () => {
      events.push('sms');
      return { messageId: null };
    });

    const result = await dispatchJobToContractor(
      JOB_ID,
      CONTRACTOR_ID,
      'corr-success',
    );

    const sql = client.query.mock.calls.map(([statement]) => String(statement));
    const jobLockIndex = sql.findIndex(
      (statement) => statement.includes('FROM jobs j') && statement.includes('FOR UPDATE'),
    );
    const winnerIndex = sql.findIndex((statement) => statement.includes('AS has_active_dispatch'));
    const contractorLockIndex = sql.findIndex(
      (statement) => statement.includes('FROM contractors') && statement.includes('FOR UPDATE'),
    );
    const dispatchInsertIndex = sql.findIndex((statement) => statement.includes('INSERT INTO dispatches'));
    const assignmentInsertIndex = sql.findIndex(
      (statement) => statement.includes('INSERT INTO contractor_assignments'),
    );
    const transitionIndex = sql.findIndex((statement) => statement.includes('UPDATE jobs SET status'));

    expect(jobLockIndex).toBeLessThan(winnerIndex);
    expect(winnerIndex).toBeLessThan(contractorLockIndex);
    expect(contractorLockIndex).toBeLessThan(dispatchInsertIndex);
    expect(dispatchInsertIndex).toBeLessThan(assignmentInsertIndex);
    expect(assignmentInsertIndex).toBeLessThan(transitionIndex);
    expect(client.query.mock.invocationCallOrder[transitionIndex])
      .toBeLessThan(mocks.recordAuditEvent.mock.invocationCallOrder[0]);
    expect(events).toEqual(['begin', 'commit', 'sms']);
    expect(result).toEqual({
      dispatchId: expect.any(String),
      assignmentId: expect.any(String),
      contractorId: CONTRACTOR_ID,
      jobId: JOB_ID,
      smsSent: true,
    });
  });

  it('allows dispatch, existing cancellation behavior, then legitimate redispatch', async () => {
    const state = makeState();
    installState(state);

    const first = await dispatchJobToContractor(
      JOB_ID,
      CONTRACTOR_ID,
      'corr-first',
    );
    expect(state.job.status).toBe('dispatch_in_progress');

    const cancellation = await cancelContractorAssignment(
      JOB_ID,
      'corr-cancel',
      first.assignmentId,
    );
    expect(cancellation.jobStatus).toBe('ready_for_dispatch');
    expect(state.assignments[0].status).toBe('cancelled');
    expect(state.dispatches[0].status).toBe('expired');

    const second = await dispatchJobToContractor(
      JOB_ID,
      CONTRACTOR_ID,
      'corr-redispatch',
    );

    expect(second.dispatchId).not.toBe(first.dispatchId);
    expect(second.assignmentId).not.toBe(first.assignmentId);
    expect(state.dispatches).toEqual([
      expect.objectContaining({ id: first.dispatchId, status: 'expired' }),
      expect.objectContaining({ id: second.dispatchId, status: 'sent' }),
    ]);
    expect(state.assignments).toEqual([
      expect.objectContaining({ id: first.assignmentId, status: 'cancelled' }),
      expect.objectContaining({ id: second.assignmentId, status: 'pending' }),
    ]);
    expect(mocks.sendSms).toHaveBeenCalledTimes(2);
  });
});
