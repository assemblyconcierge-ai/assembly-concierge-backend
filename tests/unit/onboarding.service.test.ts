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
  uploadBufferToFolder: vi.fn(),
}));
vi.mock('../../src/modules/airtable-sync/airtable.contractor.adapter', () => ({
  getContractorAirtableField: vi.fn(),
  updateContractorAirtableFields: vi.fn(),
}));
vi.mock('../../src/modules/email/email_events.repository', () => ({
  clearContractorMissingDocsEvent: vi.fn(),
}));

import { query, queryOne } from '../../src/db/pool';
import {
  resolveContractorFolder,
  downloadAndUploadFile,
  uploadBufferToFolder,
} from '../../src/modules/storage/googleDrive.service';
import {
  getContractorAirtableField,
  updateContractorAirtableFields,
} from '../../src/modules/airtable-sync/airtable.contractor.adapter';
import { clearContractorMissingDocsEvent } from '../../src/modules/email/email_events.repository';

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
const mockUploadBufferToFolder = uploadBufferToFolder as ReturnType<typeof vi.fn>;
const mockGetAirtableField = getContractorAirtableField as ReturnType<typeof vi.fn>;
const mockUpdateAirtable = updateContractorAirtableFields as ReturnType<typeof vi.fn>;
const mockClearMissingDocsEvent = clearContractorMissingDocsEvent as ReturnType<typeof vi.fn>;

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
    .mockResolvedValueOnce(null)             // existing folder check
    .mockResolvedValueOnce(null);            // BOOL_OR prior checklist (null = first submission)
  mockGetAirtableField.mockResolvedValue(null);
  mockResolveFolder.mockResolvedValue(MOCK_FOLDER);
  mockQuery.mockResolvedValue({ rows: [] });
  mockUpdateAirtable.mockResolvedValue(undefined);
  mockUploadBufferToFolder.mockResolvedValue({
    id: 'summary_file_id',
    webViewLink: 'https://drive.google.com/file/d/summary_file_id/view',
  });
  mockClearMissingDocsEvent.mockResolvedValue(undefined);
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

  it('signed_agreement_received: legacy path — both signature and checkbox required', () => {
    // Both present → true
    const payloadBoth = { ...BASE_PAYLOAD };
    expect(computeChecklist(payloadBoth, false, false).signed_agreement_received).toBe(true);

    // Signature absent → false
    const payloadNoSig = { ...BASE_PAYLOAD, q20_q20_signature18: '' };
    expect(computeChecklist(payloadNoSig, false, false).signed_agreement_received).toBe(false);

    // Checkbox absent → false
    const payloadNoCheck = { ...BASE_PAYLOAD, q19_q19_checkbox17: '' };
    expect(computeChecklist(payloadNoCheck, false, false).signed_agreement_received).toBe(false);
  });

  it('signed_agreement_received: uploadSigned49 only → true when signedAgreementUploaded=true', () => {
    // No legacy signature fields, but uploadSigned49 file upload succeeded
    const payloadUploadOnly = {
      ...BASE_PAYLOAD,
      q20_q20_signature18: '',   // legacy absent
      q19_q19_checkbox17: '',    // legacy absent
      uploadSigned49: 'https://jotform.com/signed_agreement.pdf',
    };
    // signedAgreementUploaded=false → still false (URL alone does not count)
    expect(computeChecklist(payloadUploadOnly, false, false, false).signed_agreement_received).toBe(false);
    // signedAgreementUploaded=true → true (upload succeeded)
    expect(computeChecklist(payloadUploadOnly, false, false, true).signed_agreement_received).toBe(true);
  });

  it('signed_agreement_received: legacy only (no uploadSigned49) → true when legacy fields present', () => {
    const payloadLegacyOnly = {
      ...BASE_PAYLOAD,
      uploadSigned49: undefined,  // new field absent
    };
    // signedAgreementUploaded defaults to false; legacy fields are present
    expect(computeChecklist(payloadLegacyOnly, false, false).signed_agreement_received).toBe(true);
  });

  it('signed_agreement_received: neither legacy nor uploadSigned49 → false', () => {
    const payloadNeither = {
      ...BASE_PAYLOAD,
      q20_q20_signature18: '',
      q19_q19_checkbox17: '',
      uploadSigned49: undefined,
    };
    expect(computeChecklist(payloadNeither, false, false, false).signed_agreement_received).toBe(false);
  });

  it('W-9, Photo ID, Insurance, Other Document mappings unaffected by uploadSigned49 changes', () => {
    const payload = {
      ...BASE_PAYLOAD,
      uploadSigned49: 'https://jotform.com/signed.pdf',
    };
    const c = computeChecklist(payload, true, true, true);
    expect(c.w9_received).toBe(true);
    expect(c.photo_id_received).toBe(true);
    expect(c.payment_setup_complete).toBe(true);
    expect(c.sms_consent_confirmed).toBe(true);
    expect(c.tools_transportation_confirmed).toBe(true);
    expect(c.contractor_handbook_acknowledged).toBe(true);
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

  it('preserves all five contractor document download paths', async () => {
    setupHappyPath();
    mockDownloadAndUploadFile
      .mockResolvedValueOnce({ id: 'signed_id', webViewLink: 'https://drive.google.com/signed' })
      .mockResolvedValueOnce({ id: 'w9_id', webViewLink: 'https://drive.google.com/w9' })
      .mockResolvedValueOnce({ id: 'photo_id', webViewLink: 'https://drive.google.com/photo' })
      .mockResolvedValueOnce({ id: 'insurance_id', webViewLink: 'https://drive.google.com/insurance' })
      .mockResolvedValueOnce({ id: 'other_id', webViewLink: 'https://drive.google.com/other' });

    const payload = {
      ...BASE_PAYLOAD,
      uploadSigned49: 'https://www.jotform.com/uploads/signed.pdf',
      q24_fileupload22: 'https://www.jotform.com/uploads/w9.pdf',
      q29_fileupload27: 'https://www.jotform.com/uploads/id.jpg',
      q30_fileupload28: 'https://www.jotform.com/uploads/insurance.pdf',
      q31_fileupload29: 'https://www.jotform.com/uploads/other.pdf',
    };

    const result = await processOnboardingSubmission(payload);

    expect(mockDownloadAndUploadFile).toHaveBeenCalledTimes(5);
    expect(mockDownloadAndUploadFile.mock.calls.map(([opts]) => opts.sourceUrl)).toEqual([
      payload.uploadSigned49,
      payload.q24_fileupload22,
      payload.q29_fileupload27,
      payload.q30_fileupload28,
      payload.q31_fileupload29,
    ]);
    expect(result.processedFiles).toEqual(expect.arrayContaining([
      'Signed Agreement',
      'W-9',
      'Photo ID',
      'Proof of Insurance',
      'Other Document',
    ]));
    expect(result.errors).toHaveLength(0);
  });

  it('uses existing Postgres folder ID without creating a new folder', async () => {
    // Contractor found, no duplicate, existing folder in Postgres
    mockQueryOne
      .mockResolvedValueOnce(MOCK_CONTRACTOR)
      .mockResolvedValueOnce(null)  // no duplicate
      .mockResolvedValueOnce({
        drive_folder_id: 'existing_folder_id',
        drive_folder_url: 'https://drive.google.com/drive/folders/existing_folder_id',
      })
      .mockResolvedValueOnce(null);  // BOOL_OR prior checklist
    mockGetAirtableField.mockResolvedValue(null);
    mockResolveFolder.mockResolvedValue({
      id: 'existing_folder_id',
      webViewLink: 'https://drive.google.com/drive/folders/existing_folder_id',
    });
    mockQuery.mockResolvedValue({ rows: [] });
    mockUpdateAirtable.mockResolvedValue(undefined);
    mockUploadBufferToFolder.mockResolvedValue({
      id: 'summary_file_id',
      webViewLink: 'https://drive.google.com/file/d/summary_file_id/view',
    });
    mockClearMissingDocsEvent.mockResolvedValue(undefined);

    const result = await processOnboardingSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('processed');
    // resolveContractorFolder should be called with the existing folder ID
    expect(mockResolveFolder).toHaveBeenCalledWith(
      expect.objectContaining({ existingFolderId: 'existing_folder_id' }),
    );
  });

  // ── Submission summary upload (Change 2) ────────────────────────────────

  it('uploads a submission summary text file to Drive on successful processing', async () => {
    setupHappyPath();
    const result = await processOnboardingSubmission(BASE_PAYLOAD);

    expect(result.status).toBe('processed');
    expect(result.processedFiles).toContain('Submission Summary');
    expect(mockUploadBufferToFolder).toHaveBeenCalledOnce();

    const uploadCall = mockUploadBufferToFolder.mock.calls[0][0] as {
      buffer: Buffer;
      mimeType: string;
      fileName: string;
      folderId: string;
    };
    expect(uploadCall.mimeType).toBe('text/plain');
    expect(uploadCall.folderId).toBe(MOCK_FOLDER.id);
    // Filename must include the contractor name, 'Onboarding Submission', and submissionId
    expect(uploadCall.fileName).toContain('Onboarding Submission');
    expect(uploadCall.fileName).toContain(SUBMISSION_ID);
    // Buffer must be non-empty and contain the submissionId
    const content = uploadCall.buffer.toString('utf-8');
    expect(content).toContain(SUBMISSION_ID);
    expect(content).toContain(AIRTABLE_RECORD_ID);
  });

  it('continues processing when submission summary upload fails (non-fatal)', async () => {
    setupHappyPath();
    mockUploadBufferToFolder.mockRejectedValueOnce(new Error('Drive quota exceeded'));

    const result = await processOnboardingSubmission(BASE_PAYLOAD);

    expect(result.status).toBe('processed');
    // Error is recorded but does not abort processing
    expect(result.errors.some((e) => e.includes('Submission Summary'))).toBe(true);
    // Submission Summary should NOT be in processedFiles since it failed
    expect(result.processedFiles).not.toContain('Submission Summary');
    // Airtable update should still have been called (processing completed)
    expect(mockUpdateAirtable).toHaveBeenCalledOnce();
  });

  it('summary filename includes submissionId for idempotency', async () => {
    setupHappyPath();
    await processOnboardingSubmission(BASE_PAYLOAD);

    const uploadCall = mockUploadBufferToFolder.mock.calls[0][0] as { fileName: string };
    // submissionId embedded in filename prevents duplicate files being
    // indistinguishable on reprocessing
    expect(uploadCall.fileName).toContain(SUBMISSION_ID);
  });

  it('summary content redacts signature field', async () => {
    setupHappyPath();
    await processOnboardingSubmission(BASE_PAYLOAD);

    const uploadCall = mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer };
    const content = uploadCall.buffer.toString('utf-8');
    // Signature value should be redacted, not the raw base64 data
    expect(content).toContain('[SIGNATURE_REDACTED]');
    expect(content).not.toContain('data:image/png;base64');
  });
});

