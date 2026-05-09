/**
 * SMS Service
 *
 * Handles inbound contractor SMS commands from Quo webhooks.
 * Applies fuzzy keyword matching and drives job/dispatch state transitions.
 */

import { queryOne, withTransaction } from '../../db/pool';
import { assertTransition, JobStatus } from '../jobs/job.stateMachine';
import { recordAuditEvent } from '../audit/audit.service';
import { enqueueAirtableSync } from '../airtable-sync/airtableSync.queue';
import { logger } from '../../common/logger';
import { normalizePhone } from '../../common/utils';

// ── Command types ─────────────────────────────────────────────────────────────

export type SmsCommand = 'CONFIRM' | 'DECLINE' | 'OTW' | 'DONE' | 'FINISH';

// ── Keyword lists ─────────────────────────────────────────────────────────────

const CONFIRM_KEYWORDS = [
  'confirm', 'yes', 'yeah', 'ok', 'sure', 'accept',
  'yep', 'absolutely', "ill take it", "i'll take it",
];
const DECLINE_KEYWORDS = [
  'decline', 'no', "cant", "can't", 'pass', 'nope',
  'not available', 'sorry',
];
const OTW_KEYWORDS = [
  'otw', 'on my way', 'heading over', 'leaving now',
  'omw', 'headed there',
];
const DONE_KEYWORDS = [
  'done', 'finished', 'complete', 'completed',
  'all done', 'job done', 'finished up',
];
const FINISH_KEYWORDS = [
  'finish', 'job finished', 'work finished', 'job complete', 'work complete',
  'job completed', 'work completed', 'all finished',
];

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Fuzzy-match a raw SMS body against known command keyword lists.
 * Checks are ordered: CONFIRM before DECLINE so "yes" doesn't accidentally
 * match "sorry" type logic, and multi-word phrases are checked on normalized text.
 */
export function parseCommand(body: string): SmsCommand | null {
  const normalized = body.trim().toLowerCase();
  if (CONFIRM_KEYWORDS.some((kw) => normalized.includes(kw))) return 'CONFIRM';
  if (DECLINE_KEYWORDS.some((kw) => normalized.includes(kw))) return 'DECLINE';
  if (OTW_KEYWORDS.some((kw) => normalized.includes(kw))) return 'OTW';
  // FINISH is checked before DONE to avoid 'finished' matching DONE_KEYWORDS first.
  // Both commands resolve to completion_reported; DONE is kept for backward compat.
  if (FINISH_KEYWORDS.some((kw) => normalized.includes(kw))) return 'FINISH';
  if (DONE_KEYWORDS.some((kw) => normalized.includes(kw))) return 'DONE';
  return null;
}

// ── DB row types ──────────────────────────────────────────────────────────────

interface ContractorRow {
  id: string;
  full_name: string;
  phone_e164: string;
}

interface ActiveJobRow {
  job_id: string;
  job_key: string;
  job_status: JobStatus;
  airtable_record_id: string | null;
  assignment_id: string;
  assignment_status: string;
  dispatch_id: string | null;
}

// ── Target job status per command ─────────────────────────────────────────────
//
// OTW maps to 'assigned' so it does not advance the core job lifecycle state.
// The job stays assigned; OTW is an operational signal only (contractor en route).
// Customer notification / contractor_en_route_at fields will be added separately.

const COMMAND_TARGET_STATUS: Record<SmsCommand, JobStatus> = {
  CONFIRM: 'assigned',
  DECLINE: 'ready_for_dispatch',
  OTW:     'assigned',
  // DONE and FINISH both map to completion_reported — single contractor-reported completion state.
  // DONE is kept for backward compatibility; FINISH is the preferred keyword.
  DONE:    'completion_reported',
  FINISH:  'completion_reported',
};

// ── Main entry point ──────────────────────────────────────────────────────────

