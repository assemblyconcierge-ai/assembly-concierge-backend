/**
 * SMS Webhook Router
 *
 * POST /webhooks/sms
 * Receives inbound contractor SMS events from Quo.
 * Always returns 200 — processing errors are logged, not surfaced to the sender.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../../common/logger';
import { processSmsWebhook } from './sms.service';

export const smsWebhookRouter = Router();

smsWebhookRouter.post('/', async (req: Request, res: Response) => {
  const correlationId = req.correlationId;
  const log = logger.child({ correlationId, handler: 'sms-webhook' });

  const obj = ((req.body ?? {}) as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const message = obj?.object as Record<string, unknown> | undefined;

  const direction = message?.direction as string | undefined;
  if (direction !== 'incoming') {
    log.info({ direction }, '[SMS] Ignoring non-incoming message');
    res.status(200).json({ received: true });
    return;
  }

  const rawPhone = ((message?.from as string) ?? '').trim();
  const messageBody = ((message?.body as string) ?? '').trim();

  if (!rawPhone || !messageBody) {
    log.warn('[SMS] Webhook payload missing phone or message body — ignoring');
    res.status(200).json({ received: true });
    return;
  }

  // Acknowledge immediately — Quo does not need to wait for processing
  res.status(200).json({ received: true, correlationId });

  // Process in background so response is never delayed
  setImmediate(async () => {
    try {
      await processSmsWebhook(rawPhone, messageBody, correlationId);
    } catch (err) {
      log.error({ err }, '[SMS] Unhandled error in SMS webhook processing');
    }
  });
});
