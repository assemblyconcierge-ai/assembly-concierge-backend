/**
 * Dispatch Service
 *
 * Sends a job dispatch SMS to a contractor and records all related DB state:
 * dispatches row, contractor_assignments row, job status transition, audit event.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryOne, withTransaction, query } from '../../db/pool';
import { getJobById, updateJobStatus } from '../jobs/job.repository';
import { assertTransition } from '../jobs/job.stateMachine';
import { recordAuditEvent } from '../audit/audit.service';
import { enqueueAirtableSync } from '../airtable-sync/airtableSync.queue';
import { sendSms } from '../sms/quo.adapter';
import { logger } from '../../common/logger';
import { parseSchedule } from '../../common/utils/scheduleUtils';
import { checkScheduleConflict } from './dispatchConflict';
import { generateContractorPacketToken } from '../../common/utils';

interface ContractorRow {
  id: string;
  full_name: string;
  phone_e164: string;
  is_active: boolean;
}

interface ServiceTypeRow {
  display_name: string;
  code: string;
}

export interface DispatchResult {
  dispatchId: string;
  assignmentId: string;
  contractorId: string;
  jobId: string;
  smsSent: boolean;
}

/** Format cents as a dollar string, no trailing .00 for whole numbers */
function formatDollars(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2);
}

/** Build the SMS message body sent to the contractor at dispatch time */
function buildDispatchMessage(
  serviceTypeName: string,
  city: string,
  contractorPayCents: number,
  jobKey: string,
): string {
  return [
    `AC JOB - ${serviceTypeName}`,
    `${city}, GA`,
    `Pay: $${formatDollars(contractorPayCents)}`,
    '',
    `Reply CONFIRM ${jobKey} to accept this job`,
    `Reply DECLINE ${jobKey} if you are not available`,
  ].join('\n');
}

