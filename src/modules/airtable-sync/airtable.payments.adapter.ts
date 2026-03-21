/**
 * Airtable Payments Child-Table Adapter
 *
 * Writes payment transaction rows to the Airtable "Payments" child table.
 * Each row is linked to the parent "Backend Intake Sandbox V2" record via the
 * "Job" linked-record field (Airtable record ID, not a free-text key).
 *
 * Design rules:
 *  - Airtable is a MIRROR ONLY — failures must never break the checkout response.
 *  - Idempotency: on webhook retries, PATCH the existing row instead of creating a duplicate.
 *  - Lookup by Stripe Checkout Session ID to find the existing Payments row.
 *  - Do not fabricate or guess the parent record ID; log clearly if it is missing.
 *
 * Field names used (must match Airtable Payments table exactly):
 *   Payment ID            — text
 *   Job                   — linked record to Backend Intake Sandbox V2
 *   Payment Type          — single select: "deposit" | "remainder" | "full"
 *   Payment Status        — single select: "checkout_created" | "paid" | "payment_failed" | "refunded"
 *   Amount Due            — currency (dollars, not cents)
 *   Amount Paid           — currency (dollars, not cents)
 *   Currency              — text (e.g. "usd")
 *   Stripe Session ID     — text
 *   Checkout URL          — url
 *   Stripe Payment Intent ID — text
 *   Stripe Event ID       — text
 *   Paid At               — date/time
 *   Last Webhook At       — date/time
 *   Correlation ID        — text
 *   Created At            — date/time
 */

import { config } from '../../common/config';
import { logger } from '../../common/logger';

// ── Payment Status Single Select allowlist ───────────────────────────────────
// Must match the exact option labels in the Airtable Payments table.
const PAYMENT_STATUS_MAP: Record<string, string> = {
  checkout_created: 'checkout_created',
  paid:             'paid',
  paid_in_full:     'paid',       // internal alias → Airtable "paid"
  payment_failed:   'payment_failed',
  refunded:         'refunded',
};
const PAYMENT_STATUS_FALLBACK = 'checkout_created';

function mapPaymentStatus(status: string): string {
  const mapped = PAYMENT_STATUS_MAP[status?.toLowerCase?.()];
  if (!mapped) {
    logger.warn(
      { internalValue: status, fallback: PAYMENT_STATUS_FALLBACK, field: 'Payment Status' },
      '[AirtablePayments] Unrecognised payment status — using fallback',
    );
    return PAYMENT_STATUS_FALLBACK;
  }
  return mapped;
}

// ── Payment Type Single Select allowlist ─────────────────────────────────────
const PAYMENT_TYPE_MAP: Record<string, string> = {
  full:      'full',
  deposit:   'deposit',
  remainder: 'remainder',
};
const PAYMENT_TYPE_FALLBACK = 'full';