// ── Fix 1: BOOL_OR cumulative checklist ──────────────────────────────────────

describe('processOnboardingSubmission — cumulative receipt booleans (BOOL_OR)', () => {
  // Helper: sets up the 4-call queryOne sequence with a custom priorChecklist
  function setupWithPrior(priorChecklist: Record<string, boolean | null> | null) {
    mockQueryOne
      .mockResolvedValueOnce(MOCK_CONTRACTOR)  // contractor lookup
      .mockResolvedValueOnce(null)             // idempotency check
      .mockResolvedValueOnce(null)             // existing folder check
      .mockResolvedValueOnce(priorChecklist);  // BOOL_OR aggregate
    mockGetAirtableField.mockResolvedValue(null);
    mockResolveFolder.mockResolvedValue(MOCK_FOLDER);
    mockQuery.mockResolvedValue({ rows: [] });
    mockUpdateAirtable.mockResolvedValue(undefined);
    mockUploadBufferToFolder.mockResolvedValue({
      id: 'summary_file_id',
      webViewLink: 'https://drive.google.com/file/d/summary_file_id/view',
    });
    mockClearMissingDocsEvent.mockResolvedValue(undefined);
  }

  it('T1: prior w9_received=true is preserved when W-9 absent from resubmission', async () => {
    setupWithPrior({
      signed_agreement_received: false,
      w9_received: true,
      photo_id_received: false,
      payment_setup_complete: false,
      sms_consent_confirmed: false,
      tools_transportation_confirmed: false,
      contractor_handbook_acknowledged: false,
    });
    // Payload has no W-9 URL — upload will not run
    const result = await processOnboardingSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('processed');

    // Airtable PATCH must have w9_received = true (preserved from prior)
    const airtableFields = mockUpdateAirtable.mock.calls[0][1] as Record<string, unknown>;
    expect(airtableFields['fld06XS5VPue6uSj8']).toBe(true);  // AT.W9_RECEIVED

    // Postgres INSERT values: w9_received is at index 16 (0-based)
    const insertCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO contractor_onboarding_documents'),
    );
    expect(insertCall).toBeDefined();
    const values = insertCall![1] as unknown[];
    expect(values[16]).toBe(true);  // w9_received
  });

  it('T2: prior photo_id_received=true is preserved when Photo ID absent from resubmission', async () => {
    setupWithPrior({
      signed_agreement_received: false,
      w9_received: false,
      photo_id_received: true,
      payment_setup_complete: false,
      sms_consent_confirmed: false,
      tools_transportation_confirmed: false,
      contractor_handbook_acknowledged: false,
    });
    const result = await processOnboardingSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('processed');

    const airtableFields = mockUpdateAirtable.mock.calls[0][1] as Record<string, unknown>;
    expect(airtableFields['fldqZOgILUTVbqzii']).toBe(true);  // AT.PHOTO_ID_RECEIVED

    const insertCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO contractor_onboarding_documents'),
    );
    const values = insertCall![1] as unknown[];
    expect(values[17]).toBe(true);  // photo_id_received
  });

  it('T3: all seven cumulative fields written to Postgres and Airtable when all true from prior rows', async () => {
    setupWithPrior({
      signed_agreement_received: true,
      w9_received: true,
      photo_id_received: true,
      payment_setup_complete: true,
      sms_consent_confirmed: true,
      tools_transportation_confirmed: true,
      contractor_handbook_acknowledged: true,
    });
    // Payload with no files and no checkboxes — everything comes from prior
    const emptyPayload: OnboardingPayload = {
      formID: '261801729818060',
      submissionID: SUBMISSION_ID,
      q34_contractorRecord: AIRTABLE_RECORD_ID,
      q35_backendContractor: CONTRACTOR_ID,
    };
    const result = await processOnboardingSubmission(emptyPayload);
    expect(result.status).toBe('processed');

    const airtableFields = mockUpdateAirtable.mock.calls[0][1] as Record<string, unknown>;
    expect(airtableFields['fldQH4HCChb5i8HM9']).toBe(true);  // AT.SIGNED_AGREEMENT
    expect(airtableFields['fld06XS5VPue6uSj8']).toBe(true);  // AT.W9_RECEIVED
    expect(airtableFields['fldqZOgILUTVbqzii']).toBe(true);  // AT.PHOTO_ID_RECEIVED
    expect(airtableFields['fldZ1q3cYMvYwni8q']).toBe(true);  // AT.PAYMENT_SETUP
    expect(airtableFields['fldd92BZZcGigAshI']).toBe(true);  // AT.SMS_CONSENT
    expect(airtableFields['fldWjj2Ox2reuMG8I']).toBe(true);  // AT.TOOLS_TRANSPORTATION
    expect(airtableFields['fld85axOvjHgJDmiS']).toBe(true);  // AT.HANDBOOK
    expect(airtableFields['fldauRRFrJoe7FrKQ']).toBe('Submitted - Docs Complete');

    const insertCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO contractor_onboarding_documents'),
    );
    const values = insertCall![1] as unknown[];
    expect(values[15]).toBe(true);  // signed_agreement_received
    expect(values[16]).toBe(true);  // w9_received
    expect(values[17]).toBe(true);  // photo_id_received
    expect(values[18]).toBe(true);  // payment_setup_complete
    expect(values[19]).toBe(true);  // sms_consent_confirmed
    expect(values[20]).toBe(true);  // tools_transportation_confirmed
    expect(values[21]).toBe(true);  // contractor_handbook_acknowledged
  });

  it('T4: current submission true takes precedence over prior false', async () => {
    setupWithPrior({
      signed_agreement_received: false,
      w9_received: false,
      photo_id_received: false,
      payment_setup_complete: false,
      sms_consent_confirmed: false,
      tools_transportation_confirmed: false,
      contractor_handbook_acknowledged: false,
    });
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

    const airtableFields = mockUpdateAirtable.mock.calls[0][1] as Record<string, unknown>;
    expect(airtableFields['fld06XS5VPue6uSj8']).toBe(true);  // W-9 from current upload
    expect(airtableFields['fldqZOgILUTVbqzii']).toBe(true);  // Photo ID from current upload
  });

  it('T5: first submission (no prior rows, priorChecklist=null) behaves identically to prior behavior', async () => {
    setupWithPrior(null);  // same as setupHappyPath
    const result = await processOnboardingSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('processed');

    const airtableFields = mockUpdateAirtable.mock.calls[0][1] as Record<string, unknown>;
    // BASE_PAYLOAD has legacy signature + all checkboxes → all non-file fields true
    expect(airtableFields['fldQH4HCChb5i8HM9']).toBe(true);  // signed_agreement_received
    expect(airtableFields['fld06XS5VPue6uSj8']).toBe(false); // w9_received (no file)
    expect(airtableFields['fldqZOgILUTVbqzii']).toBe(false); // photo_id_received (no file)
    expect(airtableFields['fldZ1q3cYMvYwni8q']).toBe(true);  // payment_setup_complete
    expect(airtableFields['fldd92BZZcGigAshI']).toBe(true);  // sms_consent_confirmed
    expect(airtableFields['fldWjj2Ox2reuMG8I']).toBe(true);  // tools_transportation_confirmed
    expect(airtableFields['fld85axOvjHgJDmiS']).toBe(true);  // contractor_handbook_acknowledged
  });

  it('T6: duplicate submission returns early without running BOOL_OR or DELETE', async () => {
    // Only 2 queryOne calls: contractor lookup + idempotency check (hit)
    mockQueryOne
      .mockResolvedValueOnce(MOCK_CONTRACTOR)
      .mockResolvedValueOnce({ id: 'existing_doc_id', document_status: 'Submitted - Docs Complete' });

    const result = await processOnboardingSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('duplicate');
    // BOOL_OR call (4th queryOne) must not have been made
    expect(mockQueryOne).toHaveBeenCalledTimes(2);
    expect(mockClearMissingDocsEvent).not.toHaveBeenCalled();
  });

  it('T7: Drive upload failure does not prevent BOOL_OR from preserving prior true values', async () => {
    setupWithPrior({
      signed_agreement_received: false,
      w9_received: true,
      photo_id_received: false,
      payment_setup_complete: false,
      sms_consent_confirmed: false,
      tools_transportation_confirmed: false,
      contractor_handbook_acknowledged: false,
    });
    // W-9 URL present but upload fails
    mockDownloadAndUploadFile.mockRejectedValueOnce(new Error('Drive upload failed'));
    const payload = { ...BASE_PAYLOAD, q24_fileupload22: 'https://jotform.com/w9.pdf' };

    const result = await processOnboardingSubmission(payload);
    expect(result.status).toBe('processed');
    expect(result.errors.some((e) => e.includes('W-9'))).toBe(true);

    // BOOL_OR preserved w9_received=true from prior despite upload failure
    const airtableFields = mockUpdateAirtable.mock.calls[0][1] as Record<string, unknown>;
    expect(airtableFields['fld06XS5VPue6uSj8']).toBe(true);
  });
});