export async function processSmsWebhook(
  rawPhone: string,
  messageBody: string,
  correlationId: string,
): Promise<void> {
  const log = logger.child({ correlationId, handler: 'sms-webhook' });

  const phoneE164 = normalizePhone(rawPhone);

  // 1. Look up contractor by E.164 phone
  const contractor = await queryOne<ContractorRow>(
    `SELECT id, full_name, phone_e164
       FROM contractors
      WHERE phone_e164 = $1
        AND is_active = TRUE`,
    [phoneE164],
  );

  if (!contractor) {
    log.info({ phoneE164 }, '[SMS] No active contractor found for phone — ignoring');
    return;
  }

  // 2. Parse command
  const command = parseCommand(messageBody);
  if (!command) {
    log.info(
      { contractorId: contractor.id, messageBody },
      '[SMS] Message not recognized — ignoring',
    );
    return;
  }

  // 3. Find the active job assigned to this contractor
  //    Active statuses: dispatch_in_progress (awaiting confirm/decline),
  //    assigned or scheduled (awaiting OTW/DONE).
  const activeJob = await queryOne<ActiveJobRow>(
    `SELECT
       ca.id                AS assignment_id,
       ca.status            AS assignment_status,
       ca.dispatch_id,
       j.id                 AS job_id,
       j.job_key,
       j.status             AS job_status,
       j.airtable_record_id
     FROM contractor_assignments ca
     JOIN jobs j ON j.id = ca.job_id
    WHERE ca.contractor_id = $1
      AND ca.status IN ('pending', 'accepted')
      AND j.status IN ('dispatch_in_progress', 'assigned', 'scheduled')
    ORDER BY ca.assigned_at DESC
    LIMIT 1`,
    [contractor.id],
  );

  if (!activeJob) {
    log.info(
      { contractorId: contractor.id, command },
      '[SMS] No active job found for contractor — ignoring',
    );
    return;
  }

  const newJobStatus = COMMAND_TARGET_STATUS[command];

  // Guard: DONE/FINISH require an accepted assignment.
  // Without this check the state machine blocks the job transition but the
  // assignment side-effect still runs, leaving assignment.status = completed
  // on a pending assignment — corrupted state.
  if ((command === 'DONE' || command === 'FINISH') && activeJob.assignment_status !== 'accepted') {
    log.warn(
      {
        contractorId: contractor.id,
        jobId: activeJob.job_id,
        jobKey: activeJob.job_key,
        command,
        assignmentStatus: activeJob.assignment_status,
      },
      '[SMS] DONE/FINISH received before assignment accepted — ignoring',
    );
    return;
  }

  // 4. Apply state changes in a single transaction
  await withTransaction(async (client) => {
    // Job status transition
    try {
      assertTransition(activeJob.job_status, newJobStatus);
      const isCompletion = newJobStatus === 'completion_reported';
      await client.query(
        isCompletion
          ? 'UPDATE jobs SET status = $2, completion_reported_at = NOW(), updated_at = NOW() WHERE id = $1'
          : 'UPDATE jobs SET status = $2, updated_at = NOW() WHERE id = $1',
        [activeJob.job_id, newJobStatus],
      );
    } catch {
      // Already at target or transition not valid — log and continue so
      // dispatch/assignment side effects still apply.
      if (activeJob.job_status !== newJobStatus) {
        log.warn(
          { from: activeJob.job_status, to: newJobStatus, command },
          '[SMS] Job state transition not valid — skipping job status update',
        );
      }
    }

    // Command-specific side effects
    if (command === 'CONFIRM') {
      await client.query(
        `UPDATE contractor_assignments
            SET status = 'accepted', accepted_at = NOW()
          WHERE id = $1`,
        [activeJob.assignment_id],
      );
      if (activeJob.dispatch_id) {
        await client.query(
          `UPDATE dispatches
              SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
            WHERE id = $1`,
          [activeJob.dispatch_id],
        );
      }
    } else if (command === 'DECLINE') {
      await client.query(
        `UPDATE contractor_assignments
            SET status = 'declined'
          WHERE id = $1`,
        [activeJob.assignment_id],
      );
      if (activeJob.dispatch_id) {
        await client.query(
          `UPDATE dispatches
              SET status = 'declined',
                  assigned_contractor_id = NULL,
                  updated_at = NOW()
            WHERE id = $1`,
          [activeJob.dispatch_id],
        );
      }
    } else if (command === 'DONE' || command === 'FINISH') {
      // Both DONE and FINISH mark the assignment completed
      await client.query(
        `UPDATE contractor_assignments
            SET status = 'completed', completed_at = NOW()
          WHERE id = $1`,
        [activeJob.assignment_id],
      );
    }
    // OTW has no dispatch/assignment side effect beyond the job status update above

    // Audit record
    await recordAuditEvent({
      aggregateType: 'job',
      aggregateId: activeJob.job_id,
      eventType: `sms.command.${command.toLowerCase()}`,
      actorType: 'provider',
      payload: {
        contractorId: contractor.id,
        contractorName: contractor.full_name,
        phoneE164,
        messageBody,
        command,
        fromStatus: activeJob.job_status,
        toStatus: newJobStatus,
      },
      correlationId,
      client,
    });
  });

  log.info(
    {
      contractorId: contractor.id,
      jobId: activeJob.job_id,
      jobKey: activeJob.job_key,
      command,
      from: activeJob.job_status,
      to: newJobStatus,
    },
    '[SMS] Command processed',
  );

  // 5. Enqueue Airtable sync (fire-and-forget)
  try {
    await enqueueAirtableSync({ jobId: activeJob.job_id, correlationId });
  } catch (err) {
    log.warn({ err }, '[SMS] Airtable sync enqueue failed after SMS command');
  }
}
