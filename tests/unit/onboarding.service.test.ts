/**
 * Unit tests for onboarding.service.ts
 *
 * Tests cover:
 *  - extractFileUrl: string, array, empty, null
 *  - isChecked: truthy/falsy values
 *  - computeChecklist: w9/photoId based on upload success, not URL presence
 *  - computeDocumentStatus: all-complete vs missing items
 *  - processOnboardingSubmission:
 *    - wrong formID → 400
 *    - missing contractorRecord → 422
 *    - missing backendContractor → 422
 *    - missing submissionID → 422
 *    - contractor not found → 404
 *    - airtable_record_id mismatch → 409
 *    - duplicate submission → 200 duplicate
 *    - W-9 URL present but upload fails → w9_received = false
 *    - Photo ID URL present but upload fails → photo_id_received = false, no Photo ID File Link written
 *    - Successful W-9 and Photo ID → both received = true
 *    - Photo ID File Link only written when upload succeeds
 *    - Activation/dispatch fields never in Airtable payload
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist mocks ───────────────────────────────────────────────────────────────
vi.mock('../../src/db/pool', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));
vi.mock('../../src/modules/storage/googleDrive.service', () => ({
  resolveContractorFolder: vi.fn(),
  downloadAndUploadFile: vi.fn(),
}));
vi.mock('../../src/modules/airtable-sync/airtable.contractor.adapter', () => ({
  getContractorAirtableField: vi.fn(),
  updateContractorAirtableFields: vi.fn(),
}));

import { query, queryOne } from '../../src/db/pool';
import {
  resolveContractorFolder,
  downloadAndUploadFile,
} from '../../src/modules/storage/googleDrive.service';
import {
  getContractorAirtableField,
  updateContractorAirtableFields,
} from '../../src/modules/airtable-sync/airtable.contractor.adapter';

import {
  extractFileUrl,
  isChecked,
  computeChecklist,
  computeDocumentStatus,
  processOnboardingSubmission,
  type OnboardingPayload,
} from '../../src/modules/onboarding/onboarding.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockQueryOne = queryOne as ReturnType<typeof vi.fn>;
const mockQuery = query as ReturnType<typeof vi.fn>;
const mockResolveFolder = resolveContractorFolder as ReturnType<typeof vi.fn>;
const mockDownloadAndUpload = downloadAndUploadFile as ReturnType<typeof vi.fn>;
const mockDownloadAndUploadFile = mockDownloadAndUpload;
const mockGetAirtableField = getContractorAirtableField as ReturnType<typeof vi.fn>;
const mockUpdateAirtable = updateContractorAirtableFields as ReturnType<typeof vi.fn>;

const CONTRACTOR_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const AIRTABLE_RECORD_ID = 'recABC123';
const SUBMISSION_ID = 'sub_001';

const BASE_PAYLOAD: OnboardingPayload = {
  formID: '261801729818060',
  submissionID: SUBMISSION_ID,
  q34_contractorRecord: AIRTABLE_RECORD_ID,
  q35_backendContractor: CONTRACTOR_ID,
  q43_typeA: 'Jane Doe',
  q20_q20_signature18: 'data:image/png;base64,abc',
  q19_q19_checkbox17: 'Yes',
  q25_q25_checkbox23: 'Yes',
  q36_iAgree: 'Yes',
  q14_q14_checkbox12: 'Yes',
  q39_contractorHandbook39: 'Yes',
};

const MOCK_CONTRACTOR = {
  id: CONTRACTOR_ID,
  full_name: 'Jane Doe',
  airtable_record_id: null,
};

const MOCK_FOLDER = {
  id: 'folder_drive_id',
  webViewLink: 'https://drive.google.com/drive/folders/folder_drive_id',
};

function setupHappyPath() {
  // No existing doc (no duplicate, no existing folder)
  mockQueryOne
    .mockResolvedValueOnce(MOCK_CONTRACTOR)  // contractor lookup
    .mockResolvedValueOnce(null)             // idempotency check
    .mockResolvedValueOnce(null);            // existing folder check
  mockGetAirtableField.mockResolvedValue(null);
  mockResolveFolder.mockResolvedValue(MOCK_FOLDER);
  mockQuery.mockResolvedValue({ rows: [] });
  mockUpdateAirtable.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── extractFileUrl ────────────────────────────────────────────────────────────

describe('extractFileUrl', () => {
  it('returns string value directly', () => {
    expect(extractFileUrl('https://example.com/file.pdf')).toBe('https://example.com/file.pdf');
  });
  it('returns first element of array', () => {
    expect(extractFileUrl(['https://a.com/1.pdf', 'https://b.com/2.pdf'])).toBe('https://a.com/1.pdf');
  });
  it('returns null for empty string', () => {
    expect(extractFileUrl('')).toBeNull();
  });
  it('returns null for empty array', () => {
    expect(extractFileUrl([])).toBeNull();
  });
  it('returns null for null', () => {
    expect(extractFileUrl(null)).toBeNull();
  });
  it('returns null for undefined', () => {
    expect(extractFileUrl(undefined)).toBeNull();
  });
  it('returns null for array with empty string', () => {
    expect(extractFileUrl([''])).toBeNull();
  });
});

// ── isChecked ─────────────────────────────────────────────────────────────────

describe('isChecked', () => {
  it('returns true for "Yes"', () => expect(isChecked('Yes')).toBe(true));
  it('returns true for non-empty string', () => expect(isChecked('Agreed')).toBe(true));
  it('returns false for empty string', () => expect(isChecked('')).toBe(false));
  it('returns false for null', () => expect(isChecked(null)).toBe(false));
  it('returns false for undefined', () => expect(isChecked(undefined)).toBe(false));
  it('returns false for "no"', () => expect(isChecked('no')).toBe(false));
  it('returns false for "false"', () => expect(isChecked('false')).toBe(false));
  it('returns false for "0"', () => expect(isChecked('0')).toBe(false));
  it('returns false for "N/A"', () => expect(isChecked('N/A')).toBe(false));
});

// ── computeChecklist ──────────────────────────────────────────────────────────

describe('computeChecklist', () => {
  it('w9_received is true only when w9Uploaded is true', () => {
    const payload = { ...BASE_PAYLOAD, q24_fileupload22: 'https://jotform.com/w9.pdf' };
    const c = computeChecklist(payload, false, false);
    expect(c.w9_received).toBe(false);
    const c2 = computeChecklist(payload, true, false);
    expect(c2.w9_received).toBe(true);
  });

  it('photo_id_received is true only when photoIdUploaded is true', () => {
    const payload = { ...BASE_PAYLOAD, q29_fileupload27: 'https://jotform.com/id.jpg' };
    const c = computeChecklist(payload, false, false);
    expect(c.photo_id_received).toBe(false);
    const c2 = computeChecklist(payload, false, true);
    expect(c2.photo_id_received).toBe(true);
  });

  it('signed_agreement_received requires both signature and checkbox', () => {
    const payloadBoth = { ...BASE_PAYLOAD };
    expect(computeChecklist(payloadBoth, false, false).signed_agreement_received).toBe(true);

    const payloadNoSig = { ...BASE_PAYLOAD, q20_q20_signature18: '' };
    expect(computeChecklist(payloadNoSig, false, false).signed_agreement_received).toBe(false);

    const payloadNoCheck = { ...BASE_PAYLOAD, q19_q19_checkbox17: '' };
    expect(computeChecklist(payloadNoCheck, false, false).signed_agreement_received).toBe(false);
  });
});

// ── computeDocumentStatus ─────────────────────────────────────────────────────

describe('computeDocumentStatus', () => {
  it('returns Submitted - Docs Complete when all 7 items are true', () => {
    const checklist = {
      signed_agreement_received: true,
      w9_received: true,
      photo_id_received: true,
      payment_setup_complete: true,
      sms_consent_confirmed: true,
      tools_transportation_confirmed: true,
      contractor_handbook_acknowledged: true,
    };
    expect(computeDocumentStatus(checklist)).toBe('Submitted - Docs Complete');
  });

  it('returns Submitted - Missing Items when any required item is false', () => {
    const checklist = {
      signed_agreement_received: true,
      w9_received: false,  // missing
      photo_id_received: true,
      payment_setup_complete: true,
      sms_consent_confirmed: true,
      tools_transportation_confirmed: true,
      contractor_handbook_acknowledged: true,
    };
    expect(computeDocumentStatus(checklist)).toBe('Submitted - Missing Items');
  });
});

// ── processOnboardingSubmission ───────────────────────────────────────────────

describe('processOnboardingSubmission', () => {
  it('throws 400 for wrong formID', async () => {
    const payload = { ...BASE_PAYLOAD, formID: '999999' };
    await expect(processOnboardingSubmission(payload)).rejects.toMatchObject({
      statusCode: 400,
      code: 'WRONG_FORM_ID',
    });
  });

  it('throws 422 when contractorRecord is missing', async () => {
    const payload = { ...BASE_PAYLOAD, q34_contractorRecord: '' };
    await expect(processOnboardingSubmission(payload)).rejects.toMatchObject({
      statusCode: 422,
      code: 'MISSING_CONTRACTOR_RECORD',
    });
  });

  it('throws 422 when backendContractor is missing', async () => {
    const payload = { ...BASE_PAYLOAD, q35_backendContractor: '' };
    await expect(processOnboardingSubmission(payload)).rejects.toMatchObject({
      statusCode: 422,
      code: 'MISSING_BACKEND_CONTRACTOR_ID',
    });
  });

  it('throws 422 when submissionID is missing', async () => {
    const payload = { ...BASE_PAYLOAD, submissionID: '' };
    await expect(processOnboardingSubmission(payload)).rejects.toMatchObject({
      statusCode: 422,
      code: 'MISSING_SUBMISSION_ID',
    });
  });

  it('throws 404 when contractor not found in DB', async () => {
    mockQueryOne.mockResolvedValueOnce(null); // contractor not found
    await expect(processOnboardingSubmission(BASE_PAYLOAD)).rejects.toMatchObject({
      statusCode: 404,
      code: 'CONTRACTOR_NOT_FOUND',
    });
  });

  it('throws 409 when airtable_record_id mismatches', async () => {
    mockQueryOne.mockResolvedValueOnce({
      ...MOCK_CONTRACTOR,
      airtable_record_id: 'recDIFFERENT',
    });
    await expect(processOnboardingSubmission(BASE_PAYLOAD)).rejects.toMatchObject({
      statusCode: 409,
      code: 'AIRTABLE_RECORD_ID_MISMATCH',
    });
  });

  it('returns duplicate status for already-processed submission', async () => {
    mockQueryOne
      .mockResolvedValueOnce(MOCK_CONTRACTOR)
      .mockResolvedValueOnce({ id: 'existing_doc_id', document_status: 'Submitted - Docs Complete' });

    const result = await processOnboardingSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('duplicate');
    expect(result.documentStatus).toBe('Submitted - Docs Complete');
    // Should not call Drive or Airtable
    expect(mockResolveFolder).not.toHaveBeenCalled();
    expect(mockUpdateAirtable).not.toHaveBeenCalled();
  });

  it('sets w9_received = false when W-9 upload fails', async () => {
    setupHappyPath();
    mockDownloadAndUploadFile.mockRejectedValueOnce(new Error('Drive upload failed'));

    const payload = { ...BASE_PAYLOAD, q24_fileupload22: 'https://jotform.com/w9.pdf' };
    const result = await processOnboardingSubmission(payload);

    expect(result.status).toBe('processed');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('W-9');

    // Verify Postgres INSERT was called with w9_received = false
    const insertCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO contractor_onboarding_documents'),
    );
    expect(insertCall).toBeDefined();
    const values = insertCall![1] as unknown[];
    // w9_received is at index 16 (0-based) in the VALUES list
    const w9ReceivedIdx = 16;
    expect(values[w9ReceivedIdx]).toBe(false);
  });

  it('sets photo_id_received = false and does not write Photo ID File Link when upload fails', async () => {
    setupHappyPath();
    mockDownloadAndUploadFile.mockRejectedValueOnce(new Error('Drive upload failed'));

    const payload = { ...BASE_PAYLOAD, q29_fileupload27: 'https://jotform.com/id.jpg' };
    const result = await processOnboardingSubmission(payload);

    expect(result.status).toBe('processed');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Photo ID');

    // Verify Airtable update does NOT include Photo ID File Link
    expect(mockUpdateAirtable).toHaveBeenCalledOnce();
    const airtableFields = mockUpdateAirtable.mock.calls[0][1] as Record<string, unknown>;
    expect(airtableFields['fldO46UgxkOuEpvay']).toBeUndefined();
    expect(airtableFields['fldqZOgILUTVbqzii']).toBe(false);
  });

  it('writes Photo ID File Link only when upload succeeds', async () => {
    setupHappyPath();
    mockDownloadAndUploadFile.mockResolvedValueOnce({
      id: 'photo_drive_id',
      webViewLink: 'https://drive.google.com/file/d/photo_drive_id/view',
    });

    const payload = { ...BASE_PAYLOAD, q29_fileupload27: 'https://jotform.com/id.jpg' };
    const result = await processOnboardingSubmission(payload);

    expect(result.status).toBe('processed');
    expect(result.processedFiles).toContain('Photo ID');

    const airtableFields = mockUpdateAirtable.mock.calls[0][1] as Record<string, unknown>;
    expect(airtableFields['fldO46UgxkOuEpvay']).toBe(
      'https://drive.google.com/file/d/photo_drive_id/view',
    );
    expect(airtableFields['fldqZOgILUTVbqzii']).toBe(true);
  });

  it('never includes activation or dispatch fields in Airtable update', async () => {
    setupHappyPath();
    const result = await processOnboardingSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('processed');

    const airtableFields = mockUpdateAirtable.mock.calls[0][1] as Record<string, unknown>;

    // These field IDs must never appear
    const forbidden = [
      'fldXXX_contractor_active',
      'fldXXX_contractor_status',
      'fldXXX_dispatch_eligible',
      'fldXXX_activation_requested',
    ];
    for (const fid of forbidden) {
      expect(airtableFields[fid]).toBeUndefined();
    }

    // Verify only the approved fields are present
    const allowedFields = new Set([
      'fld0Is7pUxLh2TZj3',  // Submitted At
      'fldQHTr0eSxmhGGOW',  // Submission ID
      'fldXR2KV5uq7DYbZ9',  // Drive Folder
      'fldQH4HCChb5i8HM9',  // Signed Agreement
      'fld06XS5VPue6uSj8',  // W-9 Received
      'fldZ1q3cYMvYwni8q',  // Payment Setup
      'fldd92BZZcGigAshI',  // SMS Consent
      'fldWjj2Ox2reuMG8I',  // Tools/Transportation
      'fld85axOvjHgJDmiS',  // Handbook
      'fldqZOgILUTVbqzii',  // Photo ID Received
      'fldO46UgxkOuEpvay',  // Photo ID File Link (only if upload succeeded)
      'fldauRRFrJoe7FrKQ',  // Document Status
    ]);
    for (const key of Object.keys(airtableFields)) {
      expect(allowedFields.has(key)).toBe(true);
    }
  });

  it('processes full happy path with W-9 and Photo ID', async () => {
    setupHappyPath();
    mockDownloadAndUploadFile
      .mockResolvedValueOnce({ id: 'w9_id', webViewLink: 'https://drive.google.com/w9' })
      .mockResolvedValueOnce({ id: 'photo_id', webViewLink: 'https://drive.google.com/photo' });

    const payload = {
      ...BASE_PAYLOAD,
      q24_fileupload22: 'https://jotform.com/w9.pdf',
      q29_fileupload27: 'https://jotform.com/id.jpg',
    };
    const result = await processOnboardingSubmission(payload);

    expect(result.status).toBe('processed');
    expect(result.processedFiles).toContain('W-9');
    expect(result.processedFiles).toContain('Photo ID');
    expect(result.errors).toHaveLength(0);

    const airtableFields = mockUpdateAirtable.mock.calls[0][1] as Record<string, unknown>;
    expect(airtableFields['fld06XS5VPue6uSj8']).toBe(true);   // W-9 Received
    expect(airtableFields['fldqZOgILUTVbqzii']).toBe(true);   // Photo ID Received
    expect(airtableFields['fldO46UgxkOuEpvay']).toBe('https://drive.google.com/photo');
    expect(airtableFields['fldauRRFrJoe7FrKQ']).toBe('Submitted - Docs Complete');
  });

  it('uses existing Postgres folder ID without creating a new folder', async () => {
    // Contractor found, no duplicate, existing folder in Postgres
    mockQueryOne
      .mockResolvedValueOnce(MOCK_CONTRACTOR)
      .mockResolvedValueOnce(null)  // no duplicate
      .mockResolvedValueOnce({
        drive_folder_id: 'existing_folder_id',
        drive_folder_url: 'https://drive.google.com/drive/folders/existing_folder_id',
      });
    mockGetAirtableField.mockResolvedValue(null);
    mockResolveFolder.mockResolvedValue({
      id: 'existing_folder_id',
      webViewLink: 'https://drive.google.com/drive/folders/existing_folder_id',
    });
    mockQuery.mockResolvedValue({ rows: [] });
    mockUpdateAirtable.mockResolvedValue(undefined);

    const result = await processOnboardingSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('processed');
    // resolveContractorFolder should be called with the existing folder ID
    expect(mockResolveFolder).toHaveBeenCalledWith(
      expect.objectContaining({ existingFolderId: 'existing_folder_id' }),
    );
  });
});
