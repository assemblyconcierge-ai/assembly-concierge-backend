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
import { syncJobToAirtable, updateAirtableRecord, logIntegrationFailure } from './airtable.adapter';

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
      status: string;
      appointment_date: Date | null;
      appointment_window: string | null;
      airtable_record_id: string | null;
      created_at: Date;
      customer_full_name: string;
      customer_email: string;
      customer_phone: string;
      service_type_code: string;
    }>(
      `SELECT
         j.id, j.job_key, j.city_detected, j.service_area_status, j.rush_requested,
         j.total_amount_cents, j.deposit_amount_cents, j.status,
         j.appointment_date, j.appointment_window, j.airtable_record_id, j.created_at,
         c.full_name AS customer_full_name, c.email AS customer_email, c.phone_e164 AS customer_phone,
         COALESCE(st.code, 'unknown') AS service_type_code
       FROM jobs j
       JOIN customers c ON c.id = j.customer_id
       LEFT JOIN service_types st ON st.id = j.service_type_id
       WHERE j.id = $1`,
      [jobId],
    );

    if (!row) {
      log.warn('Job not found for Airtable sync');
      return;
    }

    const record = {
      jobKey: row.job_key,
      customerName: row.customer_full_name,
      customerEmail: row.customer_email,
      customerPhone: row.customer_phone,
      city: row.city_detected || '',
      serviceType: row.service_type_code,
      rushRequested: row.rush_requested,
      totalAmountCents: row.total_amount_cents,
      depositAmountCents: row.deposit_amount_cents,
      status: row.status,
      appointmentDate: row.appointment_date?.toISOString().split('T')[0],
      appointmentWindow: row.appointment_window ?? undefined,
      createdAt: row.created_at.toISOString(),
    };

    if (row.airtable_record_id) {
      // Update existing record
      await updateAirtableRecord(row.airtable_record_id, {
        'Status': record.status,
        'Total Amount': record.totalAmountCents / 100,
      });
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
