import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('../../../src/modules/airtable-sync/airtableSync.queue');

vi.mock('../../../src/common/config', () => ({
  config: {
    REDIS_URL: undefined,
    APP_BASE_URL: 'https://api.example.com',
    ALERT_WEBHOOK_URL: undefined,
    NODE_ENV: 'test',
  },
}));

vi.mock('../../../src/common/logger', () => {
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { logger: { ...log, child: vi.fn(() => log) } };
});

vi.mock('../../../src/db/pool', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

vi.mock('../../../src/modules/airtable-sync/airtable.adapter', () => ({
  syncJobToAirtable: vi.fn(),
  updateAirtableAssignedContractor: vi.fn(),
  updateAirtableStatus: vi.fn(),
  logIntegrationFailure: vi.fn(),
}));

vi.mock('../../../src/modules/storage/s3.service', () => ({
  generatePresignedDownloadUrl: vi.fn(),
}));

import { query, queryOne } from '../../../src/db/pool';
import {
  logIntegrationFailure,
  syncJobToAirtable,
  updateAirtableAssignedContractor,
  updateAirtableStatus,
} from '../../../src/modules/airtable-sync/airtable.adapter';
import { generatePresignedDownloadUrl } from '../../../src/modules/storage/s3.service';
import { processSyncJob } from '../../../src/modules/airtable-sync/airtableSync.queue';

const CONTRACTOR_BACKEND_UUID = '11111111-1111-4111-8111-111111111111';

function makeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-uuid',
    job_key: 'AC-2026-TEST',
    city_detected: 'Atlanta',
    service_area_status: 'in_area',
    rush_requested: false,
    total_amount_cents: 10_000,
    deposit_amount_cents: 2_500,
    remainder_amount_cents: 7_500,
    payment_mode: 'deposit',
    status: 'assigned',
    appointment_date: null,
    appointment_window: null,
    scheduled_start_at: null,
    scheduled_end_at: null,
    timezone: 'America/New_York',
    custom_job_details: null,
    airtable_record_id: 'recJOB',
    created_at: new Date('2026-07-24T12:00:00.000Z'),
    updated_at: new Date('2026-07-24T13:00:00.000Z'),
    customer_full_name: 'Customer',
    customer_email: 'customer@example.com',
    customer_phone: '+15555550100',
    service_type_code: 'small',
    rush_type: null,
    base_price_cents: 10_000,
    flat_payout_cents: 6_000,
    contractor_rush_bonus_cents: 0,
    contractor_total_payout_cents: 6_000,
    rush_platform_share_cents: 0,
    stripe_fee_cents: 300,
    job_margin_cents: 3_700,
    addr_line1: '123 Main St',
    addr_state: 'GA',
    addr_postal: '30303',
    stripe_session_id: null,
    stripe_intent_id: null,
    raw_payload_json: {},
    completion_reported_at: null,
    completed_at: null,
    contractor_en_route_at: null,
    customer_otw_text_sent_at: null,
    customer_otw_text_status: null,
    dispatch_status: 'accepted',
    current_assignment_id: 'assignment-uuid',
    current_assignment_status: 'accepted',
    assigned_contractor_airtable_record_id: 'recCONTRACTOR',
    assigned_contractor_backend_id: CONTRACTOR_BACKEND_UUID,
    photo_count: '0',
    last_photo_uploaded_at: null,
    operator_photo_token: null,
    ...overrides,
  };
}

async function syncExisting(overrides: Record<string, unknown>): Promise<unknown> {
  vi.mocked(queryOne).mockResolvedValueOnce(makeJobRow(overrides) as any);
  await processSyncJob('job-uuid', 'corr-1');
  return vi.mocked(updateAirtableAssignedContractor).mock.calls[0][1];
}

