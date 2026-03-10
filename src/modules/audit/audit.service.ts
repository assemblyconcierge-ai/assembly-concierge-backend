import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../db/pool';

export type ActorType = 'system' | 'admin' | 'provider' | 'customer';

export interface AuditEventParams {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  actorType?: ActorType;
  payload?: Record<string, unknown>;
  correlationId?: string;
  client?: PoolClient;
}

export async function recordAuditEvent(params: AuditEventParams): Promise<void> {
  const sql = `
    INSERT INTO audit_events
      (id, aggregate_type, aggregate_id, event_type, actor_type, event_payload_json, correlation_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `;
  const values = [
    uuidv4(),
    params.aggregateType,
    params.aggregateId,
    params.eventType,
    params.actorType ?? 'system',
    JSON.stringify(params.payload ?? {}),
    params.correlationId ?? null,
  ];

  if (params.client) {
    await params.client.query(sql, values);
  } else {
    await query(sql, values);
  }
}

export async function getAuditEvents(
  aggregateType: string,
  aggregateId: string,
): Promise<Array<{
  id: string;
  event_type: string;
  actor_type: ActorType;
  event_payload_json: Record<string, unknown>;
  correlation_id: string | null;
  created_at: Date;
}>> {
  return query(
    `SELECT id, event_type, actor_type, event_payload_json, correlation_id, created_at
     FROM audit_events
     WHERE aggregate_type = $1 AND aggregate_id = $2
     ORDER BY created_at ASC`,
    [aggregateType, aggregateId],
  ) as Promise<Array<{
    id: string;
    event_type: string;
    actor_type: ActorType;
    event_payload_json: Record<string, unknown>;
    correlation_id: string | null;
    created_at: Date;
  }>>;
}
