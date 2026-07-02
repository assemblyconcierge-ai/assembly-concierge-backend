/**
 * email_events.repository.ts
 *
 * Database operations for the email_events table.
 *
 * Idempotency strategy:
 *   The unique indexes on (event_type, related_job_id) and
 *   (event_type, related_contractor_id) enforce one row per email event
 *   regardless of status. INSERT is attempted first; a conflict means the
 *   event was already reserved by an earlier request.
 *
 *   - reserveEmailEvent: INSERT ... ON CONFLICT DO NOTHING RETURNING *.
 *     Returns { row, alreadyExists: false } on success.
 *     Returns { row: existingRow, alreadyExists: true } on conflict.
 *
 *   - reserveEmailEventForResend: INSERT ... ON CONFLICT DO UPDATE (reset to pending).
 *     Always returns the row. Used when forceResend=true.
 */

import { query, queryOne } from '../../db/pool';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EmailEventStatus = 'pending' | 'sent' | 'failed';
export type EmailRecipientType = 'customer' | 'contractor';

export interface EmailEventRow {
  id: string;
  recipient_email: string;
  recipient_type: EmailRecipientType;
  event_type: string;
  related_job_id: string | null;
  related_contractor_id: string | null;
  status: EmailEventStatus;
  provider_message_id: string | null;
  error_message: string | null;
  created_at: Date;
  sent_at: Date | null;
}

export interface ReserveEmailEventParams {
  recipientEmail: string;
  recipientType: EmailRecipientType;
  eventType: string;
  relatedJobId?: string | null;
  relatedContractorId?: string | null;
}

export interface ReserveEmailEventResult {
  row: EmailEventRow;
  /** true if the INSERT conflicted — event was already reserved by an earlier request */
  alreadyExists: boolean;
}

// ── Repository functions ───────────────────────────────────────────────────────

/**
 * Attempt to reserve an email event row.
 *
 * On INSERT success: returns { row, alreadyExists: false }.
 * On INSERT conflict (unique index): looks up the existing row and returns
 *   { row: existingRow, alreadyExists: true }.
 *
 * This is the primary idempotency guard. The INSERT reserves the slot
 * immediately so concurrent requests cannot both proceed.
 */
export async function reserveEmailEvent(
  params: ReserveEmailEventParams,
): Promise<ReserveEmailEventResult> {
  const newRow = await queryOne<EmailEventRow>(
    `INSERT INTO email_events
       (recipient_email, recipient_type, event_type, related_job_id, related_contractor_id, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      params.recipientEmail,
      params.recipientType,
      params.eventType,
      params.relatedJobId ?? null,
      params.relatedContractorId ?? null,
    ],
  );

  if (newRow) {
    return { row: newRow, alreadyExists: false };
  }

  // Conflict — look up the existing row
  const existing = await _findExistingEvent(params);
  if (!existing) {
    // Should not happen, but guard against it
    throw new Error(
      `[email_events] INSERT conflicted but no existing row found for event_type=${params.eventType}`,
    );
  }
  return { row: existing, alreadyExists: true };
}

/**
 * Reserve or reset an email event row for a forced resend.
 *
 * If no row exists: INSERT as pending.
 * If a row exists: UPDATE it back to pending (clears sent/failed state).
 *
 * Used when forceResend=true on contractor onboarding emails.
 */
export async function reserveEmailEventForResend(
  params: ReserveEmailEventParams,
): Promise<EmailEventRow> {
  const row = await queryOne<EmailEventRow>(
    `INSERT INTO email_events
       (recipient_email, recipient_type, event_type, related_job_id, related_contractor_id, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT (event_type, related_contractor_id)
     WHERE related_contractor_id IS NOT NULL
     DO UPDATE SET
       recipient_email     = EXCLUDED.recipient_email,
       status              = 'pending',
       provider_message_id = NULL,
       error_message       = NULL,
       sent_at             = NULL
     RETURNING *`,
    [
      params.recipientEmail,
      params.recipientType,
      params.eventType,
      params.relatedJobId ?? null,
      params.relatedContractorId ?? null,
    ],
  );

  if (!row) throw new Error('[email_events] reserveEmailEventForResend returned no row');
  return row;
}

/**
 * Mark an email event as 'sent' with the provider message ID and timestamp.
 */
export async function markEmailEventSent(
  eventId: string,
  providerMessageId: string,
): Promise<void> {
  await query(
    `UPDATE email_events
        SET status = 'sent',
            provider_message_id = $2,
            sent_at = NOW()
      WHERE id = $1`,
    [eventId, providerMessageId],
  );
}

/**
 * Mark an email event as 'failed' with an error message.
 */
export async function markEmailEventFailed(
  eventId: string,
  errorMessage: string,
): Promise<void> {
  await query(
    `UPDATE email_events
        SET status = 'failed',
            error_message = $2
      WHERE id = $1`,
    [eventId, errorMessage],
  );
}

// ── Internal helpers ───────────────────────────────────────────────────────────

async function _findExistingEvent(
  params: Pick<ReserveEmailEventParams, 'eventType' | 'relatedJobId' | 'relatedContractorId'>,
): Promise<EmailEventRow | null> {
  if (params.relatedJobId) {
    return queryOne<EmailEventRow>(
      `SELECT * FROM email_events
        WHERE event_type = $1 AND related_job_id = $2
        LIMIT 1`,
      [params.eventType, params.relatedJobId],
    );
  }
  if (params.relatedContractorId) {
    return queryOne<EmailEventRow>(
      `SELECT * FROM email_events
        WHERE event_type = $1 AND related_contractor_id = $2
        LIMIT 1`,
      [params.eventType, params.relatedContractorId],
    );
  }
  return null;
}
