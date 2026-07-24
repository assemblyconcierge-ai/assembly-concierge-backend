import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AirtableJobRecord,
  syncJobToAirtable,
  updateAirtableStatus,
} from '../../../src/modules/airtable-sync/airtable.adapter';

vi.mock('../../../src/common/config', () => ({
  config: {
    AIRTABLE_API_KEY: 'test-api-key',
    AIRTABLE_BASE_ID: 'appTESTBASEID',
    AIRTABLE_TABLE_JOBS: 'Jobs',
    NODE_ENV: 'test',
  },
}));

vi.mock('../../../src/common/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../src/db/pool', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const BASE_RECORD: AirtableJobRecord = {
  jobId: 'job-backend-uuid',
  jobKey: 'AC-2026-TEST',
  customerName: 'Customer',
  customerEmail: 'customer@example.com',
  customerPhone: '+15555550100',
  city: 'Atlanta',
  serviceType: 'small',
  rushRequested: false,
  totalAmountCents: 10_000,
  depositAmountCents: 2_500,
  status: 'assigned',
  createdAt: '2026-07-24T12:00:00.000Z',
};

function requestFields(): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string).fields;
}

async function updateAssignmentLink(value: string | null | undefined): Promise<void> {
  await updateAirtableStatus(
    'recJOB',
    'assigned',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    value,
  );
}

describe('Airtable assigned contractor linked-record payload', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'recJOB' }),
      text: async () => '',
    });
  });

  it('writes Assigned Contractors as an Airtable record ID array on create', async () => {
    await syncJobToAirtable({
      ...BASE_RECORD,
      assignedContractorAirtableRecordId: 'recCONTRACTOR',
    });

    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(requestFields()['Assigned Contractors']).toEqual(['recCONTRACTOR']);
    expect(requestFields()['Assigned Contractors']).not.toContain(BASE_RECORD.jobId);
  });

  it('omits Assigned Contractors on create when there is no usable assignment', async () => {
    await syncJobToAirtable(BASE_RECORD);

    expect(requestFields()).not.toHaveProperty('Assigned Contractors');
  });

  it('writes Assigned Contractors as an Airtable record ID array on update', async () => {
    await updateAssignmentLink('recNEWCONTRACTOR');

    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(requestFields()['Assigned Contractors']).toEqual(['recNEWCONTRACTOR']);
  });

  it('clears Assigned Contractors on update when no usable assignment exists', async () => {
    await updateAssignmentLink(null);

    expect(requestFields()['Assigned Contractors']).toEqual([]);
  });

  it('leaves Assigned Contractors untouched when assignment mirroring is omitted', async () => {
    await updateAssignmentLink(undefined);

    expect(requestFields()).not.toHaveProperty('Assigned Contractors');
  });
});
