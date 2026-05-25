import { query } from '../../db/pool';
import { sendSms } from '../sms/quo.adapter';
import { logger } from '../../common/logger';

const SMS_MESSAGE = (checkoutUrl: string) =>
  `Assembly Concierge: Complete your deposit to secure your preferred appointment window: ${checkoutUrl}`;

/**
 * Send a one-time payment-link SMS to the customer for a fixed-price job.
 *
 * Uses a claim-before-send (CAS) guard: atomically sets payment_link_sms_sent_at
 * on the jobs row before calling the SMS provider. If the column is already set
 * (by a concurrent or prior call), the UPDATE returns no rows and the send is
 * skipped — making this safe to call from fire-and-forget setImmediate contexts.
 *
 * Only call for fixed-price jobs where checkoutUrl is known (checkoutRequired = true).
 * Do not call for custom_review / manual-review jobs.
 */
export async function sendPaymentLinkSms(
  jobId: string,
  customerPhone: string,
  checkoutUrl: string,
  correlationId: string,
): Promise<void> {
  const log = logger.child({ correlationId, fn: 'sendPaymentLinkSms', jobId });

  if (!customerPhone) {
    log.info({ jobId }, '[PaymentLinkSms] No customer phone — skipping');
    return;
  }

  // Atomically claim the send slot. Returns 1 row if this caller owns the send,
  // 0 rows if another caller already set payment_link_sms_sent_at.
  const claimed = await query<{ id: string }>(
    `UPDATE jobs
        SET payment_link_sms_sent_at = NOW(),
            payment_link_sms_status  = 'in_flight',
            updated_at               = NOW()
      WHERE id = $1
        AND payment_link_sms_sent_at IS NULL
      RETURNING id`,
    [jobId],
  );

  if (claimed.length === 0) {
    log.info({ jobId }, '[PaymentLinkSms] Guard: already in-flight or sent — skipping');
    return;
  }

  try {
    const result = await sendSms(customerPhone, SMS_MESSAGE(checkoutUrl), correlationId);
    if (result.messageId) {
      await query(
        `UPDATE jobs SET payment_link_sms_status = 'sent', updated_at = NOW() WHERE id = $1`,
        [jobId],
      );
      log.info({ jobId, messageId: result.messageId }, '[PaymentLinkSms] Payment link SMS sent');
    } else {
      await query(
        `UPDATE jobs SET payment_link_sms_status = 'failed', updated_at = NOW() WHERE id = $1`,
        [jobId],
      );
      log.warn({ jobId }, '[PaymentLinkSms] sendSms returned no messageId — marked failed');
    }
  } catch (err) {
    await query(
      `UPDATE jobs SET payment_link_sms_status = 'failed', updated_at = NOW() WHERE id = $1`,
      [jobId],
    ).catch((dbErr) =>
      log.error({ dbErr, jobId }, '[PaymentLinkSms] Failed to write failure status to DB'),
    );
    log.warn({ err, jobId }, '[PaymentLinkSms] sendSms threw — marked failed');
  }
}
