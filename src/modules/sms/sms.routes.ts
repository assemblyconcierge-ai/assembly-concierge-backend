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

  const body = req.body as Record<string, unknown>;

  // Quo may use different field names — try common variants
  const rawPhone = (
    (body.from       as string) ||
    (body.sender     as string) ||
    (body.phone      as string) ||
    (body.originator as string) ||
    ''
  ).trim();

  const messageBody = (
    (body.body    as string) ||
    (body.message as string) ||
    (body.text    as string) ||
    (body.content as string) ||
    ''
  ).trim();

  if (!rawPhone || !messageBody) {
    log.warn({ bodyKeys: Object.keys(body) }, '[SMS] Webhook payload missing phone or message — ignoring');
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