describe('Airtable assignment selection and isolated queue mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue([]);
    vi.mocked(syncJobToAirtable).mockResolvedValue('recJOB');
    vi.mocked(updateAirtableStatus).mockResolvedValue(undefined);
    vi.mocked(updateAirtableAssignedContractor).mockResolvedValue(undefined);
    vi.mocked(logIntegrationFailure).mockResolvedValue(undefined);
    vi.mocked(generatePresignedDownloadUrl).mockResolvedValue('https://signed.example/photo.jpg');
  });

  it('uses deterministic accepted, pending, completed precedence in the sync SQL', async () => {
    await syncExisting({});

    const sql = vi.mocked(queryOne).mock.calls[0][0];
    expect(sql).toContain("ca.status IN ('accepted', 'pending', 'completed')");
    expect(sql).toMatch(/WHEN 'accepted' THEN 1[\s\S]*WHEN 'pending' THEN 2[\s\S]*WHEN 'completed' THEN 3/);
    expect(sql).toMatch(/ca\.assigned_at DESC,\s*ca\.id DESC/);
    expect(sql).not.toContain("'declined'");
    expect(sql).not.toContain("'cancelled'");
  });

  it.each([
    ['pending assignment', 'pending', 'recPENDING'],
    ['accepted assignment', 'accepted', 'recACCEPTED'],
    ['completed assignment', 'completed', 'recCOMPLETED'],
  ])('retains the selected contractor for a %s', async (_label, status, airtableId) => {
    const linkValue = await syncExisting({
      current_assignment_status: status,
      assigned_contractor_airtable_record_id: airtableId,
    });

    expect(linkValue).toBe(airtableId);
    expect(linkValue).not.toBe(CONTRACTOR_BACKEND_UUID);
  });

  it.each([
    ['no assignment', null],
    ['declined assignment', 'declined'],
    ['cancelled assignment', 'cancelled'],
  ])('clears the link for %s', async (_label, excludedStatus) => {
    const linkValue = await syncExisting({
      current_assignment_id: null,
      current_assignment_status: excludedStatus,
      assigned_contractor_airtable_record_id: null,
    });

    expect(linkValue).toBeNull();
  });

  it('replaces the former contractor with the newly selected reassignment', async () => {
    const linkValue = await syncExisting({
      current_assignment_id: 'new-assignment-uuid',
      current_assignment_status: 'pending',
      assigned_contractor_airtable_record_id: 'recNEWCONTRACTOR',
    });

    expect(linkValue).toBe('recNEWCONTRACTOR');
    expect(linkValue).not.toBe('recFORMERCONTRACTOR');
  });

  it('clears an existing link when the selected contractor lacks airtable_record_id', async () => {
    const linkValue = await syncExisting({
      current_assignment_status: 'accepted',
      assigned_contractor_airtable_record_id: null,
    });

    expect(linkValue).toBeNull();
  });

  it('runs the core update before the isolated assignment PATCH', async () => {
    await syncExisting({});

    expect(vi.mocked(updateAirtableStatus).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(updateAirtableAssignedContractor).mock.invocationCallOrder[0]);
  });

  it('preserves status, payment, photo, attachment, and completion fields in the core update', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(makeJobRow({
      status: 'completion_reported',
      stripe_intent_id: 'pi_123',
      completion_reported_at: new Date('2026-07-24T14:00:00.000Z'),
      completed_at: new Date('2026-07-24T15:00:00.000Z'),
      photo_count: '2',
      last_photo_uploaded_at: new Date('2026-07-24T13:30:00.000Z'),
      operator_photo_token: 'review-token',
    }) as any);
    vi.mocked(query).mockResolvedValueOnce([
      {
        storage_key:
          'jobs/AC-2026-TEST/completion/completion-job-uuid-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-1.jpg',
        original_filename: 'image.jpg',
        mime_type: 'image/jpeg',
      },
      {
        storage_key:
          'jobs/AC-2026-TEST/completion/completion-job-uuid-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-2.jpg',
        original_filename: 'image.jpg',
        mime_type: 'image/jpeg',
      },
    ] as any);

    await processSyncJob('job-uuid', 'corr-1');

    const args = vi.mocked(updateAirtableStatus).mock.calls[0];
    expect(args[1]).toBe('completion_reported');
    expect(args[2]).toBe(10_000);
    expect(args[3]).toBe('pi_123');
    expect(args[6]).toBe('2026-07-24T14:00:00.000Z');
    expect(args[7]).toBe(7_500);
    expect(args[13]).toEqual({
      photoCount: 2,
      photosUploaded: true,
      lastPhotoUploadedAt: '2026-07-24T13:30:00.000Z',
      operatorPhotoLink: 'https://api.example.com/public/photos/review/review-token',
    });
    expect(args[14]).toEqual(expect.objectContaining({
      completionPhotoCount: 2,
      completionPhotosUploaded: true,
      completionEvidenceLink: 'https://api.example.com/admin/jobs/job-uuid/completion-photos',
      completionPhotos: [
        {
          url: 'https://signed.example/photo.jpg',
          filename:
            'completion-job-uuid-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-1.jpg',
        },
        {
          url: 'https://signed.example/photo.jpg',
          filename:
            'completion-job-uuid-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-2.jpg',
        },
      ],
      completionReviewStatus: 'Completion Photos Received',
    }));
  });

  it('retains original_filename for a legacy completion-photo storage key', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(makeJobRow({
      status: 'completion_reported',
    }) as any);
    vi.mocked(query).mockResolvedValueOnce([{
      storage_key: 'jobs/AC-2026-TEST/completion/legacy-object-key.jpg',
      original_filename: 'finished-assembly.jpg',
      mime_type: 'image/jpeg',
    }] as any);

    await processSyncJob('job-uuid', 'corr-1');

    const completionPhotoStats =
      vi.mocked(updateAirtableStatus).mock.calls[0][14];
    expect(completionPhotoStats?.completionPhotos).toEqual([{
      url: 'https://signed.example/photo.jpg',
      filename: 'finished-assembly.jpg',
    }]);
  });

  it('persists a newly created Airtable record ID before assignment mirroring', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(makeJobRow({
      airtable_record_id: null,
      current_assignment_status: 'pending',
      assigned_contractor_airtable_record_id: 'recCREATECONTRACTOR',
    }) as any);

    await processSyncJob('job-uuid', 'corr-1');

    const updateCallIndex = vi.mocked(query).mock.calls.findIndex(
      ([sql]) => String(sql).includes('UPDATE jobs SET airtable_record_id'),
    );
    expect(updateCallIndex).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(query).mock.invocationCallOrder[updateCallIndex])
      .toBeLessThan(vi.mocked(updateAirtableAssignedContractor).mock.invocationCallOrder[0]);
    expect(updateAirtableAssignedContractor).toHaveBeenCalledWith(
      'recJOB',
      'recCREATECONTRACTOR',
    );

    const record = vi.mocked(syncJobToAirtable).mock.calls[0][0];
    expect(record.assignedContractorAirtableRecordId).toBe('recCREATECONTRACTOR');
    expect(record.assignedContractorAirtableRecordId).not.toBe(CONTRACTOR_BACKEND_UUID);
  });

  it('does not perform an assignment write when a new record has no usable assignment', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(makeJobRow({
      airtable_record_id: null,
      current_assignment_id: null,
      current_assignment_status: null,
      assigned_contractor_airtable_record_id: null,
    }) as any);

    await processSyncJob('job-uuid', 'corr-1');

    expect(updateAirtableAssignedContractor).not.toHaveBeenCalled();
    const record = vi.mocked(syncJobToAirtable).mock.calls[0][0];
    expect(record.assignedContractorAirtableRecordId).toBeUndefined();
  });

  it('surfaces an assignment 422 only after a successful core update', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(makeJobRow({}) as any)
      .mockResolvedValueOnce({
        airtable_record_id: 'recJOB',
        status: 'assigned',
        updated_at: new Date('2026-07-24T13:00:00.000Z'),
      } as any);
    vi.mocked(updateAirtableAssignedContractor).mockRejectedValueOnce(
      new Error('Airtable update error 422: UNKNOWN_FIELD_NAME'),
    );

    await expect(processSyncJob('job-uuid', 'corr-1')).rejects.toThrow('UNKNOWN_FIELD_NAME');

    expect(updateAirtableStatus).toHaveBeenCalled();
    expect(vi.mocked(updateAirtableStatus).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(updateAirtableAssignedContractor).mock.invocationCallOrder[0]);
    expect(logIntegrationFailure).toHaveBeenCalledWith(expect.objectContaining({
      operationName: 'sync_job',
      errorMessage: expect.stringContaining('UNKNOWN_FIELD_NAME'),
    }));
  });
});
