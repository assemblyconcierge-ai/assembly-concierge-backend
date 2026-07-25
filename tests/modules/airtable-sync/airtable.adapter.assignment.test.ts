import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AIRTABLE_V2_ASSIGNED_CONTRACTOR_FIELD_ID,
  AirtableJobRecord,
  syncJobToAirtable,
  updateAirtableAssignedContractor,
  updateAirtableStatus,
} from '../../../src/modules/airtable-sync/airtable.adapter';

vi.mock('../../../src/common/config', () => ({
  config: {
    AIRTABLE_API_KEY: 'test-api-key',
    AIRTABLE_BASE_ID: 'appTESTBASEID',
    AIRTABLE_TABLE_JOBS: 'Backend Intake Sandbox V2',
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

const BACKEND_JOB_UUID = '11111111-1111-4111-8111-111111111111';
const BASE_RECORD: AirtableJobRecord = {
  jobId: BACKEND_JOB_UUID,
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

function requestFields(callIndex = 0): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body as string).fields;
}

describe('Airtable V2 assigned contractor linked-record payload', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'recJOB' }),
      text: async () => '',
    });
  });

  it('excludes assignment from the core create payload', async () => {
    await syncJobToAirtable({
      ...BASE_RECORD,
      assignedContractorAirtableRecordId: 'recCONTRACTOR',
    });

    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(requestFields()).not.toHaveProperty(AIRTABLE_V2_ASSIGNED_CONTRACTOR_FIELD_ID);
    expect(requestFields()).not.toHaveProperty('Assigned Contractor');
    expect(requestFields()).not.toHaveProperty('Assigned Contractors');
  });

  it('excludes assignment from the core update payload', async () => {
    await updateAirtableStatus('recJOB', 'assigned');

    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(requestFields()).not.toHaveProperty(AIRTABLE_V2_ASSIGNED_CONTRACTOR_FIELD_ID);
    expect(requestFields()).not.toHaveProperty('Assigned Contractor');
    expect(requestFields()).not.toHaveProperty('Assigned Contractors');
  });

  it('PATCHes exactly the V2 assignment field ID with an Airtable record ID', async () => {
    await updateAirtableAssignedContractor('recJOB', 'recCONTRACTOR');

    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(requestFields()).toEqual({
      fld3r2KDFT37ObiKj: ['recCONTRACTOR'],
    });
    expect(Object.keys(requestFields())).toEqual([AIRTABLE_V2_ASSIGNED_CONTRACTOR_FIELD_ID]);
    expect(requestFields()[AIRTABLE_V2_ASSIGNED_CONTRACTOR_FIELD_ID]).not.toContain(
      BACKEND_JOB_UUID,
    );
  });

  it('clears the V2 assignment link with an empty array', async () => {
    await updateAirtableAssignedContractor('recJOB', null);

    expect(requestFields()).toEqual({
      fld3r2KDFT37ObiKj: [],
    });
  });
});
