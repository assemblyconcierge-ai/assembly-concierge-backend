import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';

export interface CustomerRow {
  id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string;
  phone_e164: string;
  created_at: Date;
  updated_at: Date;
}

export interface AddressRow {
  id: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string | null;
  country: string;
  normalized_text: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Upsert customer by email — returns existing or newly created record */
export async function upsertCustomer(
  params: {
    firstName: string;
    lastName: string;
    fullName: string;
    email: string;
    phoneE164: string;
  },
  client: PoolClient,
): Promise<CustomerRow> {
  const { rows } = await client.query<CustomerRow>(
    `INSERT INTO customers (id, first_name, last_name, full_name, email, phone_e164)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (email) DO UPDATE SET
       first_name = EXCLUDED.first_name,
       last_name  = EXCLUDED.last_name,
       full_name  = EXCLUDED.full_name,
       phone_e164 = EXCLUDED.phone_e164,
       updated_at = NOW()
     RETURNING *`,
    [
      uuidv4(),
      params.firstName,
      params.lastName,
      params.fullName,
      params.email.toLowerCase(),
      params.phoneE164,
    ],
  );
  return rows[0];
}

/** Create a new address record */
export async function createAddress(
  params: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode?: string;
  },
  client: PoolClient,
): Promise<AddressRow> {
  const normalizedText = [params.line1, params.city, params.state, params.postalCode]
    .filter(Boolean)
    .join(', ');

  const { rows } = await client.query<AddressRow>(
    `INSERT INTO addresses (id, line1, line2, city, state, postal_code, normalized_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      uuidv4(),
      params.line1 || '',
      params.line2 ?? null,
      params.city,
      params.state || 'GA',
      params.postalCode ?? null,
      normalizedText,
    ],
  );
  return rows[0];
}
