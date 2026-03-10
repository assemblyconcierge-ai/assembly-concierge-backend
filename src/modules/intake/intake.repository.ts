import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../../db/pool';
import { CanonicalIntake } from './intake.types';

export interface IntakeSubmissionRow {
  id: string;
  source: string;
  external_submission_id: string;
  raw_payload_json: Record<string, unknown>;
  normalized_payload_json: CanonicalIntake | null;
  received_at: Date;
  processed_at: Date | null;
  processing_status: string;
  idempotency_key: string;
  correlation_id: string;
  error_message: string | null;
}

/** Check if an intake submission already exists (idempotency) */
export async function findByIdempotencyKey(
  key: string,
): Promise<IntakeSubmissionRow | null> {
  return queryOne<IntakeSubmissionRow>(
    'SELECT * FROM intake_submissions WHERE idempotency_key = $1',
    [key],
  );
}

/** Persist the raw payload immediately — before any processing */
export async function createIntakeSubmission(params: {
  source: string;
  externalSubmissionId: string;
  rawPayload: Record<string, unknown>;
  idempotencyKey: string;
  correlationId: string;
}): Promise<IntakeSubmissionRow> {
  const id = uuidv4();
  const rows = await query<IntakeSubmissionRow>(
    `INSERT INTO intake_submissions
      (id, source, external_submission_id, raw_payload_json, idempotency_key, correlation_id, processing_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'received')
     RETURNING *`,
    [
      id,
      params.source,
      params.externalSubmissionId,
      JSON.stringify(params.rawPayload),
      params.idempotencyKey,
      params.correlationId,
    ],
  );
  return rows[0];
}

/** Mark submission as processing */
export async function markProcessing(id: string): Promise<void> {
  await query(
    `UPDATE intake_submissions SET processing_status = 'processing' WHERE id = $1`,
    [id],
  );
}

/** Mark submission as processed with normalized payload */
export async function markProcessed(
  id: string,
  normalizedPayload: CanonicalIntake,
  client?: PoolClient,
): Promise<void> {
  const sql = `
    UPDATE intake_submissions
    SET processing_status = 'processed',
        normalized_payload_json = $2,
        processed_at = NOW()
    WHERE id = $1
  `;
  if (client) {
    await client.query(sql, [id, JSON.stringify(normalizedPayload)]);
  } else {
    await query(sql, [id, JSON.stringify(normalizedPayload)]);
  }
}

/** Mark submission as failed */
export async function markFailed(id: string, errorMessage: string): Promise<void> {
  await query(
    `UPDATE intake_submissions
     SET processing_status = 'failed', error_message = $2
     WHERE id = $1`,
    [id, errorMessage],
  );
}

/** Mark as duplicate */
export async function markDuplicate(id: string): Promise<void> {
  await query(
    `UPDATE intake_submissions SET processing_status = 'duplicate' WHERE id = $1`,
    [id],
  );
}

export async function getRecentSubmissions(limit = 50): Promise<IntakeSubmissionRow[]> {
  return query<IntakeSubmissionRow>(
    'SELECT * FROM intake_submissions ORDER BY received_at DESC LIMIT $1',
    [limit],
  );
}
