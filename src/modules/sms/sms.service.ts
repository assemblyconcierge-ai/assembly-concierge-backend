/**
 * SMS Service
 *
 * Handles inbound contractor SMS commands from Quo webhooks.
 * Applies fuzzy keyword matching and drives job/dispatch state transitions.
 * Supports optional full job-key routing to resolve multi-job ambiguity.
 */

import { query, queryOne, withTransaction } from '../../db/pool';
import { assertTransition, JobStatus } from '../jobs/job.stateMachine';
import { recordAuditEvent } from '../audit/audit.service';
import { enqueueAirtableSync } from '../airtable-sync/airtableSync.queue';
import { sendSms } from './quo.adapter';
import { logger } from '../../common/logger';
import { normalizePhone, generateContractorCompletionToken } from '../../common/utils';
import { config } from '../../common/config';

export type SmsCommand = 'CONFIRM' | 'DECLINE' | 'OTW' | 'DONE' | 'FINISH';

export interface ParsedCommand {
  command: SmsCommand;
  /** Normalized job key (dashes removed, uppercase), or null when not present in message */
  jobKey: string | null;
}

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

// Matches AC-2026-EPME, AC2026EPME, ac-2026-epme, ac2026epme, etc.
const JOB_KEY_PATTERN = /\b(AC-?\d{4}-?[A-Z0-9]{4})\b/i;