export async function dispatchJobToContractor(
  jobId: string,
  contractorId: string,
  correlationId: string,
): Promise<DispatchResult> {
  const log = logger.child({ correlationId, jobId, contractorId, service: 'dispatch' });

  // ── Validate job ──────────────────────────────────────────────────────────
  const job = await getJobById(jobId);
  if (!job) {
    throw Object.assign(new Error('Job not found'), { statusCode: 404 });
  }
  if (job.status !== 'ready_for_dispatch') {
    throw Object.assign(
      new Error(`Job must be at ready_for_dispatch to dispatch (current: ${job.status})`),
      { statusCode: 409 },
    );
  }

  // ── Validate contractor ───────────────────────────────────────────────────
  const contractor = await queryOne<ContractorRow>(
    'SELECT id, full_name, phone_e164, is_active FROM contractors WHERE id = $1',
    [contractorId],
  );
  if (!contractor) {
    throw Object.assign(new Error('Contractor not found'), { statusCode: 404 });
  }
  if (!contractor.is_active) {
    throw Object.assign(new Error('Contractor is not active'), { statusCode: 409 });
  }

  // ── Fetch service type display name ───────────────────────────────────────
  const serviceType = await queryOne<ServiceTypeRow>(
    'SELECT display_name, code FROM service_types WHERE id = $1',
    [job.service_type_id],
  );
  const serviceTypeName = serviceType?.display_name ?? serviceType?.code ?? 'Assembly';
  const city = job.city_detected ?? 'Unknown City';

  const dispatchId = uuidv4();
  const assignmentId = uuidv4();
  const now = new Date().toISOString();
  // Generate contractor packet token — inert until assignment status = accepted.
  // MUST NOT be logged or included in audit payloads.
  const contractorPacketToken = generateContractorPacketToken();

  // ── DB transaction ────────────────────────────────────────────────────────
  await withTransaction(async (client) => {
    // 0a. Lock contractor row to prevent concurrent dispatches
    await client.query(
      'SELECT id FROM contractors WHERE id = $1 FOR UPDATE',
      [contractor.id],
    );

    // 0b. Resolve current job schedule (re-read inside transaction for consistency)
    const scheduleRow = await client.query<{
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
      [job.id],
    );
    if (scheduleRow.rowCount === 0) {
      throw Object.assign(
        new Error('Job not found while resolving schedule.'),
        { statusCode: 404 },
      );
    }
    const sr = scheduleRow.rows[0];

    let currentScheduledStart: Date;
    let currentScheduledEnd: Date;
    const tz = sr.timezone ?? 'America/New_York';

    if (sr.scheduled_start_at && sr.scheduled_end_at) {
      // Already computed — use stored values
      currentScheduledStart = sr.scheduled_start_at;
      currentScheduledEnd   = sr.scheduled_end_at;
    } else {
      // Derive from appointment fields
      if (!sr.appointment_date || !sr.appointment_window) {
        throw Object.assign(
          new Error('Dispatch cannot proceed without a valid appointment schedule.'),
          { statusCode: 409, errorCode: 'SCHEDULE_PARSE_FAILED' },
        );
      }
      let parsed: { scheduledStartAt: Date; scheduledEndAt: Date };
      try {
        parsed = parseSchedule(sr.appointment_date, sr.appointment_window, tz);
      } catch {
        throw Object.assign(
          new Error('Dispatch cannot proceed without a valid appointment schedule.'),
          { statusCode: 409, errorCode: 'SCHEDULE_PARSE_FAILED' },
        );
      }
      currentScheduledStart = parsed.scheduledStartAt;
      currentScheduledEnd   = parsed.scheduledEndAt;

      // Persist the derived schedule so future reads are fast
      await client.query(
        `UPDATE jobs
           SET scheduled_start_at = $1,
               scheduled_end_at   = $2,
               timezone           = $3,
               updated_at         = NOW()
         WHERE id = $4`,
        [currentScheduledStart, currentScheduledEnd, tz, job.id],
      );
    }

    // 0c. Schedule-overlap conflict check (shared helper — also used by precheck endpoint)
    const conflictCheck = await checkScheduleConflict(
      contractor.id,
      job.id,
      {
        scheduled_start_at: currentScheduledStart,
        scheduled_end_at: currentScheduledEnd,
        timezone: tz,
        appointment_date: sr.appointment_date,
        appointment_window: sr.appointment_window,
      },
      client,
    );
    if (conflictCheck.conflict) {
      throw Object.assign(
        new Error('Contractor is already scheduled during this appointment window.'),
        {
          statusCode: 409,
          errorCode: 'CONTRACTOR_SCHEDULE_CONFLICT',
          conflictingJobKey: conflictCheck.conflictingJobKey,
          conflictingDate: conflictCheck.conflictingDate,
          conflictingWindow: conflictCheck.conflictingWindow,
        },
      );
    }
    // 1. Transition job: ready_for_dispatch → dispatch_in_progress
    assertTransition(job.status, 'dispatch_in_progress');
    await client.query(
      'UPDATE jobs SET status = $2, updated_at = NOW() WHERE id = $1',
      [job.id, 'dispatch_in_progress'],
    );

    // 2. Create dispatches row
    await client.query(
      `INSERT INTO dispatches
         (id, job_id, status, sent_at, assigned_contractor_id, created_at, updated_at)
       VALUES ($1, $2, 'sent', $3, $4, $3, $3)`,
      [dispatchId, job.id, now, contractor.id],
    );

    // 3. Create contractor_assignments row (token is inert until status = accepted)
    await client.query(
      `INSERT INTO contractor_assignments
         (id, job_id, contractor_id, dispatch_id, payout_amount_cents, status, assigned_at, contractor_packet_token)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
      [assignmentId, job.id, contractor.id, dispatchId, job.contractor_total_payout_cents, now, contractorPacketToken],
    );

    // 4. Audit event
    await recordAuditEvent({
      aggregateType: 'job',
      aggregateId: job.id,
      eventType: 'dispatch.sent',
      actorType: 'admin',
      payload: {
        contractorId: contractor.id,
        contractorName: contractor.full_name,
        contractorPhone: contractor.phone_e164,
        dispatchId,
        assignmentId,
        serviceTypeName,
        city,
        contractorPayCents: job.contractor_total_payout_cents,
      },
      correlationId,
      client,
    });
  });

  log.info(
    { dispatchId, assignmentId, contractorPhone: contractor.phone_e164 },
    '[Dispatch] DB state committed — sending SMS',
  );

  // ── Send dispatch SMS (outside transaction) ───────────────────────────────
  const message = buildDispatchMessage(serviceTypeName, city, job.contractor_total_payout_cents, job.job_key);
  let smsSent = false;

  try {
    const { messageId } = await sendSms(contractor.phone_e164, message, correlationId);
    smsSent = true;

    // Store Quo message ID on the dispatch row if we got one back
    if (messageId) {
      await queryOne(
        'UPDATE dispatches SET provider_message_group_id = $2, updated_at = NOW() WHERE id = $1',
        [dispatchId, messageId],
      );
    }
  } catch (err) {
    // SMS failure is non-fatal — DB state is committed. Mark dispatch as failed
    // so the admin knows to retry, but do not roll back the job transition.
    log.error({ err, dispatchId }, '[Dispatch] SMS send failed — marking dispatch as failed');
    try {
      const errMsg = err instanceof Error ? err.message : String(err);
      await queryOne(
        `UPDATE dispatches SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
        [dispatchId, errMsg.slice(0, 500)],
      );
    } catch (updateErr) {
      log.error({ updateErr }, '[Dispatch] Failed to update dispatch status to failed');
    }
  }

  // ── Airtable sync ─────────────────────────────────────────────────────────
  try {
    await enqueueAirtableSync({ jobId: job.id, correlationId });
  } catch (err) {
    log.warn({ err }, '[Dispatch] Airtable sync enqueue failed');
  }

  log.info({ dispatchId, smsSent }, '[Dispatch] Dispatch complete');

  return { dispatchId, assignmentId, contractorId: contractor.id, jobId: job.id, smsSent };
}

