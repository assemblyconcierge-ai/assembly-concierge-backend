import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/common/config', () => ({
  config: {
    AIRTABLE_API_KEY: 'test-airtable-key',
    AIRTABLE_BASE_ID: 'app-test',
    AIRTABLE_TABLE_CONTRACTORS: 'tbl-contractors',
  },
}));
vi.mock('../../src/common/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getContractorMissingDocumentsStatuses,
  MISSING_DOCUMENTS_ALLOWED_FIELD_IDS,
  updateContractorMissingDocumentsFields,
} from '../../src/modules/airtable-sync/airtable.contractor.adapter';

const ONBOARDING_DOCUMENT_STATUS = 'fldauRRFrJoe7FrKQ';
const MISSING_DOCS_REVIEW_STATUS = 'fldhp1o95RqRv3Oy0';

describe('missing-documents Airtable adapter', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs exactly the two approved status fields and maps omitted values to null', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ records: [{ id: 'recABC123', fields: {} }] }),
    });

    const statuses = await getContractorMissingDocumentsStatuses('recABC123');
    expect(statuses).toEqual({
      onboardingDocumentStatus: null,
      missingDocsReviewStatus: null,
    });

    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    const url = new URL(String(requestUrl));
    expect(requestInit).toMatchObject({ method: 'GET' });
    expect(url.searchParams.getAll('fields[]')).toEqual([
      ONBOARDING_DOCUMENT_STATUS,
      MISSING_DOCS_REVIEW_STATUS,
    ]);
    expect(url.searchParams.get('maxRecords')).toBe('1');
    expect(url.searchParams.get('returnFieldsByFieldId')).toBe('true');
    expect(url.searchParams.get('filterByFormula')).toBe('RECORD_ID()="recABC123"');
  });

  it('returns both current status values by field ID', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        records: [{
          id: 'recABC123',
          fields: {
            [ONBOARDING_DOCUMENT_STATUS]: 'Approved for Activation Request',
            [MISSING_DOCS_REVIEW_STATUS]: 'Reviewed - Accepted',
          },
        }],
      }),
    });
    await expect(getContractorMissingDocumentsStatuses('recABC123')).resolves.toEqual({
      onboardingDocumentStatus: 'Approved for Activation Request',
      missingDocsReviewStatus: 'Reviewed - Accepted',
    });
  });

  it('allows Awaiting Review for the new field in the fail-closed write path', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    await updateContractorMissingDocumentsFields('recABC123', {
      [MISSING_DOCS_REVIEW_STATUS]: 'Awaiting Review',
    });
    expect(MISSING_DOCUMENTS_ALLOWED_FIELD_IDS.has(MISSING_DOCS_REVIEW_STATUS)).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      fields: { [MISSING_DOCS_REVIEW_STATUS]: 'Awaiting Review' },
    });
  });

  it('does not allow the three unused Missing Docs fields', async () => {
    for (const fieldId of ['fldkFViCRSeSNr4IH', 'fldkCvSCInutLztbZ', 'fldS3TKRHv92bm6oD']) {
      expect(MISSING_DOCUMENTS_ALLOWED_FIELD_IDS.has(fieldId)).toBe(false);
      await expect(updateContractorMissingDocumentsFields('recABC123', {
        [fieldId]: 'not allowed',
      })).rejects.toThrow('disallowed fields');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
