/**
 * resend.adapter.ts
 *
 * Thin wrapper around the Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email).
 * Uses native fetch — no SDK dependency required.
 *
 * This adapter is the ONLY place in the codebase that calls Resend.
 * The email.service.ts decides whether to call it based on EMAIL_SEND_MODE.
 */

export interface ResendSendParams {
  from: string;
  replyTo?: string;
  to: string | string[];
  subject: string;
  html: string;
  /** Optional idempotency key — Resend deduplicates on this within 24h */
  idempotencyKey?: string;
}

export interface ResendSendResult {
  id: string;
}

export class ResendError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly resendCode?: string,
  ) {
    super(message);
    this.name = 'ResendError';
  }
}

/**
 * Send an email via the Resend API.
 * Throws ResendError on non-2xx responses.
 */
export async function sendViaResend(
  apiKey: string,
  params: ResendSendParams,
): Promise<ResendSendResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  if (params.idempotencyKey) {
    headers['Idempotency-Key'] = params.idempotencyKey;
  }

  const body: Record<string, unknown> = {
    from: params.from,
    to: Array.isArray(params.to) ? params.to : [params.to],
    subject: params.subject,
    html: params.html,
  };

  if (params.replyTo) {
    body.reply_to = params.replyTo;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let resendCode: string | undefined;
    let message = `Resend API error: HTTP ${response.status}`;
    try {
      const errorBody = (await response.json()) as { name?: string; message?: string };
      resendCode = errorBody.name;
      if (errorBody.message) message = `Resend API error: ${errorBody.message}`;
    } catch {
      // ignore JSON parse failure
    }
    throw new ResendError(message, response.status, resendCode);
  }

  const data = (await response.json()) as { id: string };
  return { id: data.id };
}
