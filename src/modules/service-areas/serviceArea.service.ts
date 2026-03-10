import { query, queryOne } from '../../db/pool';
import { normalizeCity } from '../../common/utils';

export type ServiceAreaStatus = 'in_area' | 'quote_only' | 'blocked';

export interface ServiceAreaResult {
  status: ServiceAreaStatus;
  city: string;
  state: string;
  notes?: string;
}

interface ServiceAreaRow {
  id: string;
  city: string;
  state: string;
  is_active: boolean;
  serviceability_status: ServiceAreaStatus;
  notes: string | null;
}

/**
 * Classify a city against the service_areas table.
 * Falls back to 'quote_only' for any city not explicitly configured.
 * Empty/invalid city routes to 'quote_only' with a note.
 */
export async function classifyServiceArea(
  city: string,
  state = 'GA',
): Promise<ServiceAreaResult> {
  if (!city || city.trim().length === 0) {
    return { status: 'quote_only', city: city || '', state, notes: 'City not provided' };
  }

  const normalized = normalizeCity(city);

  const row = await queryOne<ServiceAreaRow>(
    `SELECT * FROM service_areas
     WHERE LOWER(city) = $1 AND state = $2 AND is_active = TRUE
     LIMIT 1`,
    [normalized, state.toUpperCase()],
  );

  if (!row) {
    return { status: 'quote_only', city, state, notes: 'City not in configured service areas' };
  }

  return {
    status: row.serviceability_status,
    city: row.city,
    state: row.state,
    notes: row.notes ?? undefined,
  };
}

/** Get all active service areas */
export async function getAllServiceAreas(): Promise<ServiceAreaRow[]> {
  return query<ServiceAreaRow>(
    'SELECT * FROM service_areas WHERE is_active = TRUE ORDER BY city',
  );
}

/** Upsert a service area (admin config) */
export async function upsertServiceArea(params: {
  city: string;
  state: string;
  status: ServiceAreaStatus;
  notes?: string;
}): Promise<ServiceAreaRow> {
  const rows = await query<ServiceAreaRow>(
    `INSERT INTO service_areas (city, state, serviceability_status, notes, is_active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (LOWER(city), state)
     DO UPDATE SET
       serviceability_status = EXCLUDED.serviceability_status,
       notes = EXCLUDED.notes,
       is_active = TRUE
     RETURNING *`,
    [params.city, params.state.toUpperCase(), params.status, params.notes ?? null],
  );
  return rows[0];
}
