/**
 * Dispatch Service
 *
 * Sends a job dispatch SMS to a contractor and records all related DB state:
 * dispatches row, contractor_assignments row, job status transition, audit event.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryOne, withTransaction } from '../../db/pool';
import { getJobById } from '../jobs/job.repository';
import { assertTransition } from '../jobs/job.stateMachine';
import { recordAuditEvent } from '../audit/audit.service';
import { enqueueAirtableSync } from '../airtable-sync/airtableSync.queue';
import { sendSms } from '../sms/quo.adapter';
import { logger } from '../../common/logger';

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

/** Build the SMS message body sent to the contractor */
function buildDispatchMessage(
  serviceTypeName: string,
  city: string,
  contractorPayCents: number,
): string {
  return [
    `AC JOB - ${serviceTypeName}`,
    `${city}, GA`,
    `Pay: $${formatDollars(contractorPayCents)}`,
    '',
    'Reply CONFIRM to accept',
    'Reply DECLINE to pass',
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

  // ── DB transaction ────────────────────────────────────────────────────────
  await withTransaction(async (client) => {
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

    // 3. Create contractor_assignments row
    await client.query(
      `INSERT INTO contractor_assignments
         (id, job_id, contractor_id, dispatch_id, payout_amount_cents, status, assigned_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
      [assignmentId, job.id, contractor.id, dispatchId, job.contractor_total_payout_cents, now],
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
  const message = buildDispatchMessage(serviceTypeName, city, job.contractor_total_payout_cents);
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
