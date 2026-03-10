import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../../db/pool';
import { JobStatus } from './job.stateMachine';

export interface JobRow {
  id: string;
  job_key: string;
  customer_id: string;
  address_id: string;
  intake_submission_id: string | null;
  service_type_id: string | null;
  source_channel: string;
  service_area_status: string;
  city_detected: string | null;
  rush_requested: boolean;
  payment_mode: string;
  subtotal_amount_cents: number;
  rush_amount_cents: number;
  deposit_amount_cents: number;
  remainder_amount_cents: number;
  total_amount_cents: number;
  status: JobStatus;
  appointment_date: Date | null;
  appointment_window: string | null;
  special_instructions: string | null;
  custom_job_details: string | null;
  public_pay_token: string | null;
  airtable_record_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function createJob(
  params: {
    jobKey: string;
    customerId: string;
    addressId: string;
    intakeSubmissionId?: string;
    serviceTypeId?: string;
    sourceChannel: string;
    serviceAreaStatus: string;
    cityDetected?: string;
    rushRequested: boolean;
    paymentMode: string;
    subtotalAmountCents: number;
    rushAmountCents: number;
    depositAmountCents: number;
    remainderAmountCents: number;
    totalAmountCents: number;
    status: JobStatus;
    appointmentDate?: string;
    appointmentWindow?: string;
    specialInstructions?: string;
    customJobDetails?: string;
    publicPayToken?: string;
  },
  client: PoolClient,
): Promise<JobRow> {
  const { rows } = await client.query<JobRow>(
    `INSERT INTO jobs (
      id, job_key, customer_id, address_id, intake_submission_id, service_type_id,
      source_channel, service_area_status, city_detected, rush_requested, payment_mode,
      subtotal_amount_cents, rush_amount_cents, deposit_amount_cents, remainder_amount_cents,
      total_amount_cents, status, appointment_date, appointment_window,
      special_instructions, custom_job_details, public_pay_token
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
    ) RETURNING *`,
    [
      uuidv4(),
      params.jobKey,
      params.customerId,
      params.addressId,
      params.intakeSubmissionId ?? null,
      params.serviceTypeId ?? null,
      params.sourceChannel,
      params.serviceAreaStatus,
      params.cityDetected ?? null,
      params.rushRequested,
      params.paymentMode,
      params.subtotalAmountCents,
      params.rushAmountCents,
      params.depositAmountCents,
      params.remainderAmountCents,
      params.totalAmountCents,
      params.status,
      params.appointmentDate ?? null,
      params.appointmentWindow ?? null,
      params.specialInstructions ?? null,
      params.customJobDetails ?? null,
      params.publicPayToken ?? null,
    ],
  );
  return rows[0];
}

export async function getJobById(id: string): Promise<JobRow | null> {
  return queryOne<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
}

export async function getJobByKey(jobKey: string): Promise<JobRow | null> {
  return queryOne<JobRow>('SELECT * FROM jobs WHERE job_key = $1', [jobKey]);
}

export async function getJobByPublicPayToken(token: string): Promise<JobRow | null> {
  return queryOne<JobRow>('SELECT * FROM jobs WHERE public_pay_token = $1', [token]);
}

export async function updateJobStatus(
  id: string,
  status: JobStatus,
  client?: PoolClient,
): Promise<void> {
  const sql = `UPDATE jobs SET status = $2, updated_at = NOW() WHERE id = $1`;
  if (client) {
    await client.query(sql, [id, status]);
  } else {
    await query(sql, [id, status]);
  }
}

export async function updateAirtableRecordId(
  id: string,
  airtableRecordId: string,
): Promise<void> {
  await query(
    `UPDATE jobs SET airtable_record_id = $2, updated_at = NOW() WHERE id = $1`,
    [id, airtableRecordId],
  );
}

export interface JobSearchParams {
  status?: JobStatus;
  city?: string;
  serviceType?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function searchJobs(params: JobSearchParams): Promise<JobRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.status) {
    conditions.push(`j.status = $${idx++}`);
    values.push(params.status);
  }
  if (params.city) {
    conditions.push(`LOWER(j.city_detected) = LOWER($${idx++})`);
    values.push(params.city);
  }
  if (params.from) {
    conditions.push(`j.created_at >= $${idx++}`);
    values.push(params.from);
  }
  if (params.to) {
    conditions.push(`j.created_at <= $${idx++}`);
    values.push(params.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  return query<JobRow>(
    `SELECT j.* FROM jobs j ${where} ORDER BY j.created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
    [...values, limit, offset],
  );
}
