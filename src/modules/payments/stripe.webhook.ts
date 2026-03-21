import { Router, Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { v4 as uuidv4 } from 'uuid';
import { constructWebhookEvent } from './stripe.adapter';
import { config } from '../../common/config';
import pino from 'pino';
import { logger } from '../../common/logger';
import { withTransaction, query, queryOne } from '../../db/pool';
import { getPaymentBySessionId, getPaymentByIntentId } from './payment.service';
import { getJobById, updateJobStatus } from '../jobs/job.repository';
import { assertTransition } from '../jobs/job.stateMachine';
import { recordAuditEvent } from '../audit/audit.service';
import { enqueueAirtableSync } from '../airtable-sync/airtableSync.queue';
import {
  findAirtablePaymentRowBySessionId,
  updateAirtablePaymentRow,
} from '../airtable-sync/airtable.payments.adapter';

type Log = pino.Logger;

export const stripeWebhookRouter = Router();

/**
 * POST /webhooks/stripe
 * Requires raw body — must be registered BEFORE express.json() middleware.
 * Validates Stripe signature, processes relevant events idempotently.
 */
stripeWebhookRouter.post(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = req.correlationId || uuidv4();
    const log = logger.child({ correlationId, handler: 'stripe-webhook' });

    const signature = req.headers['stripe-signature'] as string;
    if (!signature) {
      log.warn('Missing stripe-signature header');
      res.status(400).json({ error: 'Missing stripe-signature' });
      return;
    }

    if (!config.STRIPE_WEBHOOK_SECRET) {
      log.error('STRIPE_WEBHOOK_SECRET not configured');
      res.status(500).json({ error: 'Webhook secret not configured' });
      return;
    }

    let event: Stripe.Event;
    try {
      event = constructWebhookEvent(
        req.body as Buffer,
        signature,
        config.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ msg }, 'Stripe signature verification failed');
      res.status(400).json({ error: `Webhook signature invalid: ${msg}` });
      return;
    }

    log.info({ eventType: event.type, eventId: event.id }, 'Stripe event received');

    // Acknowledge immediately — process below
    res.status(200).json({ received: true, correlationId });

    // Process in background
    setImmediate(async () => {
      try {
        await handleStripeEvent(event, correlationId, log);
      } catch (err) {
        log.error({ err, eventId: event.id }, 'Stripe event processing failed');
      }
    });
  },
);

async function handleStripeEvent(
  event: Stripe.Event,
  correlationId: string,
  log: Log,
): Promise<void> {
  // Idempotency: skip if already processed
  const idempotencyKey = `stripe:${event.id}`;
  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM payment_events WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  if (existing) {
    log.info({ eventId: event.id }, 'Stripe event already processed — skipping');
    return;
  }

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session, event, correlationId, log);
      break;
    case 'payment_intent.succeeded':
      await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent, event, correlationId, log);
      break;
    case 'payment_intent.payment_failed':
      await handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent, event, correlationId, log);
      break;
    case 'charge.refunded':
      await handleChargeRefunded(event.data.object as Stripe.Charge, event, correlationId, log);
      break;
    default:
      log.info({ eventType: event.type }, 'Unhandled Stripe event type — ignoring');
  }
}

