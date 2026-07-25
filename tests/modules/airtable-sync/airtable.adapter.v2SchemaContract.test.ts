import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AIRTABLE_V2_ASSIGNED_CONTRACTOR_FIELD_ID_CONTRACT,
  AIRTABLE_V2_JOB_FIELD_NAMES,
} from '../../fixtures/airtableV2Schema';
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

function requestFields(callIndex: number): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body as string).fields;
}

const MAXIMAL_JOB_RECORD: AirtableJobRecord = {
  jobId: 'job-uuid',
  jobKey: 'AC-2026-SCHEMA',
  customerName: 'Customer',
  customerEmail: 'customer@example.com',
  customerPhone: '+15555550100',
  city: 'Atlanta',
  serviceType: 'small',
  areaStatus: 'in_area',
  rushRequested: true,
  totalAmountCents: 15_000,
  depositAmountCents: 2_500,
  status: 'completion_reported',
  appointmentDate: '2026-07-25',
  appointmentWindow: 'Morning (8am-12pm)',
  scheduledStartAt: '2026-07-25T08:00:00',
  scheduledEndAt: '2026-07-25T12:00:00',
  createdAt: '2026-07-24T12:00:00.000Z',
  addressLine1: '123 Main St',
  state: 'GA',
  postalCode: '30303',
  customerNotes: 'Handle carefully',
  jobPhotos: ['https://example.com/intake.jpg'],
  remainingBalanceCents: 12_500,
  paymentType: '$25 Deposit',
  stripeCheckoutSessionId: 'cs_123',
  stripePaymentIntentId: 'pi_123',
  serviceTypeCode: 'small',
  dispatchStatus: 'accepted',
  rushType: 'Same-day (+30)',
  completionReportedAt: '2026-07-25T14:00:00.000Z',
  completedAt: '2026-07-25T15:00:00.000Z',
  contractorEnRouteAt: '2026-07-25T11:00:00.000Z',
  customerOtwTextSentAt: '2026-07-25T11:01:00.000Z',
  customerOtwTextStatus: 'sent',
  assignedContractorAirtableRecordId: 'recCONTRACTOR',
  basePriceCents: 12_000,
  rushFeeAmountCents: 3_000,
  contractorFlatPayoutCents: 7_000,
  contractorRushBonusCents: 1_000,
  contractorTotalPayoutCents: 8_000,
  stripeFeeCents: 450,
  rushPlatformShareCents: 2_000,
  jobMarginCents: 4_550,
  photoCount: 1,
  photosUploaded: true,
  lastPhotoUploadedAt: '2026-07-25T10:00:00.000Z',
  operatorPhotoLink: 'https://api.example.com/public/photos/review/token',
  completionPhotoStats: {
    completionPhotoCount: 1,
    completionPhotosUploaded: true,
    completionEvidenceLink: 'https://api.example.com/admin/jobs/job-uuid/completion-photos',
    completionPhotos: [{
      url: 'https://example.com/completion.jpg',
      filename: 'completion.jpg',
    }],
    completionReviewStatus: 'Completion Photos Received',
  },
};

describe('Backend Intake Sandbox V2 Jobs schema contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'recJOB' }),
      text: async () => '',
    });
  });

  it('contains every Jobs field emitted by the core create and update payloads', async () => {
    await syncJobToAirtable(MAXIMAL_JOB_RECORD);
    await updateAirtableStatus(
      'recJOB',
      MAXIMAL_JOB_RECORD.status,
      MAXIMAL_JOB_RECORD.totalAmountCents,
      MAXIMAL_JOB_RECORD.stripePaymentIntentId,
      new Date('2026-07-25T15:30:00.000Z'),
      undefined,
      MAXIMAL_JOB_RECORD.completionReportedAt,
      MAXIMAL_JOB_RECORD.remainingBalanceCents,
      MAXIMAL_JOB_RECORD.dispatchStatus,
      MAXIMAL_JOB_RECORD.completedAt,
      MAXIMAL_JOB_RECORD.contractorEnRouteAt,
      MAXIMAL_JOB_RECORD.customerOtwTextSentAt,
      MAXIMAL_JOB_RECORD.customerOtwTextStatus,
      {
        photoCount: MAXIMAL_JOB_RECORD.photoCount!,
        photosUploaded: MAXIMAL_JOB_RECORD.photosUploaded!,
        lastPhotoUploadedAt: MAXIMAL_JOB_RECORD.lastPhotoUploadedAt,
        operatorPhotoLink: MAXIMAL_JOB_RECORD.operatorPhotoLink,
      },
      MAXIMAL_JOB_RECORD.completionPhotoStats,
    );

    const emittedCoreFields = new Set([
      ...Object.keys(requestFields(0)),
      ...Object.keys(requestFields(1)),
    ]);
    const createFields = requestFields(0);
    const updateFields = requestFields(1);
    const unknownFields = [...emittedCoreFields].filter(
      (field) => !AIRTABLE_V2_JOB_FIELD_NAMES.has(field),
    );

    expect(unknownFields).toEqual([]);
    expect(createFields).toEqual(expect.objectContaining({
      Status: 'in_progress',
      'Photo Count': 1,
      'Job Photos': [{ url: 'https://example.com/intake.jpg' }],
      'Completion Photos': [{
        url: 'https://example.com/completion.jpg',
        filename: 'completion.jpg',
      }],
      'Payment Type': '$25 Deposit',
      'Stripe Checkout Session ID': 'cs_123',
      'Stripe Payment Intent ID': 'pi_123',
      'Remaining Balance': 125,
      'Completion Reported At': '2026-07-25T14:00:00.000Z',
    }));
    expect(updateFields).toEqual(expect.objectContaining({
      Status: 'in_progress',
      'Photo Count': 1,
      'Completion Photos': [{
        url: 'https://example.com/completion.jpg',
        filename: 'completion.jpg',
      }],
      'Stripe Payment Intent ID': 'pi_123',
      'Remaining Balance': 125,
      'Completion Reported At': '2026-07-25T14:00:00.000Z',
      'Completed At': '2026-07-25T15:00:00.000Z',
    }));
    expect(emittedCoreFields).not.toContain('Assigned Contractor');
    expect(emittedCoreFields).not.toContain('Assigned Contractors');
    expect(emittedCoreFields).not.toContain(AIRTABLE_V2_ASSIGNED_CONTRACTOR_FIELD_ID);
  });

  it('keeps the isolated assignment field ID aligned with the V2 schema contract', async () => {
    expect(AIRTABLE_V2_ASSIGNED_CONTRACTOR_FIELD_ID)
      .toBe(AIRTABLE_V2_ASSIGNED_CONTRACTOR_FIELD_ID_CONTRACT);

    await updateAirtableAssignedContractor('recJOB', 'recCONTRACTOR');

    expect(Object.keys(requestFields(0))).toEqual([
      AIRTABLE_V2_ASSIGNED_CONTRACTOR_FIELD_ID_CONTRACT,
    ]);
  });
});
