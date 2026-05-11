/**
 * SMS Service
 *
 * Handles inbound contractor SMS commands from Quo webhooks.
 * Applies fuzzy keyword matching and drives job/dispatch state transitions.
 */

import { queryOne, withTransaction, query } from '../../db/pool';
import { assertTransition, JobStatus } from '../jobs/job.stateMachine';
import { recordAuditEvent } from '../audit/audit.service';
import { enqueueAirtableSync } from '../airtable-sync/airtableSync.queue';
import { sendSms } from './quo.adapter';
import { logger } from '../../common/logger';
import { normalizePhone } from '../../common/utils';

export type SmsCommand = 'CONFIRM' | 'DECLINE' | 'OTW' | 'DONE' | 'FINISH';

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

/**
 * Fuzzy-match a raw SMS body against known command keyword lists.
 */
export function parseCommand(body: string): SmsCommand | null {
  const normalized = body.trim().toLowerCase();
  if (CONFIRM_KEYWORDS.some((kw) => normalized.includes(kw))) return 'CONFIRM';
  if (DECLINE_KEYWORDS.some((kw) => normalized.includes(kw))) return 'DECLINE';
  if (OTW_KEYWORDS.some((kw) => normalized.includes(kw))) return 'OTW';
  if (FINISH_KEYWORDS.some((kw) => normalized.includes(kw))) return 'FINISH';
  if (DONE_KEYWORDS.some((kw) => normalized.includes(kw))) return 'DONE';
  return null;
}

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
  customer_phone: string;
  customer_otw_text_sent_at: Date | null;
}

type AssignmentStatus = 'pending' | 'accepted';

interface CommandRule {
  assignmentStatuses: ReadonlySet<AssignmentStatus>;
  jobStatuses: ReadonlySet<JobStatus>;
  targetJobStatus: JobStatus | null;
}

const COMMAND_RULES: Record<SmsCommand, CommandRule> = {
  CONFIRM: {
    assignmentStatuses: new Set(['pending']),
    jobStatuses: new Set(['dispatch_in_progress']),
    targetJobStatus: 'assigned',
  },
  DECLINE: {
    assignmentStatuses: new Set(['pending', 'accepted']),
    jobStatuses: new Set(['dispatch_in_progress', 'assigned']),
    targetJobStatus: 'ready_for_dispatch',
  },
  OTW: {
    assignmentStatuses: new Set(['accepted']),
    jobStatuses: new Set(['assigned']),
    targetJobStatus: null,
  },
  DONE: {
    assignmentStatuses: new Set(['accepted']),
    jobStatuses: new Set(['assigned']),
    targetJobStatus: 'completion_reported',
  },
  FINISH: {
    assignmentStatuses: new Set(['accepted']),
    jobStatuses: new Set(['assigned']),
    targetJobStatus: 'completion_reported',
  },
};

function isAssignmentStatus(status: string): status is AssignmentStatus {
  return status === 'pending' || status === 'accepted';
}

function isCommandAllowed(command: SmsCommand, activeJob: ActiveJobRow): boolean {
  const rule = COMMAND_RULES[command];
  return (
    isAssignmentStatus(activeJob.assignment_status) &&
    rule.assignmentStatuses.has(activeJob.assignment_status) &&
    rule.jobStatuses.has(activeJob.job_status)
  );
}

