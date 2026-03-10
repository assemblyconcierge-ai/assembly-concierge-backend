import { v4 as uuidv4 } from 'uuid';
import { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../../db/pool';
import { getJobById, updateJobStatus } from '../jobs/job.repository';
import { assertTransition } from '../jobs/job.stateMachine';
import { recordAuditEvent } from '../audit/audit.service';
import { createCheckoutSession } from './stripe.adapter';
import { config } from '../../common/config';
import { logger } from '../../common/logger';

export interface PaymentRow {
  id: string;
  job_id: string;
  payment_type: 'full' | 'deposit' | 'remainder';
  provider: string;
  provider_session_id: string | null;
  provider_payment_intent_id: string | null;
  amount_due_cents: number;
  amount_paid_cents: number;
  currency: string;
  status: string;
  checkout_url: string | null;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function createPaymentRecord(
  params: {
    jobId: string;
    paymentType: 'full' | 'deposit' | 'remainder';
    amountDueCents: number;
    providerSessionId?: string;
    checkoutUrl?: string;
    status?: string;
  },
  client: PoolClient,
): Promise<PaymentRow> {
  const { rows } = await client.query<PaymentRow>(
    `INSERT INTO payments
      (id, job_id, payment_type, amount_due_cents, provider_session_id, checkout_url, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      uuidv4(),
      params.jobId,
      params.paymentType,
      params.amountDueCents,
      params.providerSessionId ?? null,
      params.checkoutUrl ?? null,
      params.status ?? 'checkout_created',
    ],
  );
  return rows[0];
}

export async function getPaymentById(id: string): Promise<PaymentRow | null> {
  return queryOne<PaymentRow>('SELECT * FROM payments WHERE id = $1', [id]);
}

export async function getPaymentsByJobId(jobId: string): Promise<PaymentRow[]> {
  return query<PaymentRow>(
    'SELECT * FROM payments WHERE job_id = $1 ORDER BY created_at ASC',
    [jobId],
  );
}

export async function getPaymentBySessionId(sessionId: string): Promise<PaymentRow | null> {
  return queryOne<PaymentRow>(
    'SELECT * FROM payments WHERE provider_session_id = $1',
    [sessionId],
  );
}

export async function getPaymentByIntentId(intentId: string): Promise<PaymentRow | null> {
  return queryOne<PaymentRow>(
    'SELECT * FROM payments WHERE provider_payment_intent_id = $1',
    [intentId],
  );
}

/**
 * Create a Stripe checkout session for a job and persist the payment record.
 * Supports full, deposit, and remainder payment types.
 */
export async function createJobCheckoutSession(
  jobId: string,
  paymentType: 'full' | 'deposit' | 'remainder',
  correlationId: string,
): Promise<{ checkoutUrl: string; paymentId: string; sessionId: string }> {
  const job = await getJobById(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  // Determine amount
  let amountCents: number;
  if (paymentType === 'full') {
    amountCents = job.total_amount_cents;
  } else if (paymentType === 'deposit') {
    amountCents = job.deposit_amount_cents;
  } else {
    amountCents = job.remainder_amount_cents;
  }

  if (amountCents <= 0) {
    throw new Error(`Invalid amount for ${paymentType} payment on job ${jobId}`);
  }

  // Get customer info
  const customerRows = await query<{ full_name: string; email: string }>(
    'SELECT full_name, email FROM customers WHERE id = $1',
    [job.customer_id],
  );
  const customer = customerRows[0];
  if (!customer) throw new Error(`Customer not found for job ${jobId}`);

  const baseUrl = config.APP_BASE_URL;
  const session = await createCheckoutSession({
    jobId: job.id,
    jobKey: job.job_key,
    paymentType,
    amountCents,
    currency: 'usd',
    customerEmail: customer.email,
    customerName: customer.full_name,
    serviceDescription: `Assembly Concierge — ${job.job_key} (${paymentType})`,
    successUrl: `${baseUrl}/payment/success?job=${job.job_key}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${baseUrl}/payment/cancel?job=${job.job_key}`,
    metadata: { correlationId },
  });

  const payment = await withTransaction(async (client) => {
    const p = await createPaymentRecord(
      {
        jobId: job.id,
        paymentType,
        amountDueCents: amountCents,
        providerSessionId: session.id,
        checkoutUrl: session.url ?? undefined,
        status: 'checkout_created',
      },
      client,
    );

    await recordAuditEvent({
      aggregateType: 'job',
      aggregateId: job.id,
      eventType: 'payment.checkout_created',
      payload: { paymentId: p.id, paymentType, amountCents, sessionId: session.id },
      correlationId,
      client,
    });

    return p;
  });

  logger.info({ jobId, paymentId: payment.id, paymentType, amountCents }, 'Checkout session created');

  return {
    checkoutUrl: session.url!,
    paymentId: payment.id,
    sessionId: session.id,
  };
}
