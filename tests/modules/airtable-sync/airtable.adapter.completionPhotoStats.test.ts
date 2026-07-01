/**
 * Unit tests for updateAirtableStatus — completion photo stats fields (Phase 2B)
 *
 * Verifies that when completionPhotoStats is passed to updateAirtableStatus, the five
 * Airtable completion photo fields are written to the existing record via PATCH.
 * Also verifies that omitting completionPhotoStats leaves those fields untouched.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { updateAirtableStatus } from '../../../src/modules/airtable-sync/airtable.adapter';

// ── Mock config ───────────────────────────────────────────────────────────────
vi.mock('../../../src/common/config', () => ({
  config: {
    AIRTABLE_API_KEY: 'test-api-key',
    AIRTABLE_BASE_ID: 'appTESTBASEID',
    AIRTABLE_TABLE_JOBS: 'Jobs',
    NODE_ENV: 'test',
  },
}));

// ── Mock logger ───────────────────────────────────────────────────────────────
vi.mock('../../../src/common/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// ── Mock db/pool (not used by updateAirtableStatus directly) ─────────────────
vi.mock('../../../src/db/pool', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

// ── Capture fetch calls ───────────────────────────────────────────────────────
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function makeFetchOk() {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'recTEST123' }),
    text: async () => '',
  });
}

// Helper: call updateAirtableStatus with all positional params before completionPhotoStats
type CompletionPhotoStatsArg = {
  completionPhotoCount: number;
  completionPhotosUploaded: boolean;
  completionEvidenceLink?: string;
  completionPhotos?: Array<{ url: string; filename: string }>;
  completionReviewStatus?: string;
} | undefined;

async function callWithCompletionStats(completionPhotoStats: CompletionPhotoStatsArg) {
  return updateAirtableStatus(
    'recEXISTING1',
    'completion_reported',
    undefined, // totalAmountCents
    undefined, // stripePaymentIntentId
    undefined, // jobUpdatedAt
    undefined, // syncError
    undefined, // completionReportedAt
    undefined, // remainingBalanceCents
    undefined, // dispatchStatus
    undefined, // completedAt
    undefined, // contractorEnRouteAt
    undefined, // customerOtwTextSentAt
    undefined, // customerOtwTextStatus
    undefined, // photoStats
    completionPhotoStats,
  );
}

describe('updateAirtableStatus — completion photo stats fields (Phase 2B)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    makeFetchOk();
  });

  it('writes all five completion photo fields when completionPhotoStats is provided with photos', async () => {
    await callWithCompletionStats({
      completionPhotoCount: 2,
      completionPhotosUploaded: true,
      completionEvidenceLink: 'https://api.example.com/admin/jobs/job-uuid-1/completion-photos',
      completionPhotos: [
        { url: 'https://r2.example.com/presigned-url-1', filename: 'completion-photo.jpg' },
        { url: 'https://r2.example.com/presigned-url-2', filename: 'completion-photo-2.jpg' },
      ],
      completionReviewStatus: 'Completion Photos Received',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('recEXISTING1');
    expect(init.method).toBe('PATCH');

    const body = JSON.parse(init.body as string);
    expect(body.fields['Completion Photos Uploaded?']).toBe(true);
    expect(body.fields['Completion Photo Count']).toBe(2);
    expect(body.fields['Completion Evidence Link']).toBe(
      'https://api.example.com/admin/jobs/job-uuid-1/completion-photos',
    );
    expect(body.fields['Completion Photos']).toEqual([
      { url: 'https://r2.example.com/presigned-url-1', filename: 'completion-photo.jpg' },
      { url: 'https://r2.example.com/presigned-url-2', filename: 'completion-photo-2.jpg' },
    ]);
    expect(body.fields['Completion Review Status']).toBe('Completion Photos Received');
  });

  it('writes Completion Photos Uploaded? = false and Completion Photo Count = 0 when count is 0', async () => {
    await callWithCompletionStats({
      completionPhotoCount: 0,
      completionPhotosUploaded: false,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.fields['Completion Photos Uploaded?']).toBe(false);
    expect(body.fields['Completion Photo Count']).toBe(0);
    expect(body.fields['Completion Evidence Link']).toBeUndefined();
    expect(body.fields['Completion Photos']).toBeUndefined();
    expect(body.fields['Completion Review Status']).toBeUndefined();
  });

  it('does NOT write Completion Photos field when completionPhotos array is empty', async () => {
    await callWithCompletionStats({
      completionPhotoCount: 1,
      completionPhotosUploaded: true,
      completionPhotos: [],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.fields['Completion Photos']).toBeUndefined();
  });

  it('does NOT write completion photo fields when completionPhotoStats is omitted', async () => {
    await updateAirtableStatus('recEXISTING2', 'completion_reported');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.fields['Completion Photos Uploaded?']).toBeUndefined();
    expect(body.fields['Completion Photo Count']).toBeUndefined();
    expect(body.fields['Completion Evidence Link']).toBeUndefined();
    expect(body.fields['Completion Photos']).toBeUndefined();
    expect(body.fields['Completion Review Status']).toBeUndefined();
  });

  it('does NOT write completion photo fields when completionPhotoStats is undefined', async () => {
    await callWithCompletionStats(undefined);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.fields['Completion Photos Uploaded?']).toBeUndefined();
    expect(body.fields['Completion Photo Count']).toBeUndefined();
  });

  it('still writes status and mirror fields alongside completion photo stats', async () => {
    await callWithCompletionStats({
      completionPhotoCount: 1,
      completionPhotosUploaded: true,
      completionEvidenceLink: 'https://api.example.com/admin/jobs/job-uuid-2/completion-photos',
      completionReviewStatus: 'Completion Photos Received',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Status and mirror fields
    expect(body.fields['Status']).toBeDefined();
    expect(body.fields['Backend Job Status']).toBe('completion_reported');
    expect(body.fields['Last Backend Sync At']).toBeDefined();
    // Completion photo fields
    expect(body.fields['Completion Photos Uploaded?']).toBe(true);
    expect(body.fields['Completion Photo Count']).toBe(1);
    expect(body.fields['Completion Evidence Link']).toBe(
      'https://api.example.com/admin/jobs/job-uuid-2/completion-photos',
    );
    expect(body.fields['Completion Review Status']).toBe('Completion Photos Received');
  });

  it('does NOT write intake photo fields when only completionPhotoStats is provided', async () => {
    await callWithCompletionStats({
      completionPhotoCount: 1,
      completionPhotosUploaded: true,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Intake photo fields must NOT be written
    expect(body.fields['Photos Uploaded?']).toBeUndefined();
    expect(body.fields['Photo Count']).toBeUndefined();
    expect(body.fields['Last Photo Uploaded At']).toBeUndefined();
    expect(body.fields['Operator Photo Link']).toBeUndefined();
  });
});