export async function processSmsWebhook(
  rawPhone: string,
  messageBody: string,
  correlationId: string,
): Promise<void> {
  const log = logger.child({ correlationId, handler: 'sms-webhook' });

  const phoneE164 = normalizePhone(rawPhone);

  const contractor = await queryOne<ContractorRow>(
    `SELECT id, full_name, phone_e164
       FROM contractors
      WHERE phone_e164 = $1
        AND is_active = TRUE`,
    [phoneE164],
  );

  if (!contractor) {
    log.info({ phoneE164 }, '[SMS] No active contractor found for phone - ignoring');
    return;
  }

  const command = parseCommand(messageBody);
  if (!command) {
    log.info(
      { contractorId: contractor.id, messageBody },
      '[SMS] Message not recognized - ignoring',
    );
    return;
  }

  const activeJob = await queryOne<ActiveJobRow>(
    `SELECT
       ca.id                        AS assignment_id,
       ca.status                    AS assignment_status,
       ca.dispatch_id,
       j.id                         AS job_id,
       j.job_key,
       j.status                     AS job_status,
       j.airtable_record_id,
       j.customer_otw_text_sent_at,
       cust.phone_e164              AS customer_phone
     FROM contractor_assignments ca
     JOIN jobs j ON j.id = ca.job_id
     JOIN customers cust ON cust.id = j.customer_id
    WHERE ca.contractor_id = $1
      AND ca.status IN ('pending', 'accepted')
      AND j.status IN ('dispatch_in_progress', 'assigned')
    ORDER BY ca.assigned_at DESC
    LIMIT 1`,
    [contractor.id],
  );

  if (!activeJob) {
    log.info(
      { contractorId: contractor.id, command },
      '[SMS] No active job found for contractor - ignoring',
    );
    return;
  }

  const rule = COMMAND_RULES[command];

  if (!isCommandAllowed(command, activeJob)) {
    log.warn(
      {
        contractorId: contractor.id,
        jobId: activeJob.job_id,
        jobKey: activeJob.job_key,
        command,
        jobStatus: activeJob.job_status,
        assignmentStatus: activeJob.assignment_status,
      },
      '[SMS] Command not valid for current assignment/job state - ignoring',
    );
    return;
  }

  if (rule.targetJobStatus) {
    try {
      assertTransition(activeJob.job_status, rule.targetJobStatus);
    } catch (err) {
      log.warn(
        {
          err,
          contractorId: contractor.id,
          jobId: activeJob.job_id,
          jobKey: activeJob.job_key,
          command,
          from: activeJob.job_status,
          to: rule.targetJobStatus,
        },
        '[SMS] Command target transition rejected by state machine - ignoring',
      );
      return;
    }
  }

  await withTransaction(async (client) => {
    if (rule.targetJobStatus) {
      const isCompletion = rule.targetJobStatus === 'completion_reported';
      await client.query(
        isCompletion
          ? 'UPDATE jobs SET status = $2, completion_reported_at = NOW(), updated_at = NOW() WHERE id = $1'
          : 'UPDATE jobs SET status = $2, updated_at = NOW() WHERE id = $1',
        [activeJob.job_id, rule.targetJobStatus],
      );
    }

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
      await client.query(
        `UPDATE contractor_assignments
            SET status = 'completed', completed_at = NOW()
          WHERE id = $1`,
        [activeJob.assignment_id],
      );
    } else if (command === 'OTW') {
      await client.query(
        `UPDATE jobs
            SET contractor_en_route_at = COALESCE(contractor_en_route_at, NOW()),
                updated_at = NOW()
          WHERE id = $1`,
        [activeJob.job_id],
      );
    }

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
        toStatus: rule.targetJobStatus ?? activeJob.job_status,
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
      to: rule.targetJobStatus ?? activeJob.job_status,
    },
    '[SMS] Command processed',
  );

  if (command === 'OTW') {
    try {
      const currentJob = await queryOne<{ customer_otw_text_sent_at: Date | null }>(
        'SELECT customer_otw_text_sent_at FROM jobs WHERE id = $1',
        [activeJob.job_id],
      );
      if (!currentJob?.customer_otw_text_sent_at) {
        const phone = activeJob.customer_phone;

        if (!phone) {
          await query(
            `UPDATE jobs SET customer_otw_text_status = $2, updated_at = NOW() WHERE id = $1`,
            [activeJob.job_id, 'skipped'],
          );
        } else {
          const firstName = contractor.full_name.split(' ')[0];
          const message = firstName
            ? `Your Assembly Concierge contractor, ${firstName}, is on the way for your appointment. Please keep your phone nearby in case they need to reach you.`
            : 'Your Assembly Concierge contractor is on the way for your appointment. Please keep your phone nearby in case they need to reach you.';

          let textStatus: 'sent' | 'failed' | 'skipped' = 'skipped';
          let sentAt: string | null = null;

          try {
            const result = await sendSms(phone, message, correlationId);
            if (result.messageId) {
              textStatus = 'sent';
              sentAt = new Date().toISOString();
            } else {
              textStatus = 'skipped';
            }
          } catch (smsErr) {
            textStatus = 'failed';
            log.warn({ err: smsErr }, '[SMS] Customer OTW notification failed');
          }

          await query(
            `UPDATE jobs SET customer_otw_text_sent_at = $2, customer_otw_text_status = $3, updated_at = NOW() WHERE id = $1`,
            [activeJob.job_id, sentAt, textStatus],
          );
        }
      }
    } catch (err) {
      log.warn({ err }, '[SMS] Customer OTW notification block failed');
    }
  }

  try {
    await enqueueAirtableSync({ jobId: activeJob.job_id, correlationId });
  } catch (err) {
    log.warn({ err }, '[SMS] Airtable sync enqueue failed after SMS command');
  }
}