async function recordPaymentEvent(
  paymentId: string,
  event: Stripe.Event,
  idempotencyKey: string,
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
): Promise<void> {
  await client.query(
    `INSERT INTO payment_events (id, payment_id, provider_event_id, event_type, payload_json, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [uuidv4(), paymentId, event.id, event.type, JSON.stringify(event.data.object), idempotencyKey],
  );
}

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  event: Stripe.Event,
  correlationId: string,
  log: Log,
): Promise<void> {
  const payment = await getPaymentBySessionId(session.id);
  if (!payment) {
    log.warn({ sessionId: session.id }, 'No payment record found for checkout session');
    return;
  }

  const job = await getJobById(payment.job_id);
  if (!job) {
    log.warn({ jobId: payment.job_id }, 'No job found for payment');
    return;
  }

  const idempotencyKey = `stripe:${event.id}`;
  const amountPaid = session.amount_total ?? 0;

  await withTransaction(async (client) => {
    // Update payment record
    await client.query(
      `UPDATE payments SET
         status = 'paid_in_full',
         amount_paid_cents = $2,
         provider_payment_intent_id = $3,
         paid_at = NOW(),
         updated_at = NOW()
       WHERE id = $1`,
      [payment.id, amountPaid, session.payment_intent as string],
    );

    // Determine new job status
    const paymentType = payment.payment_type;
    let newJobStatus: string;
    if (paymentType === 'full') {
      newJobStatus = 'paid_in_full';
    } else if (paymentType === 'deposit') {
      newJobStatus = 'deposit_paid';
    } else {
      newJobStatus = 'closed_paid';
    }

    try {
      assertTransition(job.status, newJobStatus as any);
      await client.query(
        'UPDATE jobs SET status = $2, updated_at = NOW() WHERE id = $1',
        [job.id, newJobStatus],
      );
    } catch (err) {
      log.warn({ err, from: job.status, to: newJobStatus }, 'Job state transition skipped');
    }

    // Record payment event (idempotent)
    await client.query(
      `INSERT INTO payment_events (id, payment_id, provider_event_id, event_type, payload_json, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [uuidv4(), payment.id, event.id, event.type, JSON.stringify(session), idempotencyKey],
    );

    await recordAuditEvent({
      aggregateType: 'job',
      aggregateId: job.id,
      eventType: 'payment.completed',
      payload: { paymentId: payment.id, paymentType, amountPaid, newJobStatus },
      correlationId,
      client,
    });
  });

  // Enqueue Airtable sync (updates parent Backend Intake Sandbox V2 row)
  try {
    await enqueueAirtableSync({ jobId: job.id, correlationId });
  } catch (err) {
    log.warn({ err }, 'Airtable sync enqueue failed after payment');
  }

  // ── Update Airtable Payments child row (idempotent PATCH) ──
  // Look up the Payments row by Stripe session ID, then PATCH it to paid.
  // This is fire-and-forget: failures are logged but do not affect the 200 already sent.
  setImmediate(async () => {
    const now = new Date().toISOString();
    try {
      const airtablePaymentRecordId = await findAirtablePaymentRowBySessionId(session.id, correlationId);
      if (!airtablePaymentRecordId) {
        log.warn(
          { sessionId: session.id, jobId: job.id, paymentId: payment.id },
          '[AirtablePayments] No Payments row found for session ID — cannot update to paid',
        );
        return;
      }
      await updateAirtablePaymentRow(
        {
          airtablePaymentRecordId,
          amountPaidCents: amountPaid,
          stripePaymentIntentId: (session.payment_intent as string) ?? '',
          stripeEventId: event.id,
          paidAt: now,
          lastWebhookAt: now,
        },
        correlationId,
      );
    } catch (err) {
      log.error(
        { err, sessionId: session.id, jobId: job.id, paymentId: payment.id },
        '[AirtablePayments] Exception updating Payments row after checkout.session.completed',
      );
    }
  });

  log.info({ jobId: job.id, paymentId: payment.id, amountPaid }, 'Checkout completed');
}

async function handlePaymentIntentSucceeded(
  intent: Stripe.PaymentIntent,
  event: Stripe.Event,
  correlationId: string,
  log: Log,
): Promise<void> {
  // checkout.session.completed is the primary handler; this is a secondary guard
  const payment = await getPaymentByIntentId(intent.id);
  if (!payment) {
    log.info({ intentId: intent.id }, 'No payment record for intent — likely handled by checkout.session.completed');
    return;
  }

  const idempotencyKey = `stripe:${event.id}`;
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE payments SET
         provider_payment_intent_id = $2,
         updated_at = NOW()
       WHERE id = $1 AND provider_payment_intent_id IS NULL`,
      [payment.id, intent.id],
    );

    await client.query(
      `INSERT INTO payment_events (id, payment_id, provider_event_id, event_type, payload_json, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [uuidv4(), payment.id, event.id, event.type, JSON.stringify(intent), idempotencyKey],
    );
  });
}

async function handlePaymentIntentFailed(
  intent: Stripe.PaymentIntent,
  event: Stripe.Event,
  correlationId: string,
  log: Log,
): Promise<void> {
  const payment = await getPaymentByIntentId(intent.id);
  if (!payment) {
    log.warn({ intentId: intent.id }, 'No payment record for failed intent');
    return;
  }

  const idempotencyKey = `stripe:${event.id}`;
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE payments SET status = 'payment_failed', updated_at = NOW() WHERE id = $1`,
      [payment.id],
    );

    const job = await getJobById(payment.job_id);
    if (job) {
      await recordAuditEvent({
        aggregateType: 'job',
        aggregateId: job.id,
        eventType: 'payment.failed',
        payload: { paymentId: payment.id, intentId: intent.id },
        correlationId,
        client,
      });
    }

    await client.query(
      `INSERT INTO payment_events (id, payment_id, provider_event_id, event_type, payload_json, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [uuidv4(), payment.id, event.id, event.type, JSON.stringify(intent), idempotencyKey],
    );
  });

  log.warn({ paymentId: payment.id, intentId: intent.id }, 'Payment failed');
}

async function handleChargeRefunded(
  charge: Stripe.Charge,
  event: Stripe.Event,
  correlationId: string,
  log: Log,
): Promise<void> {
  const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
  if (!intentId) return;

  const payment = await getPaymentByIntentId(intentId);
  if (!payment) return;

  const idempotencyKey = `stripe:${event.id}`;
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE payments SET status = 'refunded', updated_at = NOW() WHERE id = $1`,
      [payment.id],
    );

    await client.query(
      `INSERT INTO payment_events (id, payment_id, provider_event_id, event_type, payload_json, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [uuidv4(), payment.id, event.id, event.type, JSON.stringify(charge), idempotencyKey],
    );
  });

  log.info({ paymentId: payment.id }, 'Charge refunded');
}
