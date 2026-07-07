/**
 * email.service.ts
 *
 * Orchestrates all outbound email for Assembly Concierge.
 *
 * Idempotency:
 *   The email_events table has unique indexes on (event_type, related_job_id)
 *   and (event_type, related_contractor_id). The INSERT in reserveEmailEvent
 *   uses ON CONFLICT DO NOTHING, so concurrent requests cannot both proceed.
 *   If the INSERT conflicts, the event was already reserved and we return
 *   alreadySent=true without calling Resend.
 *
 * EMAIL_SEND_MODE controls live sending:
 *   'log_only' (default): generate payload, reserve event row, do NOT call Resend.
 *   'send': call Resend, record provider_message_id and sent_at.
 *
 * All public functions are non-blocking — callers should fire-and-forget
 * (or await if they need the result) but email failures must never block
 * job closure, payment flow, or onboarding workflow.
 */

import { randomUUID } from 'crypto';
import { config } from '../../common/config';
import { logger } from '../../common/logger';
import { sendViaResend, ResendError } from './resend.adapter';
import {
  reserveEmailEvent,
  reserveEmailEventForResend,
  markEmailEventSent,
  markEmailEventFailed,
  EmailEventRow,
} from './email_events.repository';

// ── Constants ─────────────────────────────────────────────────────────────────

export const EMAIL_EVENT_TYPES = {
  CUSTOMER_JOB_COMPLETE: 'customer_job_complete',
  CONTRACTOR_ONBOARDING: 'contractor_onboarding',
} as const;

export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[keyof typeof EMAIL_EVENT_TYPES];

// ── Jotform URL builder ───────────────────────────────────────────────────────

export interface JotformPrefillParams {
  /** Airtable record ID — contractorRecord */
  airtableRecordId?: string | null;
  /** Backend contractor UUID — backendContractor */
  backendContractorId: string;
  /** Legal full name — typeA */
  legalFullName?: string | null;
  /** Preferred name — q5_textbox3 (only included if provided) */
  preferredName?: string | null;
  /** Phone E.164 — q6_phone4[full] and q7_phone5[full].
   * Stored as E.164 (+14147745236) but Jotform prefill receives 10-digit national
   * format (4147745236) to avoid Jotform misinterpreting the leading +1.
   */
  phoneE164?: string | null;
  /** Email — q8_email6 */
  email?: string | null;
}

/**
 * Convert a phone value to a 10-digit US national number for Jotform prefill.
 *
 * Jotform strips the '+' sign and treats the first 10 digits as the number,
 * so E.164 '+14147745236' would display as '(141) 477-4523' (wrong).
 * We strip the leading country code '1' from US numbers to get '4147745236'.
 *
 * Rules:
 * 1. Strip all non-digit characters.
 * 2. If result is already 10 digits, use as-is.
 * 3. If result is 11 digits and starts with '1', drop the leading '1'.
 * 4. Otherwise return the original value unchanged (non-US or unexpected format).
 */
export function normalizePhoneForJotform(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return phone;
}

/**
 * Build a contractor-specific Jotform prefill URL.
 * Only includes params that have non-null, non-empty values.
 * Phone fields use the [full] sub-parameter, URL-encoded as %5Bfull%5D.
 * Phone values are normalized to 10-digit US national format for Jotform.
 *
 * NOTE: Do not log the returned URL at INFO level — it contains contractor
 * identifiers (Airtable record ID, backend UUID) in the query string.
 */
