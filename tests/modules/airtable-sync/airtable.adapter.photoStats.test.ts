/**
 * Unit tests for updateAirtableStatus — photo stats fields (Phase 1.5-C fix)
 *
 * Verifies that when photoStats is passed to updateAirtableStatus, the four
 * Airtable photo fields are written to the existing record via PATCH.
 * Also verifies that omitting photoStats leaves those fields untouched.
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

describe('updateAirtableStatus — photo stats fields', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    makeFetchOk();
  });

  it('writes all four photo fields when photoStats is provided', async () => {
    await updateAirtableStatus(
      'recEXISTING1',
      'awaiting_payment',
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
      {
        photoCount: 3,
        photosUploaded: true,
        lastPhotoUploadedAt: '2025-06-01T10:00:00.000Z',
        operatorPhotoLink: 'https://api.example.com/public/photos/review/opt_abc123',
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('recEXISTING1');
    expect(init.method).toBe('PATCH');

    const body = JSON.parse(init.body as string);
    expect(body.fields['Photos Uploaded?']).toBe(true);
    expect(body.fields['Photo Count']).toBe(3);
    expect(body.fields['Last Photo Uploaded At']).toBe('2025-06-01T10:00:00.000Z');
    expect(body.fields['Operator Photo Link']).toBe('https://api.example.com/public/photos/review/opt_abc123');
  });

  it('writes Photos Uploaded? = false and Photo Count = 0 when photoCount is 0', async () => {
    await updateAirtableStatus(
      'recEXISTING2',
      'awaiting_payment',
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      {
        photoCount: 0,
        photosUploaded: false,
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.fields['Photos Uploaded?']).toBe(false);
    expect(body.fields['Photo Count']).toBe(0);
    expect(body.fields['Last Photo Uploaded At']).toBeUndefined();
    expect(body.fields['Operator Photo Link']).toBeUndefined();
  });

  it('does NOT write photo fields when photoStats is omitted', async () => {
    await updateAirtableStatus(
      'recEXISTING3',
      'awaiting_payment',
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.fields['Photos Uploaded?']).toBeUndefined();
    expect(body.fields['Photo Count']).toBeUndefined();
    expect(body.fields['Last Photo Uploaded At']).toBeUndefined();
    expect(body.fields['Operator Photo Link']).toBeUndefined();
  });

  it('does NOT write photo fields when photoStats is undefined', async () => {
    await updateAirtableStatus(
      'recEXISTING4',
      'paid_in_full',
      10000,
      'pi_test123',
      new Date(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // photoStats explicitly undefined
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.fields['Photos Uploaded?']).toBeUndefined();
    expect(body.fields['Photo Count']).toBeUndefined();
  });

  it('still writes status and mirror fields alongside photo stats', async () => {
    await updateAirtableStatus(
      'recEXISTING5',
      'deposit_paid',
      5000,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      {
        photoCount: 2,
        photosUploaded: true,
        lastPhotoUploadedAt: '2025-06-02T09:00:00.000Z',
        operatorPhotoLink: 'https://api.example.com/public/photos/review/opt_xyz789',
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Status fields
    expect(body.fields['Status']).toBe('paid');
    expect(body.fields['Backend Job Status']).toBe('deposit_paid');
    expect(body.fields['Last Backend Sync At']).toBeDefined();
    expect(body.fields['Total Amount']).toBe(50); // 5000 cents → $50
    // Photo fields
    expect(body.fields['Photos Uploaded?']).toBe(true);
    expect(body.fields['Photo Count']).toBe(2);
    expect(body.fields['Last Photo Uploaded At']).toBe('2025-06-02T09:00:00.000Z');
    expect(body.fields['Operator Photo Link']).toBe('https://api.example.com/public/photos/review/opt_xyz789');
  });
});