// ── Fix 2: Conditional email-lock DELETE ─────────────────────────────────────

describe('processOnboardingSubmission — conditional missing-docs email lock DELETE', () => {
  it('T8: DELETE runs after a successful Airtable PATCH', async () => {
    setupHappyPath();
    await processOnboardingSubmission(BASE_PAYLOAD);

    expect(mockClearMissingDocsEvent).toHaveBeenCalledOnce();
    expect(mockClearMissingDocsEvent).toHaveBeenCalledWith(CONTRACTOR_ID);
  });

  it('T9: DELETE does not run when Airtable PATCH fails', async () => {
    setupHappyPath();
    mockUpdateAirtable.mockRejectedValueOnce(new Error('Airtable API error'));

    const result = await processOnboardingSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('processed');
    expect(result.errors.some((e) => e.includes('Airtable sync failed'))).toBe(true);
    expect(mockClearMissingDocsEvent).not.toHaveBeenCalled();
  });

  it('T10: DELETE does not run on duplicate submission', async () => {
    mockQueryOne
      .mockResolvedValueOnce(MOCK_CONTRACTOR)
      .mockResolvedValueOnce({ id: 'existing_doc_id', document_status: 'Submitted - Docs Complete' });

    const result = await processOnboardingSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('duplicate');
    expect(mockClearMissingDocsEvent).not.toHaveBeenCalled();
  });

  it('T11: DELETE runs when Drive upload fails but Airtable PATCH succeeds', async () => {
    setupHappyPath();
    mockDownloadAndUploadFile.mockRejectedValueOnce(new Error('Drive upload failed'));
    const payload = { ...BASE_PAYLOAD, q24_fileupload22: 'https://jotform.com/w9.pdf' };

    const result = await processOnboardingSubmission(payload);
    expect(result.status).toBe('processed');
    expect(result.errors.some((e) => e.includes('W-9'))).toBe(true);
    // Airtable succeeded → DELETE must run
    expect(mockClearMissingDocsEvent).toHaveBeenCalledOnce();
    expect(mockClearMissingDocsEvent).toHaveBeenCalledWith(CONTRACTOR_ID);
  });

  it('T12: DELETE failure is non-fatal — function still returns processed', async () => {
    setupHappyPath();
    mockClearMissingDocsEvent.mockRejectedValueOnce(new Error('DB connection lost'));

    const result = await processOnboardingSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('processed');
    // Airtable was still called
    expect(mockUpdateAirtable).toHaveBeenCalledOnce();
    // No error surfaced to caller from the DELETE failure
    expect(result.errors.every((e) => !e.includes('email'))).toBe(true);
  });

  it('T13: DELETE does not run when both Drive upload and Airtable PATCH fail', async () => {
    setupHappyPath();
    mockDownloadAndUploadFile.mockRejectedValueOnce(new Error('Drive upload failed'));
    mockUpdateAirtable.mockRejectedValueOnce(new Error('Airtable API error'));
    const payload = { ...BASE_PAYLOAD, q24_fileupload22: 'https://jotform.com/w9.pdf' };

    const result = await processOnboardingSubmission(payload);
    expect(result.status).toBe('processed');
    expect(result.errors.some((e) => e.includes('W-9'))).toBe(true);
    expect(result.errors.some((e) => e.includes('Airtable sync failed'))).toBe(true);
    expect(mockClearMissingDocsEvent).not.toHaveBeenCalled();
  });

  it('T14: DELETE is called with the correct contractorId from the payload', async () => {
    const CUSTOM_ID = 'bbbbbbbb-1111-1111-1111-000000000002';
    mockQueryOne
      .mockResolvedValueOnce({ id: CUSTOM_ID, full_name: 'Bob Smith', airtable_record_id: null })
      .mockResolvedValueOnce(null)   // idempotency
      .mockResolvedValueOnce(null)   // folder check
      .mockResolvedValueOnce(null);  // BOOL_OR
    mockGetAirtableField.mockResolvedValue(null);
    mockResolveFolder.mockResolvedValue(MOCK_FOLDER);
    mockQuery.mockResolvedValue({ rows: [] });
    mockUpdateAirtable.mockResolvedValue(undefined);
    mockUploadBufferToFolder.mockResolvedValue({
      id: 'summary_file_id',
      webViewLink: 'https://drive.google.com/file/d/summary_file_id/view',
    });
    mockClearMissingDocsEvent.mockResolvedValue(undefined);

    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q35_backendContractor: CUSTOM_ID,
    };
    await processOnboardingSubmission(payload);

    expect(mockClearMissingDocsEvent).toHaveBeenCalledWith(CUSTOM_ID);
  });
});