export function buildJotformPrefillUrl(params: JotformPrefillParams): string {
  const formId = config.JOTFORM_ONBOARDING_FORM_ID;
  const base = `https://form.jotform.com/${formId}`;

  const parts: string[] = [];

  const add = (key: string, value: string | null | undefined) => {
    if (value != null && value.trim() !== '') {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value.trim())}`);
    }
  };

  add('contractorRecord', params.airtableRecordId);
  add('backendContractor', params.backendContractorId);
  add('typeA', params.legalFullName);
  if (params.preferredName != null && params.preferredName.trim() !== '') {
    add('q5_textbox3', params.preferredName);
  }
  // Phone fields use [full] sub-parameter — must be encoded as %5Bfull%5D.
  // Normalize to 10-digit US national format so Jotform prefills correctly.
  if (params.phoneE164 != null && params.phoneE164.trim() !== '') {
    const phoneForJotform = normalizePhoneForJotform(params.phoneE164.trim());
    parts.push(
      `${encodeURIComponent('q6_phone4[full]')}=${encodeURIComponent(phoneForJotform)}`,
    );
    parts.push(
      `${encodeURIComponent('q7_phone5[full]')}=${encodeURIComponent(phoneForJotform)}`,
    );
  }
  add('q8_email6', params.email);

  return parts.length > 0 ? `${base}?${parts.join('&')}` : base;
}

// ── Email templates ───────────────────────────────────────────────────────────

/**
 * Inline HTML template for the customer job-complete email.
 * Based on the approved email-previews/customer-completion.html design.
 */
export function renderCustomerCompletionEmail(params: {
  customerName: string;
  jobKey: string;
  serviceType: string;
  city: string;
  bookAnotherUrl: string;
}): string {
  const { customerName, jobKey, serviceType, city, bookAnotherUrl } = params;
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Your Assembly Concierge job is complete</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background-color:#1a1a1a;padding:28px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td><span style="font-size:22px;font-weight:700;color:#FFD700;letter-spacing:0.5px;">Assembly Concierge</span></td>
                <td align="right"><span style="font-size:12px;color:#999999;letter-spacing:1px;text-transform:uppercase;">Job Complete</span></td>
              </tr>
            </table>
          </td>
        </tr>
        <tr><td style="background-color:#FFD700;height:4px;font-size:0;line-height:0;"></td></tr>
        <tr>
          <td style="padding:36px 32px 28px 32px;">
            <p style="margin:0 0 20px 0;font-size:16px;color:#1a1a1a;line-height:1.5;">Hi ${esc(customerName)},</p>
            <p style="margin:0 0 20px 0;font-size:16px;color:#1a1a1a;line-height:1.6;">Your assembly job has been completed and your payment is confirmed. Thank you for choosing Assembly Concierge.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9f9f9;border:1px solid #e8e8e8;border-radius:4px;margin:0 0 28px 0;">
              <tr><td style="padding:20px 24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr><td style="padding-bottom:12px;"><span style="font-size:11px;color:#888888;text-transform:uppercase;letter-spacing:0.8px;font-weight:700;">Job Summary</span></td></tr>
                  <tr><td style="padding-bottom:8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr><td style="font-size:13px;color:#666666;width:140px;">Job Number</td><td style="font-size:13px;color:#1a1a1a;font-weight:600;">${esc(jobKey)}</td></tr>
                    </table>
                  </td></tr>
                  <tr><td style="padding-bottom:8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr><td style="font-size:13px;color:#666666;width:140px;">Service</td><td style="font-size:13px;color:#1a1a1a;">${esc(serviceType)}</td></tr>
                    </table>
                  </td></tr>
                  <tr><td style="padding-bottom:8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr><td style="font-size:13px;color:#666666;width:140px;">Location</td><td style="font-size:13px;color:#1a1a1a;">${esc(city)}</td></tr>
                    </table>
                  </td></tr>
                  <tr><td>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr><td style="font-size:13px;color:#666666;width:140px;">Payment Status</td><td><span style="display:inline-block;background-color:#e8f5e9;color:#2e7d32;font-size:12px;font-weight:700;padding:2px 10px;border-radius:12px;">Paid in Full</span></td></tr>
                    </table>
                  </td></tr>
                </table>
              </td></tr>
            </table>
            <p style="margin:0 0 28px 0;font-size:15px;color:#444444;line-height:1.7;">We appreciate your trust in Assembly Concierge. Our technicians are committed to professional, reliable assembly service &mdash; and we hope your new equipment is exactly what you expected.</p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px 0;">
              <tr><td style="border-radius:4px;background-color:#FFD700;">
                <a href="${esc(bookAnotherUrl)}" style="display:inline-block;padding:13px 28px;font-size:14px;font-weight:700;color:#1a1a1a;text-decoration:none;letter-spacing:0.3px;">Book Another Assembly</a>
              </td></tr>
            </table>
            <p style="margin:0;font-size:13px;color:#888888;line-height:1.6;">Questions about your job? Reply to this email or contact us at <a href="mailto:support@assemblyconcierge.com" style="color:#1a1a1a;font-weight:600;text-decoration:none;">support@assemblyconcierge.com</a>.</p>
          </td>
        </tr>
        <tr>
          <td style="background-color:#f0f0f0;border-top:1px solid #e0e0e0;padding:20px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-size:11px;color:#aaaaaa;line-height:1.6;">Assembly Concierge &nbsp;&middot;&nbsp; McDonough / Henry County, GA<br /><a href="mailto:support@assemblyconcierge.com" style="color:#aaaaaa;text-decoration:underline;">support@assemblyconcierge.com</a> &nbsp;&middot;&nbsp; <a href="https://assemblyconcierge.com" style="color:#aaaaaa;text-decoration:underline;">assemblyconcierge.com</a></td>
                <td align="right" style="font-size:11px;color:#cccccc;white-space:nowrap;">Job ${esc(jobKey)}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Inline HTML template for the contractor onboarding email.
 * Based on the approved email-previews/contractor-onboarding.html design.
 */
export function renderContractorOnboardingEmail(params: {
  contractorName: string;
  onboardingFormUrl: string;
}): string {
  const { contractorName, onboardingFormUrl } = params;
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Assembly Concierge Contractor Onboarding</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f4f4f4;opacity:0;">Complete your Assembly Concierge contractor onboarding.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background-color:#1a1a1a;padding:28px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td><span style="font-size:22px;font-weight:700;color:#FFD700;letter-spacing:0.5px;">Assembly Concierge</span></td>
                <td align="right"><span style="font-size:12px;color:#999999;letter-spacing:1px;text-transform:uppercase;">Contractor Onboarding</span></td>
              </tr>
            </table>
          </td>
        </tr>
        <tr><td style="background-color:#FFD700;height:4px;font-size:0;line-height:0;"></td></tr>
        <tr>
          <td style="padding:36px 32px 28px 32px;">
            <p style="margin:0 0 20px 0;font-size:16px;color:#1a1a1a;line-height:1.5;">Hi ${esc(contractorName)},</p>
            <p style="margin:0 0 8px 0;font-size:16px;color:#1a1a1a;line-height:1.6;">You have been approved to continue the Assembly Concierge contractor onboarding process.</p>
            <p style="margin:0 0 28px 0;font-size:14px;color:#666666;line-height:1.6;"><strong>Please note:</strong> This is not final activation. Dispatch eligibility is granted only after your onboarding materials are reviewed and your account is fully activated by our team.</p>
            <p style="margin:0 0 14px 0;font-size:14px;font-weight:700;color:#1a1a1a;text-transform:uppercase;letter-spacing:0.6px;">Next Steps</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px 0;">
              ${[
                ['Contractor Agreement', 'Review and sign the Assembly Concierge contractor agreement.'],
                ['W-9 / Payment Setup', 'Complete your W-9 and payment information for direct deposit or check payments.'],
                ['SMS Consent', 'Confirm your consent to receive job dispatch and status messages via SMS.'],
                ['Tools &amp; Transportation Confirmation', 'Confirm that you have the required hand tools and reliable transportation to service the Henry County area.'],
                ['Handbook Acknowledgment', 'Read and acknowledge the Assembly Concierge contractor handbook and service standards.'],
                ['Photo ID', 'Submit a copy of a valid government-issued photo ID for verification.'],
              ]
                .map(
                  ([title, desc], i) => `
              <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;vertical-align:top;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                  <td style="width:28px;vertical-align:top;padding-top:1px;"><span style="display:inline-block;width:20px;height:20px;background-color:#FFD700;border-radius:50%;text-align:center;font-size:11px;font-weight:700;color:#1a1a1a;line-height:20px;">${i + 1}</span></td>
                  <td style="padding-left:10px;vertical-align:top;"><span style="font-size:14px;font-weight:700;color:#1a1a1a;">${title}</span><br /><span style="font-size:13px;color:#666666;line-height:1.5;">${desc}</span></td>
                </tr></table>
              </td></tr>`,
                )
                .join('')}
            </table>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px 0;">
              <tr><td style="border-radius:4px;background-color:#FFD700;">
                <a href="${esc(onboardingFormUrl)}" style="display:inline-block;padding:13px 28px;font-size:14px;font-weight:700;color:#1a1a1a;text-decoration:none;letter-spacing:0.3px;">Complete Onboarding</a>
              </td></tr>
            </table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;background-color:#fffbea;border:1px solid #ffe57f;border-radius:4px;">
              <tr><td style="padding:14px 18px;">
                <p style="margin:0;font-size:13px;color:#5a4a00;line-height:1.6;"><strong>Dispatch eligibility</strong> is granted only after your onboarding materials have been reviewed and your account is activated by the Assembly Concierge team. You will receive a separate confirmation once you are fully active.</p>
              </td></tr>
            </table>
            <p style="margin:0;font-size:13px;color:#888888;line-height:1.6;">Questions about onboarding? Reply to this email or reach us at <a href="mailto:support@assemblyconcierge.com" style="color:#1a1a1a;font-weight:600;text-decoration:none;">support@assemblyconcierge.com</a>.</p>
          </td>
        </tr>
        <tr>
          <td style="background-color:#f0f0f0;border-top:1px solid #e0e0e0;padding:20px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-size:11px;color:#aaaaaa;line-height:1.6;">Assembly Concierge &nbsp;&middot;&nbsp; McDonough / Henry County, GA<br /><a href="mailto:support@assemblyconcierge.com" style="color:#aaaaaa;text-decoration:underline;">support@assemblyconcierge.com</a> &nbsp;&middot;&nbsp; <a href="https://assemblyconcierge.com" style="color:#aaaaaa;text-decoration:underline;">assemblyconcierge.com</a></td>
                <td align="right" style="font-size:11px;color:#cccccc;white-space:nowrap;">Contractor Onboarding</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Send functions ─────────────────────────────────────────────────────────────

export interface SendCustomerCompletionEmailParams {
  jobId: string;
  jobKey: string;
  customerName: string;
  customerEmail: string;
  serviceType: string;
  city: string;
}

export interface SendContractorOnboardingEmailParams {
  contractorId: string;
  contractorName: string;
  contractorEmail: string;
  airtableRecordId?: string | null;
  phoneE164?: string | null;
  preferredName?: string | null;
  /** If true, reset the event row to pending and resend even if already sent */
  forceResend?: boolean;
}

export interface EmailSendResult {
  alreadySent: boolean;
  eventId: string;
  providerMessageId?: string;
  jotformUrl?: string;
}

/**
 * Send (or log) the customer job-complete email.
 *
 * Idempotency: the INSERT in reserveEmailEvent uses ON CONFLICT DO NOTHING.
 * If the row already exists, returns alreadySent=true without calling Resend.
 */
export async function sendCustomerCompletionEmail(
  params: SendCustomerCompletionEmailParams,
): Promise<EmailSendResult> {
  const eventType = EMAIL_EVENT_TYPES.CUSTOMER_JOB_COMPLETE;

  // Reserve the event row (INSERT ON CONFLICT DO NOTHING)
  const { row: event, alreadyExists } = await reserveEmailEvent({
    recipientEmail: params.customerEmail,
    recipientType: 'customer',
    eventType,
    relatedJobId: params.jobId,
  });

  if (alreadyExists) {
    logger.info(
      { eventId: event.id, eventType, jobId: params.jobId },
      '[email] event already reserved — skipping send',
    );
    return {
      alreadySent: true,
      eventId: event.id,
      providerMessageId: event.provider_message_id ?? undefined,
    };
  }

  const bookAnotherUrl = `${config.APP_BASE_URL}/book`;
  const html = renderCustomerCompletionEmail({
    customerName: params.customerName,
    jobKey: params.jobKey,
    serviceType: params.serviceType,
    city: params.city,
    bookAnotherUrl,
  });

  return _dispatchEmail({
    event,
    to: params.customerEmail,
    subject: `Your Assembly Concierge job is complete — ${params.jobKey}`,
    html,
    logContext: { eventType, jobId: params.jobId },
  });
}

/**
 * Send (or log) the contractor onboarding email.
 *
 * Idempotency: INSERT ON CONFLICT DO NOTHING unless forceResend=true,
 * in which case the existing row is reset to pending and the email is resent.
 */
export async function sendContractorOnboardingEmail(
  params: SendContractorOnboardingEmailParams,
): Promise<EmailSendResult> {
  const eventType = EMAIL_EVENT_TYPES.CONTRACTOR_ONBOARDING;

  // Build Jotform prefill URL — do NOT log this URL (contains contractor identifiers)
  const jotformUrl = buildJotformPrefillUrl({
    airtableRecordId: params.airtableRecordId,
    backendContractorId: params.contractorId,
    legalFullName: params.contractorName,
    preferredName: params.preferredName,
    phoneE164: params.phoneE164,
    email: params.contractorEmail,
  });

  let event: EmailEventRow;
  let alreadyExists: boolean;

  if (params.forceResend) {
    // Reset existing row to pending (or insert fresh if none exists)
    event = await reserveEmailEventForResend({
      recipientEmail: params.contractorEmail,
      recipientType: 'contractor',
      eventType,
      relatedContractorId: params.contractorId,
    });
    alreadyExists = false;
  } else {
    const result = await reserveEmailEvent({
      recipientEmail: params.contractorEmail,
      recipientType: 'contractor',
      eventType,
      relatedContractorId: params.contractorId,
    });
    event = result.row;
    alreadyExists = result.alreadyExists;
  }

  if (alreadyExists) {
    logger.info(
      { eventId: event.id, eventType, contractorId: params.contractorId },
      '[email] event already reserved — skipping send',
    );
    return {
      alreadySent: true,
      eventId: event.id,
      providerMessageId: event.provider_message_id ?? undefined,
      jotformUrl,
    };
  }

  const html = renderContractorOnboardingEmail({
    contractorName: params.contractorName,
    onboardingFormUrl: jotformUrl,
  });

  // When forceResend=true, the event row is reset in-place (same UUID).
  // Passing that same UUID to Resend as Idempotency-Key would cause Resend to
  // replay the original email body within its 24-hour deduplication window,
  // delivering the stale contractor name. Generate a fresh UUID instead so
  // Resend treats this as a new send with the current HTML body.
  const resendIdempotencyKey = params.forceResend ? randomUUID() : event.id;

  const result = await _dispatchEmail({
    event,
    to: params.contractorEmail,
    subject: 'Assembly Concierge — Complete Your Contractor Onboarding',
    html,
    resendIdempotencyKey,
    // Log contractorId but NOT the jotformUrl
    logContext: { eventType, contractorId: params.contractorId, forceResend: params.forceResend ?? false },
  });

  return { ...result, jotformUrl };
}

// ── Internal dispatch helper ───────────────────────────────────────────────────

async function _dispatchEmail(params: {
  event: EmailEventRow;
  to: string;
  subject: string;
  html: string;
  /** Override for the Resend Idempotency-Key. Defaults to event.id.
   *  Pass a fresh randomUUID() when forceResend=true to prevent Resend
   *  from replaying the original email body within its 24h dedup window. */
  resendIdempotencyKey?: string;
  logContext: Record<string, unknown>;
}): Promise<EmailSendResult> {
  const { event, to, subject, html, resendIdempotencyKey, logContext } = params;
  const mode = config.EMAIL_SEND_MODE;

  if (mode === 'log_only') {
    logger.info(
      { eventId: event.id, recipientType: event.recipient_type, mode: 'log_only', ...logContext },
      '[email] log_only mode — payload generated, not sent',
    );
    // Event row stays in 'pending' status — it was not sent
    return { alreadySent: false, eventId: event.id };
  }

  // mode === 'send'
  if (!config.RESEND_API_KEY) {
    const err = 'RESEND_API_KEY is not configured';
    await markEmailEventFailed(event.id, err);
    logger.error({ eventId: event.id, ...logContext }, `[email] ${err}`);
    throw new Error(err);
  }

  try {
    const result = await sendViaResend(config.RESEND_API_KEY, {
      from: config.CUSTOMER_EMAIL_FROM,
      replyTo: config.CUSTOMER_EMAIL_REPLY_TO,
      to,
      subject,
      html,
      idempotencyKey: resendIdempotencyKey ?? event.id,
    });

    await markEmailEventSent(event.id, result.id);
    logger.info(
      { eventId: event.id, providerMessageId: result.id, recipientType: event.recipient_type, ...logContext },
      '[email] sent via Resend',
    );
    return { alreadySent: false, eventId: event.id, providerMessageId: result.id };
  } catch (err) {
    const message = err instanceof ResendError ? err.message : String(err);
    await markEmailEventFailed(event.id, message);
    logger.error({ eventId: event.id, ...logContext, err }, '[email] Resend send failed');
    throw err;
  }
}
