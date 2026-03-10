import Stripe from 'stripe';
import { config } from '../../common/config';
import { logger } from '../../common/logger';

let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeClient) {
    if (!config.STRIPE_SECRET_KEY) {
      throw new Error('[Stripe] STRIPE_SECRET_KEY is not configured');
    }
    stripeClient = new Stripe(config.STRIPE_SECRET_KEY, {
      apiVersion: '2023-10-16',
      typescript: true,
    });
    logger.info('[Stripe] Client initialized');
  }
  return stripeClient;
}

export interface CreateCheckoutSessionParams {
  jobId: string;
  jobKey: string;
  paymentType: 'full' | 'deposit' | 'remainder';
  amountCents: number;
  currency: string;
  customerEmail: string;
  customerName: string;
  serviceDescription: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}

export async function createCheckoutSession(
  params: CreateCheckoutSessionParams,
): Promise<Stripe.Checkout.Session> {
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    customer_email: params.customerEmail,
    line_items: [
      {
        price_data: {
          currency: params.currency,
          product_data: {
            name: params.serviceDescription,
            metadata: { jobId: params.jobId, jobKey: params.jobKey },
          },
          unit_amount: params.amountCents,
        },
        quantity: 1,
      },
    ],
    metadata: {
      jobId: params.jobId,
      jobKey: params.jobKey,
      paymentType: params.paymentType,
      ...params.metadata,
    },
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
  });

  return session;
}

export async function createRefund(
  paymentIntentId: string,
  amountCents?: number,
): Promise<Stripe.Refund> {
  const stripe = getStripe();
  return stripe.refunds.create({
    payment_intent: paymentIntentId,
    ...(amountCents ? { amount: amountCents } : {}),
  });
}

export function constructWebhookEvent(
  rawBody: Buffer,
  signature: string,
  secret: string,
): Stripe.Event {
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}
