import { vi } from 'vitest';

// Mock the DB pool so tests never need a real Postgres connection
vi.mock('../../src/db/pool', () => {
  const store: Record<string, unknown[]> = {};

  const mockQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    // Return empty arrays by default; individual tests override as needed
    return [];
  });

  const mockQueryOne = vi.fn(async (sql: string, params?: unknown[]) => {
    return null;
  });

  const mockWithTransaction = vi.fn(async (fn: (client: any) => Promise<unknown>) => {
    const mockClient = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    return fn(mockClient);
  });

  return {
    query: mockQuery,
    queryOne: mockQueryOne,
    withTransaction: mockWithTransaction,
    getPool: vi.fn(() => ({ query: vi.fn(async () => ({ rows: [] })) })),
    closePool: vi.fn(),
  };
});

// Mock Airtable sync queue so tests don't need Redis
vi.mock('../../src/modules/airtable-sync/airtableSync.queue', () => ({
  enqueueAirtableSync: vi.fn(async () => {}),
}));

// Suppress logger output in tests
vi.mock('../../src/common/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));
