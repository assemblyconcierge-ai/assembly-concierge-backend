import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyServiceArea } from '../../src/modules/service-areas/serviceArea.service';

// Mock pool for service area tests
vi.mock('../../src/db/pool', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

import { queryOne } from '../../src/db/pool';

const mockQueryOne = vi.mocked(queryOne);

describe('Service area classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies Hampton as in_area', async () => {
    mockQueryOne.mockResolvedValueOnce({
      id: '1',
      city: 'Hampton',
      state: 'GA',
      is_active: true,
      serviceability_status: 'in_area',
      notes: null,
    });

    const result = await classifyServiceArea('Hampton', 'GA');
    expect(result.status).toBe('in_area');
    expect(result.city).toBe('Hampton');
  });

  it('classifies Stockbridge as in_area', async () => {
    mockQueryOne.mockResolvedValueOnce({
      id: '2',
      city: 'Stockbridge',
      state: 'GA',
      is_active: true,
      serviceability_status: 'in_area',
      notes: null,
    });

    const result = await classifyServiceArea('Stockbridge', 'GA');
    expect(result.status).toBe('in_area');
  });

  it('classifies McDonough as in_area', async () => {
    mockQueryOne.mockResolvedValueOnce({
      id: '3',
      city: 'McDonough',
      state: 'GA',
      is_active: true,
      serviceability_status: 'in_area',
      notes: null,
    });

    const result = await classifyServiceArea('McDonough', 'GA');
    expect(result.status).toBe('in_area');
  });

  it('classifies unknown city as quote_only', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await classifyServiceArea('Atlanta', 'GA');
    expect(result.status).toBe('quote_only');
  });

  it('classifies empty city as quote_only with note', async () => {
    const result = await classifyServiceArea('', 'GA');
    expect(result.status).toBe('quote_only');
    expect(result.notes).toContain('not provided');
  });

  it('classifies blocked city as blocked', async () => {
    mockQueryOne.mockResolvedValueOnce({
      id: '4',
      city: 'Blocked City',
      state: 'GA',
      is_active: true,
      serviceability_status: 'blocked',
      notes: 'Outside range',
    });

    const result = await classifyServiceArea('Blocked City', 'GA');
    expect(result.status).toBe('blocked');
  });
});