// ── Cancel Assignment ─────────────────────────────────────────────────────────

export interface CancelAssignmentResult {
  success: true;
  jobId: string;
  cancelledAssignmentId: string;
  previousContractorId: string;
  jobStatus: 'ready_for_dispatch';
}

interface AssignmentRow {
  id: string;
  contractor_id: string;
  dispatch_id: string | null;
  status: string;
}

/** Job statuses from which an assignment can be cancelled */
const CANCELLABLE_JOB_STATUSES = new Set(['dispatch_in_progress', 'assigned']);

/**
 * Cancel an active contractor assignment and return the job to ready_for_dispatch.
 *
 * All reads and writes happen inside a single transaction with row-level locking
 * to prevent stale-read races. The assignment UPDATE is guarded by job_id and
 * active status so a concurrent cancellation cannot double-fire.
 *
 * - Does not send SMS.
 * - Does not touch payment, customer, schedule, or intake fields.
 * - Does not enqueue Airtable sync (caller may do so if desired).
 */
export async function cancelContractorAssignment(
  jobId: string,
  correlationId: string,
  assignmentId?: string,
): Promise<CancelAssignmentResult> {
  const log = logger.child({ correlationId, jobId, assignmentId, service: 'cancel-assignment' });

  // ── All reads + writes inside one transaction ─────────────────────────────
  let result!: CancelAssignmentResult;

  await withTransaction(async (client) => {
    // Step 0: Lock the job row for the duration of this transaction
    const jobRes = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM jobs WHERE id = $1 FOR UPDATE`,
      [jobId],
    );
    if (jobRes.rowCount === 0) {
      throw Object.assign(new Error('Job not found'), { statusCode: 404 });
    }
    const jobStatus = jobRes.rows[0].status;
    if (!CANCELLABLE_JOB_STATUSES.has(jobStatus)) {
      throw Object.assign(
        new Error(
          `Cannot cancel assignment: job is in state '${jobStatus}'. ` +
          `Only dispatch_in_progress and assigned jobs can have assignments cancelled.`,
        ),
        { statusCode: 409, errorCode: 'INVALID_JOB_STATE' },
      );
    }

    // Step 1: Read active assignments inside the transaction (consistent with the locked job row)
    const assignRes = await client.query<AssignmentRow>(
      `SELECT id, contractor_id, dispatch_id, status
         FROM contractor_assignments
        WHERE job_id = $1
          AND status IN ('pending', 'accepted')
        ORDER BY assigned_at DESC`,
      [jobId],
    );
    const activeRows = assignRes.rows;

    let targetAssignment: AssignmentRow;
    if (assignmentId) {
      const found = activeRows.find((r) => r.id === assignmentId);
      if (!found) {
        throw Object.assign(
          new Error(`No active assignment found with id ${assignmentId} for this job.`),
          { statusCode: 404 },
        );
      }
      targetAssignment = found;
    } else {
      if (activeRows.length === 0) {
        throw Object.assign(
          new Error('No active assignment exists for this job.'),
          { statusCode: 409, errorCode: 'NO_ACTIVE_ASSIGNMENT' },
        );
      }
      if (activeRows.length > 1) {
        throw Object.assign(
          new Error(
            `Multiple active assignments exist for this job (${activeRows.length}). ` +
            'Provide assignmentId to specify which one to cancel.',
          ),
          { statusCode: 409, errorCode: 'MULTIPLE_ACTIVE_ASSIGNMENTS' },
        );
      }
      targetAssignment = activeRows[0];
    }

    // Step 2: Cancel the assignment — guarded by id + job_id + active status
    // Note: contractor_assignments has no updated_at column.
    const cancelRes = await client.query(
      `UPDATE contractor_assignments
          SET status = 'cancelled'
        WHERE id = $1
          AND job_id = $2
          AND status IN ('pending', 'accepted')
        RETURNING id`,
      [targetAssignment.id, jobId],
    );
    if (cancelRes.rowCount !== 1) {
      // Another concurrent request already cancelled this assignment
      throw Object.assign(
        new Error('Assignment was already cancelled or is no longer active.'),
        { statusCode: 409, errorCode: 'ASSIGNMENT_ALREADY_CANCELLED' },
      );
    }

    // Step 3: Expire the related dispatch row (if one exists)
    if (targetAssignment.dispatch_id) {
      await client.query(
        `UPDATE dispatches
            SET status = 'expired', updated_at = NOW()
          WHERE id = $1`,
        [targetAssignment.dispatch_id],
      );
    }

    // Step 4: Return job to ready_for_dispatch (state machine validates the transition)
    assertTransition(jobStatus as any, 'ready_for_dispatch');
    await client.query(
      `UPDATE jobs SET status = 'ready_for_dispatch', updated_at = NOW() WHERE id = $1`,
      [jobId],
    );

    // Step 5: Audit event
    await recordAuditEvent({
      aggregateType: 'job',
      aggregateId: jobId,
      eventType: 'dispatch.assignment_cancelled',
      actorType: 'admin',
      payload: {
        cancelledAssignmentId: targetAssignment.id,
        previousContractorId: targetAssignment.contractor_id,
        dispatchId: targetAssignment.dispatch_id,
        previousJobStatus: jobStatus,
      },
      correlationId,
      client,
    });

    result = {
      success: true,
      jobId,
      cancelledAssignmentId: targetAssignment.id,
      previousContractorId: targetAssignment.contractor_id,
      jobStatus: 'ready_for_dispatch',
    };
  });

  log.info(
    { cancelledAssignmentId: result.cancelledAssignmentId, previousContractorId: result.previousContractorId },
    '[CancelAssignment] Assignment cancelled — job returned to ready_for_dispatch',
  );

  return result;
}

// ── Cancel Job ────────────────────────────────────────────────────────────────

export interface CancelJobResult {
  success: true;
  jobId: string;
  previousJobStatus: string;
  cancelledAssignmentCount: number;
  expiredDispatchCount: number;
}

/**
 * Cancel a job, bulk-cancel all active contractor assignments, expire related
 * dispatches, and write an audit event — all inside one transaction.
 *
 * - Does not send SMS.
 * - Does not touch payment records.
 * - Caller is responsible for calling enqueueAirtableSync after this returns.
 */
export async function cancelJob(
  jobId: string,
  correlationId: string,
  reason?: string,
): Promise<CancelJobResult> {
  const log = logger.child({ correlationId, jobId, service: 'cancel-job' });

  let result!: CancelJobResult;

  await withTransaction(async (client) => {
    // Step 0: Lock the job row for the duration of this transaction
    const jobRes = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM jobs WHERE id = $1 FOR UPDATE`,
      [jobId],
    );
    if (jobRes.rowCount === 0) {
      throw Object.assign(new Error('Job not found'), { statusCode: 404 });
    }
    const previousJobStatus = jobRes.rows[0].status;

    // Step 1: Validate transition (throws on terminal states: closed_paid, cancelled)
    assertTransition(previousJobStatus as any, 'cancelled');

    // Step 2: Bulk-cancel all active contractor assignments for this job
    const assignRes = await client.query<{ id: string; dispatch_id: string | null }>(
      `UPDATE contractor_assignments
          SET status = 'cancelled'
        WHERE job_id = $1
          AND status IN ('pending', 'accepted')
        RETURNING id, dispatch_id`,
      [jobId],
    );
    const cancelledAssignmentCount = assignRes.rowCount ?? 0;
    const dispatchIds = assignRes.rows
      .map((r) => r.dispatch_id)
      .filter((d): d is string => d !== null);

    // Step 3: Bulk-expire related dispatch rows
    let expiredDispatchCount = 0;
    if (dispatchIds.length > 0) {
      const expireRes = await client.query(
        `UPDATE dispatches
            SET status = 'expired', updated_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [dispatchIds],
      );
      expiredDispatchCount = expireRes.rowCount ?? 0;
    }

    // Step 4: Set job status to cancelled (uses shared updateJobStatus helper with client)
    await updateJobStatus(jobId, 'cancelled', client);

    // Step 5: Write audit event inside the transaction
    await recordAuditEvent({
      aggregateType: 'job',
      aggregateId: jobId,
      eventType: 'job.cancelled',
      actorType: 'admin',
      payload: {
        reason: reason ?? null,
        previousJobStatus,
        cancelledAssignmentCount,
        expiredDispatchCount,
      },
      correlationId,
      client,
    });

    result = {
      success: true,
      jobId,
      previousJobStatus,
      cancelledAssignmentCount,
      expiredDispatchCount,
    };
  });

  log.info(
    {
      previousJobStatus: result.previousJobStatus,
      cancelledAssignmentCount: result.cancelledAssignmentCount,
      expiredDispatchCount: result.expiredDispatchCount,
    },
    '[CancelJob] Job cancelled',
  );

  return result;
}