/** Strip non-alphanumeric chars and uppercase - used for DB comparison via REPLACE(UPPER(...), '-', '') */
function extractJobKey(body: string): string | null {
  const match = JOB_KEY_PATTERN.exec(body);
  if (!match) return null;
  return match[1].replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * Fuzzy-match a raw SMS body against known command keyword lists.
 * Also extracts and normalizes an optional full job key (e.g. AC-2026-EPME -> AC2026EPME).
 */
export function parseCommand(body: string): ParsedCommand | null {
  const normalized = body.trim().toLowerCase();
  const jobKey = extractJobKey(body);

  let command: SmsCommand | null = null;
  if (CONFIRM_KEYWORDS.some((kw) => normalized.includes(kw))) command = 'CONFIRM';
  else if (DECLINE_KEYWORDS.some((kw) => normalized.includes(kw))) command = 'DECLINE';
  else if (OTW_KEYWORDS.some((kw) => normalized.includes(kw))) command = 'OTW';
  else if (FINISH_KEYWORDS.some((kw) => normalized.includes(kw))) command = 'FINISH';
  else if (DONE_KEYWORDS.some((kw) => normalized.includes(kw))) command = 'DONE';

  if (!command) return null;
  return { command, jobKey };
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
  /** Contractor packet token — MUST NOT be logged or included in audit payloads */
  contractor_packet_token: string | null;
  customer_phone: string;
  customer_otw_text_sent_at: Date | null;
  customer_confirm_text_sent_at: Date | null;
  address_line1: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_state: string | null;
  address_postal_code: string | null;
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

// Shared SELECT/FROM/WHERE for active SMS-routable jobs. Callers append key filter or ORDER BY.
const ACTIVE_JOB_BASE_SQL = `
  SELECT
    ca.id                        AS assignment_id,
    ca.status                    AS assignment_status,
    ca.dispatch_id,
    ca.contractor_packet_token,
    j.id                         AS job_id,
    j.job_key,
    j.status                     AS job_status,
    j.airtable_record_id,
    j.customer_otw_text_sent_at,
    j.customer_confirm_text_sent_at,
    cust.phone_e164              AS customer_phone,
    a.line1                      AS address_line1,
    a.line2                      AS address_line2,
    a.city                       AS address_city,
    a.state                      AS address_state,
    a.postal_code                AS address_postal_code
  FROM contractor_assignments ca
  JOIN jobs j ON j.id = ca.job_id
  JOIN customers cust ON cust.id = j.customer_id
  LEFT JOIN addresses a ON a.id = j.address_id
 WHERE ca.contractor_id = $1
   AND ca.status IN ('pending', 'accepted')
   AND j.status IN ('dispatch_in_progress', 'assigned')`;

interface WarnLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

function buildPostConfirmSms(activeJob: ActiveJobRow, _log: WarnLogger): string {
  const { job_key: jobKey, contractor_packet_token: token } = activeJob;

  if (token) {
    // Packet link flow: send the secure job packet URL.
    // The token value is NOT logged — it is only embedded in the SMS body.
    const baseUrl = config.APP_BASE_URL.replace(/\/+$/, '');
    const packetUrl = `${baseUrl}/public/contractor/jobs/${token}`;
    return [
      `Confirmed for ${jobKey}.`,
      '',
      'Your full job packet (address, photos, details):',
      packetUrl,
      '',
      `Reply OTW ${jobKey} when headed there.`,
      `Reply DONE ${jobKey} when complete.`,
    ].join('\n');
  }

  // Fallback: token not available (legacy assignment or generation failure)
  return [
    `Confirmed for ${jobKey}.`,
    '',
    'Job details will be provided separately.',
    '',
    `Reply OTW ${jobKey} when headed there.`,
    `Reply DONE ${jobKey} when complete.`,
  ].join('\n');
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

  const parsed = parseCommand(messageBody);
  if (!parsed) {
    log.info(
      { contractorId: contractor.id, messageBody },
      '[SMS] Message not recognized - ignoring',
    );
    return;
  }

  const { command, jobKey } = parsed;

  // Active job lookup with job-key routing
  let activeJobs: ActiveJobRow[];

  if (jobKey) {
    activeJobs = await query<ActiveJobRow>(
      `${ACTIVE_JOB_BASE_SQL}
         AND REPLACE(UPPER(j.job_key), '-', '') = $2`,
      [contractor.id, jobKey],
    );
    if (activeJobs.length === 0) {
      log.info(
        { contractorId: contractor.id, jobKey, command },
        '[SMS] No active job found for job key',
      );
      try {
        await sendSms(
          contractor.phone_e164,
          'We could not find an active Assembly Concierge job with that code. Please check the job code and try again.',
          correlationId,
        );
      } catch (err) {
        log.warn({ err }, '[SMS] Helper SMS for unknown job key failed');
      }
      return;
    }
    if (activeJobs.length > 1) {
      log.warn(
        { contractorId: contractor.id, jobKey, command, count: activeJobs.length },
        '[SMS] Multiple active jobs matched the same job key - data integrity issue, ignoring',
      );
      return;
    }
  } else {
    activeJobs = await query<ActiveJobRow>(
      `${ACTIVE_JOB_BASE_SQL}
       ORDER BY ca.assigned_at DESC`,
      [contractor.id],
    );
    if (activeJobs.length === 0) {
      log.info(
        { contractorId: contractor.id, command },
        '[SMS] No active job found for contractor - ignoring',
      );
      return;
    }
    if (activeJobs.length > 1) {
      log.warn(
        { contractorId: contractor.id, command, count: activeJobs.length },
        '[SMS] Multiple active jobs - ambiguous command, prompting contractor',
      );
      try {
        const keyList = activeJobs.map((j) => j.job_key).join('\n');
        const ambiguityMsg = [
          'You have multiple active Assembly Concierge jobs. Please include the job code with your reply.',
          '',
          'Active job codes:',
          keyList,
          '',
          'Example format:',
          'OTW [job code]',
          'DONE [job code]',
          'CONFIRM [job code]',
        ].join('\n');
        await sendSms(contractor.phone_e164, ambiguityMsg, correlationId);
      } catch (err) {
        log.warn({ err }, '[SMS] Ambiguity helper SMS failed');
      }
      return;
    }
  }

  const activeJob = activeJobs[0];
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
    if (
      (command === 'OTW' || command === 'DONE' || command === 'FINISH') &&
      activeJob.assignment_status === 'pending'
    ) {
      const verb = command === 'OTW' ? 'sending OTW' : 'marking the job complete';
      const confirmFirst = [
        `Please confirm ${activeJob.job_key} first before ${verb}.`,
        '',
        'Reply:',
        `CONFIRM ${activeJob.job_key}`,
      ].join('\n');
      try {
        await sendSms(contractor.phone_e164, confirmFirst, correlationId);
      } catch (err) {
        log.warn({ err }, '[SMS] Confirm-first helper SMS failed');
      }
    }
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
      // Generate completion token with COALESCE so duplicate DONE/FINISH does not rotate it.
      // The token value is NOT logged — it is only embedded in the SMS body.
      const completionToken = generateContractorCompletionToken();
      await client.query(
        `UPDATE contractor_assignments
            SET contractor_completion_token = COALESCE(contractor_completion_token, $2)
          WHERE id = $1`,
        [activeJob.assignment_id, completionToken],
      );
      // Read back the persisted token (may differ from local if COALESCE kept an existing one)
      const tokenRow = await client.query<{ contractor_completion_token: string | null }>(
        `SELECT contractor_completion_token FROM contractor_assignments WHERE id = $1`,
        [activeJob.assignment_id],
      );
      (activeJob as ActiveJobRow & { contractor_completion_token: string | null }).contractor_completion_token =
        tokenRow.rows[0]?.contractor_completion_token ?? null;
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

  // Post-CONFIRM: send contractor address + reply instructions
  if (command === 'CONFIRM') {
    try {
      await sendSms(contractor.phone_e164, buildPostConfirmSms(activeJob, log), correlationId);
    } catch (err) {
      log.warn({ err }, '[SMS] Post-CONFIRM contractor SMS failed');
    }
  } else if (command === 'DECLINE') {
    // Post-DECLINE: acknowledgement only
    try {
      await sendSms(
        contractor.phone_e164,
        `Declined ${activeJob.job_key}. No further action needed.`,
        correlationId,
      );
    } catch (err) {
      log.warn({ err }, '[SMS] Post-DECLINE contractor SMS failed');
    }
  } else if (command === 'DONE' || command === 'FINISH') {
    // Post-DONE/FINISH: completion acknowledgement with photo upload link
    try {
      const cctRow = await queryOne<{ contractor_completion_token: string | null }>(
        `SELECT contractor_completion_token FROM contractor_assignments WHERE id = $1`,
        [activeJob.assignment_id],
      );
      const cct = cctRow?.contractor_completion_token ?? null;
      let smsBody: string;
      if (cct) {
        const baseUrl = config.APP_BASE_URL.replace(/\/+$/, '');
        const uploadUrl = `${baseUrl}/public/contractor/completion/${cct}`;
        smsBody = [
          `Thanks \u2014 completion reported for ${activeJob.job_key}.`,
          '',
          'Upload your completion photos here:',
          uploadUrl,
        ].join('\n');
      } else {
        smsBody = `Thanks \u2014 completion reported for ${activeJob.job_key}. Assembly Concierge will review the job.`;
      }
      await sendSms(contractor.phone_e164, smsBody, correlationId);
    } catch (err) {
      log.warn({ err }, '[SMS] Post-DONE contractor SMS failed');
    }
  }

  if (command === 'CONFIRM' && !activeJob.customer_confirm_text_sent_at) {
    try {
      const phone = activeJob.customer_phone;
      if (!phone) {
        await query(
          `UPDATE jobs SET customer_confirm_text_status = $2, updated_at = NOW() WHERE id = $1`,
          [activeJob.job_id, 'skipped'],
        );
      } else {
        const message =
          "Assembly Concierge update: Your contractor has confirmed your job. We'll text you again when they're on the way.";
        let confirmTextStatus: 'sent' | 'failed' | 'skipped' = 'skipped';
        let confirmSentAt: string | null = null;
        try {
          const result = await sendSms(phone, message, correlationId);
          if (result.messageId) {
            confirmTextStatus = 'sent';
            confirmSentAt = new Date().toISOString();
          }
        } catch (smsErr) {
          confirmTextStatus = 'failed';
          log.warn({ err: smsErr }, '[SMS] Customer confirmation SMS failed');
        }
        await query(
          `UPDATE jobs SET customer_confirm_text_sent_at = $2, customer_confirm_text_status = $3, updated_at = NOW() WHERE id = $1`,
          [activeJob.job_id, confirmSentAt, confirmTextStatus],
        );
      }
    } catch (err) {
      log.warn({ err }, '[SMS] Customer confirmation SMS block failed');
    }
  }

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
