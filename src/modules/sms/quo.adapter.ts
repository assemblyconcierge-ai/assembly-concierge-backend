/**
 * Quo SMS Adapter (OpenPhone-compatible API)
 *
 * Sends outbound SMS messages via the OpenPhone v1 messages endpoint.
 * Auth: raw API key in Authorization header (no Bearer prefix).
 */

import { config } from '../../common/config';
import { logger } from '../../common/logger';

const QUO_API_URL = 'https://api.openphone.com/v1/messages';

export interface QuoSendResult {
  /** Provider message ID, if returned */
  messageId: string | null;
}

/**
 * Send an outbound SMS via Quo.
 * Returns the provider message ID on success.
 * Throws on HTTP error or missing config.
 */
export async function sendSms(
  to: string,
  content: string,
  correlationId: string,
): Promise<QuoSendResult> {
  const log = logger.child({ correlationId, adapter: 'quo' });

  if (!config.QUO_API_KEY || !config.QUO_PHONE_NUMBER || !config.QUO_PHONE_NUMBER_ID) {
    log.warn('[Quo] QUO_API_KEY / QUO_PHONE_NUMBER / QUO_PHONE_NUMBER_ID not configured — SMS not sent');
    return { messageId: null };
  }

  const body = {
    content,
    from: config.QUO_PHONE_NUMBER,
    to: [to],
    phoneNumberId: config.QUO_PHONE_NUMBER_ID,
  };

  log.info({ to, phoneNumberId: config.QUO_PHONE_NUMBER_ID }, '[Quo] Sending outbound SMS');

  const response = await fetch(QUO_API_URL, {
    method: 'POST',
    headers: {
      Authorization: config.QUO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Quo API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { data?: { id?: string } };
  const messageId = data?.data?.id ?? null;

  log.info({ to, messageId }, '[Quo] Outbound SMS sent successfully');
  return { messageId };
}
