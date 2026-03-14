/**
 * Airtable Sync Queue
 *
 * Uses BullMQ when REDIS_URL is configured.
 * Falls back to a simple in-process queue when Redis is not available.
 * Airtable sync failures are logged to integration_failures for retry.
 */

import { logger } from '../../common/logger';
import { config } from '../../common/config';
import { query, queryOne } from '../../db/pool';
import { syncJobToAirtable, updateAirtableStatus, logIntegrationFailure } from './airtable.adapter';

let Queue: any = null;
let Worker: any = null;
let airtableQueue: any = null;

async function initQueue(): Promise<void> {
  if (!config.REDIS_URL) return;

  try {
    const bullmq = await import('bullmq');
    Queue = bullmq.Queue;
    Worker = bullmq.Worker;

    const connection = { url: config.REDIS_URL };
    airtableQueue = new Queue('airtable-sync', { connection });

    new Worker(
      'airtable-sync',
      async (job: any) => {
        await processSyncJob(job.data.jobId, job.data.correlationId);
      },
      {
        connection,
        concurrency: 3,
        limiter: { max: 10, duration: 1000 },
      },
    );

    logger.info('[Queue] Airtable sync queue initialized with Redis');
  } catch (err) {
    logger.warn({ err }, '[Queue] BullMQ init failed — falling back to in-process queue');
  }
}

// Initialize queue on module load
initQueue().catch((err) => logger.error({ err }, '[Queue] Init error'));