function mapPaymentType(type: string): string {
  const mapped = PAYMENT_TYPE_MAP[type?.toLowerCase?.()];
  if (!mapped) {
    logger.warn(
      { internalValue: type, fallback: PAYMENT_TYPE_FALLBACK, field: 'Payment Type' },
      '[AirtablePayments] Unrecognised payment type — using fallback',
    );
    return PAYMENT_TYPE_FALLBACK;
  }
  return mapped;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function baseHeaders() {
  return {
    Authorization: `Bearer ${config.AIRTABLE_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

function paymentsTableUrl(): string {
  return `https://api.airtable.com/v0/${config.AIRTABLE_BASE_ID}/${encodeURIComponent(
    config.AIRTABLE_TABLE_PAYMENTS,
  )}`;
}

// ── Public interface ─────────────────────────────────────────────────────────

export interface AirtablePaymentCreateParams {
  /** Internal UUID from the payments table */
  paymentId: string;
  /** Airtable record ID of the parent Backend Intake Sandbox V2 row */
  parentAirtableRecordId: string;
  paymentType: 'full' | 'deposit' | 'remainder';
  amountDueCents: number;
  currency: string;
  stripeSessionId: string;
  checkoutUrl?: string;
  correlationId: string;
  createdAt: string; // ISO 8601
}

export interface AirtablePaymentUpdateParams {
  /** Airtable record ID of the Payments row to update */
  airtablePaymentRecordId: string;
  amountPaidCents: number;
  stripePaymentIntentId: string;
  stripeEventId: string;
  paidAt: string;   // ISO 8601
  lastWebhookAt: string; // ISO 8601
}

/**
 * Create a new row in the Airtable Payments child table.
 * Returns the Airtable record ID of the created row, or null on failure.
 */
export async function createAirtablePaymentRow(
  params: AirtablePaymentCreateParams,
): Promise<string | null> {
  if (!config.AIRTABLE_API_KEY || !config.AIRTABLE_BASE_ID) {
    logger.warn('[AirtablePayments] Airtable not configured — skipping payment row creation');
    return null;
  }

  const log = logger.child({
    correlationId: params.correlationId,
    paymentId: params.paymentId,
    stripeSessionId: params.stripeSessionId,
  });

  const fields: Record<string, unknown> = {
    'Payment ID':     params.paymentId,
    'Job':            [params.parentAirtableRecordId], // linked record — must be array
    'Payment Type':   mapPaymentType(params.paymentType),
    'Payment Status': mapPaymentStatus('checkout_created'),
    'Amount Due':     params.amountDueCents / 100,
    'Currency':       params.currency.toUpperCase(),
    'Stripe Session ID': params.stripeSessionId,
    'Correlation ID': params.correlationId,
    'Created At':     params.createdAt,
  };

  if (params.checkoutUrl) {
    fields['Checkout URL'] = params.checkoutUrl;
  }

  try {
    const response = await fetch(paymentsTableUrl(), {
      method: 'POST',
      headers: baseHeaders(),
      body: JSON.stringify({ fields }),
    });

    if (!response.ok) {
      const body = await response.text();
      log.error(
        { status: response.status, body, paymentId: params.paymentId },
        '[AirtablePayments] Failed to create payment row',
      );
      return null;
    }

    const data = (await response.json()) as { id: string };
    log.info(
      { airtablePaymentRecordId: data.id, parentAirtableRecordId: params.parentAirtableRecordId },
      '[AirtablePayments] Payment row created',
    );
    return data.id;
  } catch (err) {
    log.error(
      { err, paymentId: params.paymentId, stripeSessionId: params.stripeSessionId },
      '[AirtablePayments] Exception creating payment row',
    );
    return null;
  }
}

/**
 * Find an existing Airtable Payments row by Stripe Checkout Session ID.
 * Returns the Airtable record ID, or null if not found.
 */
export async function findAirtablePaymentRowBySessionId(
  stripeSessionId: string,
  correlationId: string,
): Promise<string | null> {
  if (!config.AIRTABLE_API_KEY || !config.AIRTABLE_BASE_ID) return null;

  const log = logger.child({ correlationId, stripeSessionId });

  const filter = encodeURIComponent(`{Stripe Session ID} = "${stripeSessionId}"`);
  const url = `${paymentsTableUrl()}?filterByFormula=${filter}&maxRecords=1`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: baseHeaders(),
    });

    if (!response.ok) {
      const body = await response.text();
      log.error(
        { status: response.status, body },
        '[AirtablePayments] Failed to query payment row by session ID',
      );
      return null;
    }

    const data = (await response.json()) as { records: Array<{ id: string }> };
    if (!data.records || data.records.length === 0) {
      log.warn('[AirtablePayments] No Payments row found for Stripe session ID');
      return null;
    }

    const recordId = data.records[0].id;
    log.info({ airtablePaymentRecordId: recordId }, '[AirtablePayments] Payments row matched by session ID');
    return recordId;
  } catch (err) {
    log.error({ err }, '[AirtablePayments] Exception querying payment row by session ID');
    return null;
  }
}

/**
 * Update an existing Airtable Payments row after successful payment.
 * Idempotent: safe to call on webhook retries.
 */
export async function updateAirtablePaymentRow(
  params: AirtablePaymentUpdateParams,
  correlationId: string,
): Promise<void> {
  if (!config.AIRTABLE_API_KEY || !config.AIRTABLE_BASE_ID) return;

  const log = logger.child({
    correlationId,
    airtablePaymentRecordId: params.airtablePaymentRecordId,
    stripeEventId: params.stripeEventId,
  });

  const url = `${paymentsTableUrl()}/${params.airtablePaymentRecordId}`;

  const fields: Record<string, unknown> = {
    'Payment Status':          mapPaymentStatus('paid'),
    'Amount Paid':             params.amountPaidCents / 100,
    'Stripe Payment Intent ID': params.stripePaymentIntentId,
    'Stripe Event ID':         params.stripeEventId,
    'Paid At':                 params.paidAt,
    'Last Webhook At':         params.lastWebhookAt,
  };

  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: baseHeaders(),
      body: JSON.stringify({ fields }),
    });

    if (!response.ok) {
      const body = await response.text();
      log.error(
        { status: response.status, body },
        '[AirtablePayments] Failed to update payment row',
      );
      return;
    }

    log.info('[AirtablePayments] Payment row updated to paid');
  } catch (err) {
    log.error({ err }, '[AirtablePayments] Exception updating payment row');
  }
}
