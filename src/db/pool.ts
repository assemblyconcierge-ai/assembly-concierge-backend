import { Pool, PoolClient } from 'pg';
import { config } from '../common/config';
import { logger } from '../common/logger';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    if (!config.DATABASE_URL || !config.DATABASE_URL.startsWith('postgres')) {
      throw new Error('[DB] DATABASE_URL must be a postgres:// or postgresql:// connection string');
    }
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl:
        config.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false,
    });

    pool.on('error', (err) => {
      logger.error({ err }, '[DB] Unexpected pool error');
    });

    logger.info('[DB] PostgreSQL pool initialized');
  }
  return pool;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const p = getPool();
  const result = await p.query(sql, params);
  return result.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('[DB] Pool closed');
  }
}