/** Enqueue an Airtable sync job */
export async function enqueueAirtableSync(params: {
  jobId: string;
  correlationId: string;
}): Promise<void> {
  if (airtableQueue) {
    await airtableQueue.add('sync', params, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  } else {
    // In-process fallback — run immediately in background
    setImmediate(() => {
      processSyncJob(params.jobId, params.correlationId).catch((err) => {
        logger.warn({ err, jobId: params.jobId }, '[Queue] In-process Airtable sync failed');
      });
    });
  }
}

/** Core sync logic — fetch job + customer data and push to Airtable */
async function processSyncJob(jobId: string, correlationId: string): Promise<void> {
  const log = logger.child({ correlationId, jobId, worker: 'airtable-sync' });

  try {
    const row = await queryOne<{
      id: string;
      job_key: string;
      city_detected: string;
      service_area_status: string;
      rush_requested: boolean;
      total_amount_cents: number;
      deposit_amount_cents: number;
      remainder_amount_cents: number;
      payment_mode: string;
      status: string;
      appointment_date: Date | null;
      appointment_window: string | null;
      custom_job_details: string | null;
      airtable_record_id: string | null;
      created_at: Date;
      customer_full_name: string;
      customer_email: string;
      customer_phone: string;
      service_type_code: string;
      rush_type: string | null;   // stored by migration 004
      // Financial split columns (added by migration 005)
      base_price_cents: number;
      flat_payout_cents: number;
      contractor_rush_bonus_cents: number;
      contractor_total_payout_cents: number;
      rush_platform_share_cents: number;
      stripe_fee_cents: number;
      job_margin_cents: number;
      // Address fields
      addr_line1: string | null;
      addr_state: string | null;
      addr_postal: string | null;
      // Payment fields (from most recent payment record)
      stripe_session_id: string | null;
      stripe_intent_id: string | null;
      // Intake raw payload (for photos and payment type from Jotform)
      raw_payload_json: unknown;
    }>(
      `SELECT
         j.id, j.job_key, j.city_detected, j.service_area_status, j.rush_requested,
         j.total_amount_cents, j.deposit_amount_cents, j.remainder_amount_cents,
         j.payment_mode, j.rush_type, j.status,
         j.base_price_cents, j.flat_payout_cents, j.contractor_rush_bonus_cents,
         j.contractor_total_payout_cents, j.rush_platform_share_cents,
         j.stripe_fee_cents, j.job_margin_cents,
         j.appointment_date, j.appointment_window, j.custom_job_details,
         j.airtable_record_id, j.created_at,
         c.full_name AS customer_full_name, c.email AS customer_email, c.phone_e164 AS customer_phone,
         COALESCE(st.code, 'unknown') AS service_type_code,
         a.line1 AS addr_line1, a.state AS addr_state, a.postal_code AS addr_postal,
         p.provider_session_id AS stripe_session_id,
         p.provider_payment_intent_id AS stripe_intent_id,
         s.raw_payload_json
       FROM jobs j
       JOIN customers c ON c.id = j.customer_id
       JOIN addresses a ON a.id = j.address_id
       LEFT JOIN service_types st ON st.id = j.service_type_id
       LEFT JOIN LATERAL (
         SELECT provider_session_id, provider_payment_intent_id
         FROM payments
         WHERE job_id = j.id
         ORDER BY created_at DESC LIMIT 1
       ) p ON TRUE
       LEFT JOIN intake_submissions s ON s.id = j.intake_submission_id
       WHERE j.id = $1`,
      [jobId],
    );

    if (!row) {
      log.warn('Job not found for Airtable sync');
      return;
    }

    // Extract photo URLs from raw Jotform payload (upload fields)
    const rawPayload = (row.raw_payload_json ?? {}) as Record<string, unknown>;
    const photoUrls: string[] = [];
    for (const [key, val] of Object.entries(rawPayload)) {
      if (!key.toLowerCase().includes('upload') && !key.toLowerCase().includes('photo')) continue;
      if (typeof val === 'string' && val.startsWith('http')) photoUrls.push(val);
      if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === 'string' && item.startsWith('http')) photoUrls.push(item);
          if (typeof item === 'object' && item !== null && 'url' in item) {
            photoUrls.push((item as { url: string }).url);
          }
        }
      }
    }

    // Extract payment type label from raw payload (q83_paymentType)
    const rawPaymentType =
      (rawPayload['q83_paymentType'] as string) ||
      (rawPayload['paymentType'] as string) ||
      undefined;

    const record = {
      // Core identity
      jobKey: row.job_key,
      customerName: row.customer_full_name,
      customerEmail: row.customer_email,
      customerPhone: row.customer_phone,
      city: row.city_detected || '',
      serviceType: row.service_type_code,
      serviceTypeCode: row.service_type_code,
      areaStatus: row.service_area_status,
      rushRequested: row.rush_requested,
      totalAmountCents: row.total_amount_cents,
      depositAmountCents: row.deposit_amount_cents,
      remainingBalanceCents: row.remainder_amount_cents,
      status: row.status,
      appointmentDate: row.appointment_date?.toISOString().split('T')[0],
      appointmentWindow: row.appointment_window ?? undefined,
      createdAt: row.created_at.toISOString(),
      // Extended fields
      addressLine1: row.addr_line1 ?? undefined,
      state: row.addr_state ?? undefined,
      postalCode: row.addr_postal ?? undefined,
      customerNotes: row.custom_job_details ?? undefined,
      jobPhotos: photoUrls.length > 0 ? photoUrls : undefined,
      paymentType: rawPaymentType,
      stripeCheckoutSessionId: row.stripe_session_id ?? undefined,
      stripePaymentIntentId: row.stripe_intent_id ?? undefined,
      dispatchStatus: 'pending',   // always "Pending Dispatch" at intake
      rushType: row.rush_type ?? undefined,
      // Financial split fields (from jobs table columns added by migration 005)
      basePriceCents: row.base_price_cents,
      rushFeeAmountCents: row.total_amount_cents - row.base_price_cents,  // = rush_amount_cents
      contractorFlatPayoutCents: row.flat_payout_cents,
      contractorRushBonusCents: row.contractor_rush_bonus_cents,
      contractorTotalPayoutCents: row.contractor_total_payout_cents,
      stripeFeeCents: row.stripe_fee_cents,
      rushPlatformShareCents: row.rush_platform_share_cents,
      jobMarginCents: row.job_margin_cents,
    };

    if (row.airtable_record_id) {
      // Update existing record — status mapped through safe label layer
      await updateAirtableStatus(
        row.airtable_record_id,
        record.status,
        record.totalAmountCents,
      );
      log.info({ airtableRecordId: row.airtable_record_id }, 'Airtable record updated');
    } else {
      // Create new record
      const airtableId = await syncJobToAirtable(record);
      if (airtableId) {
        await query(
          'UPDATE jobs SET airtable_record_id = $2, updated_at = NOW() WHERE id = $1',
          [jobId, airtableId],
        );
        log.info({ airtableId }, 'Airtable record created');
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Airtable sync failed');
    await logIntegrationFailure({
      integrationName: 'airtable',
      relatedEntityType: 'job',
      relatedEntityId: jobId,
      operationName: 'sync_job',
      payload: { jobId, correlationId },
      errorMessage: msg,
    });
    throw err; // Re-throw so BullMQ retries
  }
}
