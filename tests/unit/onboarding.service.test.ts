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
  sanitizeFileName: vi.fn((fileName: string) => fileName),
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
  extractResponseFields,
  extractAdditionalResponseFields,
  type OnboardingPayload,
  type OnboardingResponseFields,
  type AdditionalResponseFields,
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
    expect(result.overallDocumentStatus).toBe('Submitted - Missing Items');
    expect(result.documents).toContainEqual(
      expect.objectContaining({
        documentType: 'w9',
        status: 'rejected',
        requirementSatisfied: false,
      }),
    );

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
      .mockResolvedValueOnce({
        id: 'w9_id',
        webViewLink: 'drive-w9-link',
        originalFileName: `W9_${AIRTABLE_RECORD_ID}.pdf`,
        detectedContentType: 'application/pdf',
        storedFileName: `W9_${AIRTABLE_RECORD_ID}.pdf`,
      })
      .mockResolvedValueOnce({
        id: 'photo_id',
        webViewLink: 'drive-photo-link',
        originalFileName: `PhotoID_${AIRTABLE_RECORD_ID}.jpg`,
        detectedContentType: 'image/jpeg',
        storedFileName: `PhotoID_${AIRTABLE_RECORD_ID}.jpg`,
      });

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
    expect(result.overallDocumentStatus).toBe('Submitted - Docs Complete');
    expect(result.documents).toEqual([
      expect.objectContaining({
        documentType: 'signed_agreement',
        status: 'accepted_legacy',
        requirementSatisfied: true,
      }),
      expect.objectContaining({
        documentType: 'w9',
        status: 'uploaded',
        detectedContentType: 'application/pdf',
        storedFileName: `W9_${AIRTABLE_RECORD_ID}.pdf`,
        driveFileId: 'w9_id',
      }),
      expect.objectContaining({
        documentType: 'photo_id',
        status: 'uploaded',
        detectedContentType: 'image/jpeg',
        storedFileName: `PhotoID_${AIRTABLE_RECORD_ID}.jpg`,
        driveFileId: 'photo_id',
      }),
      expect.objectContaining({ documentType: 'insurance', status: 'optional_not_supplied' }),
      expect.objectContaining({ documentType: 'other_document', status: 'optional_not_supplied' }),
    ]);

    const airtableFields = mockUpdateAirtable.mock.calls[0][1] as Record<string, unknown>;
    expect(airtableFields['fld06XS5VPue6uSj8']).toBe(true);   // W-9 Received
    expect(airtableFields['fldqZOgILUTVbqzii']).toBe(true);   // Photo ID Received
    expect(airtableFields['fldO46UgxkOuEpvay']).toBe('drive-photo-link');
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
    expect(content).toContain('Contractor Onboarding Submission');
    expect(content).toContain('Document Results');
    expect(content).toContain('Signed Agreement');
    expect(content).toContain('Status: accepted legacy');
    expect(content).toContain('W-9\nStatus: missing');
    expect(content).toContain('Overall Status: Submitted - Missing Items');
    expect(content).toContain('Processing Notes:\nNone');
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

  it('summary and audit payload exclude source URLs, credentials, signatures, and stack traces', async () => {
    setupHappyPath();
    const sourceCredential = 'source-token-value';
    const webhookCredential = 'webhook-token-value';
    const errorCredential = 'error-token-value';
    const sourceUrl = `https://www.jotform.com/uploads/w9.pdf?token=${sourceCredential}`;
    mockDownloadAndUploadFile.mockRejectedValueOnce(
      new Error(
        `Download failed token=${errorCredential} at ${sourceUrl}\n` +
          '    at internalDownloader (download.ts:10:2)',
      ),
    );
    await processOnboardingSubmission({
      ...BASE_PAYLOAD,
      q24_fileupload22: sourceUrl,
      webhookToken: webhookCredential,
      authorization: 'Bearer raw-authorization-value',
    });

    const uploadCall = mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer };
    const content = uploadCall.buffer.toString('utf-8');
    expect(content).toContain('Reason: Download failed token=[REDACTED] at [URL_REDACTED]');
    expect(content).not.toContain(sourceUrl);
    expect(content).not.toContain(sourceCredential);
    expect(content).not.toContain(webhookCredential);
    expect(content).not.toContain(errorCredential);
    expect(content).not.toContain('raw-authorization-value');
    expect(content).not.toContain('data:image/png;base64');
    expect(content).not.toContain('internalDownloader');
    expect(content).not.toContain('download.ts:10:2');

    const insertCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO contractor_onboarding_documents'),
    );
    const sanitizedPayload = String((insertCall![1] as unknown[])[4]);
    expect(sanitizedPayload).toContain('[FILE_SOURCE_REDACTED]');
    expect(sanitizedPayload).toContain('[SIGNATURE_REDACTED]');
    expect(sanitizedPayload).toContain('[CREDENTIAL_REDACTED]');
    expect(sanitizedPayload).not.toContain(sourceUrl);
    expect(sanitizedPayload).not.toContain(sourceCredential);
    expect(sanitizedPayload).not.toContain(webhookCredential);
    expect(sanitizedPayload).not.toContain('raw-authorization-value');
  });
});

// ── Onboarding Responses section ────────────────────────────────────────────────────────────────

describe('extractResponseFields', () => {
  // T-R1: all approved fields render with readable labels
  it('T-R1: all approved fields render with readable labels', async () => {
    setupHappyPath();
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q5_q5_textbox3: 'Alex',
      q6_q6_phone4: '+14045550000',
      q8_q8_email6: 'jane@example.com',
      q15_q15_checkbox13: 'Yes',
      q16_q16_checkbox14: 'Yes',
      q26_q26_dropdown24: 'Zelle',
      q32_q32_checkbox30: 'Yes',
    };
    await processOnboardingSubmission(payload);

    const uploadCall = mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer };
    const content = uploadCall.buffer.toString('utf-8');

    expect(content).toContain('Onboarding Responses');
    expect(content).toContain('Legal Name: Jane Doe');
    expect(content).toContain('Preferred Name: Alex');
    expect(content).toContain('Phone: +14045550000');
    expect(content).toContain('Email: jane@example.com');
    expect(content).toContain('Agreement Acknowledged: Yes');
    expect(content).toContain('SMS Consent Confirmed: Yes');
    expect(content).toContain('Transportation Confirmed: Yes');
    expect(content).toContain('Basic Tools Confirmed: Yes');
    expect(content).toContain('Job Readiness Confirmed: Yes');
    expect(content).toContain('Payment Setup Acknowledged: Yes');
    expect(content).toContain('Preferred Payout Method: Zelle');
    expect(content).toContain('Contractor Handbook Acknowledged: Yes');
    expect(content).toContain('Information Accuracy Certified: Yes');
  });

  // T-R2: each acknowledgment independently renders Yes or No
  it('T-R2: each acknowledgment independently renders Yes or No', () => {
    const allYes: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q19_q19_checkbox17: 'Yes',
      q36_iAgree: 'Yes',
      q14_q14_checkbox12: 'Yes',
      q15_q15_checkbox13: 'Yes',
      q16_q16_checkbox14: 'Yes',
      q25_q25_checkbox23: 'Yes',
      q39_contractorHandbook39: 'Yes',
      q32_q32_checkbox30: 'Yes',
    };
    const allNo: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q19_q19_checkbox17: '',
      q36_iAgree: '',
      q14_q14_checkbox12: '',
      q15_q15_checkbox13: '',
      q16_q16_checkbox14: '',
      q25_q25_checkbox23: '',
      q39_contractorHandbook39: '',
      q32_q32_checkbox30: '',
    };

    const yes = extractResponseFields(allYes, 'Jane Doe');
    expect(yes.agreementAcknowledged).toBe(true);
    expect(yes.smsConsentConfirmed).toBe(true);
    expect(yes.transportationConfirmed).toBe(true);
    expect(yes.basicToolsConfirmed).toBe(true);
    expect(yes.jobReadinessConfirmed).toBe(true);
    expect(yes.paymentSetupAcknowledged).toBe(true);
    expect(yes.handbookAcknowledged).toBe(true);
    expect(yes.informationAccuracyCertified).toBe(true);

    const no = extractResponseFields(allNo, 'Jane Doe');
    expect(no.agreementAcknowledged).toBe(false);
    expect(no.smsConsentConfirmed).toBe(false);
    expect(no.transportationConfirmed).toBe(false);
    expect(no.basicToolsConfirmed).toBe(false);
    expect(no.jobReadinessConfirmed).toBe(false);
    expect(no.paymentSetupAcknowledged).toBe(false);
    expect(no.handbookAcknowledged).toBe(false);
    expect(no.informationAccuracyCertified).toBe(false);
  });

  // T-R3: phone string input renders correctly
  it('T-R3: phone string input renders correctly', () => {
    const payload: OnboardingPayload = { ...BASE_PAYLOAD, q6_q6_phone4: '+14045550000' };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.phone).toBe('+14045550000');
  });

  // T-R4: phone object { full: ... } input renders correctly
  it('T-R4: phone object { full: ... } input renders correctly', () => {
    const payload: OnboardingPayload = { ...BASE_PAYLOAD, q6_q6_phone4: { full: '+14045550000' } };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.phone).toBe('+14045550000');
  });

  // T-R5: blank preferred name is omitted
  it('T-R5: blank preferred name is omitted', async () => {
    setupHappyPath();
    const payload: OnboardingPayload = { ...BASE_PAYLOAD, q5_q5_textbox3: '' };
    await processOnboardingSubmission(payload);

    const uploadCall = mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer };
    const content = uploadCall.buffer.toString('utf-8');
    expect(content).not.toContain('Preferred Name');
  });

  // T-R6: blank payout method is omitted
  it('T-R6: blank payout method is omitted', async () => {
    setupHappyPath();
    const payload: OnboardingPayload = { ...BASE_PAYLOAD, q26_q26_dropdown24: '' };
    await processOnboardingSubmission(payload);

    const uploadCall = mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer };
    const content = uploadCall.buffer.toString('utf-8');
    expect(content).not.toContain('Preferred Payout Method');
  });

  // T-R7: legacy signature value absent from summary
  it('T-R7: legacy signature value is absent from summary', async () => {
    setupHappyPath();
    // BASE_PAYLOAD already has q20_q20_signature18: 'data:image/png;base64,abc'
    await processOnboardingSubmission(BASE_PAYLOAD);

    const uploadCall = mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer };
    const content = uploadCall.buffer.toString('utf-8');
    expect(content).not.toContain('data:image/png');
    expect(content).not.toContain('base64');
  });

  // T-R8: upload source URLs absent from entire generated Drive summary
  it('T-R8: upload source URLs are absent from the entire generated Drive summary', async () => {
    setupHappyPath();
    const sourceUrl = 'https://www.jotform.com/uploads/w9.pdf';
    const payload: OnboardingPayload = { ...BASE_PAYLOAD, q24_fileupload22: sourceUrl };
    // Upload succeeds so the URL is consumed but must not appear in the summary
    mockDownloadAndUploadFile.mockResolvedValueOnce({
      id: 'w9_id',
      webViewLink: 'https://drive.google.com/file/d/w9_id/view',
    });
    await processOnboardingSubmission(payload);

    const uploadCall = mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer };
    const content = uploadCall.buffer.toString('utf-8');
    // The Jotform source URL must not appear anywhere in the summary
    expect(content).not.toContain(sourceUrl);
    expect(content).not.toContain('jotform.com/uploads');
  });

  // T-R9: token-like values absent from response section
  it('T-R9: token-like values are absent from response section', async () => {
    setupHappyPath();
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      webhookToken: 'secret-token-value',
      authorization: 'Bearer raw-auth-value',
    };
    await processOnboardingSubmission(payload);

    const uploadCall = mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer };
    const content = uploadCall.buffer.toString('utf-8');
    expect(content).not.toContain('secret-token-value');
    expect(content).not.toContain('raw-auth-value');
  });

  // T-R10: existing document-results formatting preserved
  it('T-R10: existing document-results formatting is preserved', async () => {
    setupHappyPath();
    await processOnboardingSubmission(BASE_PAYLOAD);

    const uploadCall = mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer };
    const content = uploadCall.buffer.toString('utf-8');
    expect(content).toContain('Document Results');
    expect(content).toContain('Signed Agreement');
    expect(content).toContain('Status: accepted legacy');
    expect(content).toContain('Overall Status:');
    expect(content).toContain('Processing Notes:');
  });

  // T-R11: Airtable update does not include any new field IDs
  it('T-R11: Airtable update does not include any new field IDs', async () => {
    setupHappyPath();
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q5_q5_textbox3: 'Alex',
      q6_q6_phone4: '+14045550000',
      q8_q8_email6: 'jane@example.com',
      q26_q26_dropdown24: 'Zelle',
      q32_q32_checkbox30: 'Yes',
    };
    await processOnboardingSubmission(payload);

    const airtableFields = mockUpdateAirtable.mock.calls[0][1] as Record<string, unknown>;
    const usedFieldIds = Object.keys(airtableFields);
    const allowedFieldIds = new Set([
      'fld0Is7pUxLh2TZj3', // AT.SUBMITTED_AT
      'fldQHTr0eSxmhGGOW', // AT.SUBMISSION_ID
      'fldXR2KV5uq7DYbZ9', // AT.DRIVE_FOLDER
      'fldQH4HCChb5i8HM9', // AT.SIGNED_AGREEMENT
      'fld06XS5VPue6uSj8', // AT.W9_RECEIVED
      'fldZ1q3cYMvYwni8q', // AT.PAYMENT_SETUP
      'fldd92BZZcGigAshI', // AT.SMS_CONSENT
      'fldWjj2Ox2reuMG8I', // AT.TOOLS_TRANSPORTATION
      'fld85axOvjHgJDmiS', // AT.HANDBOOK
      'fldqZOgILUTVbqzii', // AT.PHOTO_ID_RECEIVED
      'fldO46UgxkOuEpvay', // AT.PHOTO_ID_FILE_LINK (only when photo upload succeeds)
      'fldauRRFrJoe7FrKQ', // AT.DOCUMENT_STATUS
    ]);
    for (const id of usedFieldIds) {
      expect(allowedFieldIds).toContain(id);
    }
  });
});

// ── normalizeSingleLine / extractResponseFields edge cases ─────────────────────────────────

describe('extractResponseFields — normalization edge cases', () => {
  // T-N1: blank submitted legal name falls back to contractor name
  it('T-N1: blank submitted legal name falls back to contractor name', () => {
    const payload: OnboardingPayload = { ...BASE_PAYLOAD, q43_typeA: '' };
    const fields = extractResponseFields(payload, 'Contractor Full Name');
    expect(fields.legalName).toBe('Contractor Full Name');
  });

  // T-N2: whitespace-only submitted legal name falls back to contractor name
  it('T-N2: whitespace-only submitted legal name falls back to contractor name', () => {
    const payload: OnboardingPayload = { ...BASE_PAYLOAD, q43_typeA: '   ' };
    const fields = extractResponseFields(payload, 'Contractor Full Name');
    expect(fields.legalName).toBe('Contractor Full Name');
  });

  // T-N3: embedded newline in preferred name is collapsed to one line
  it('T-N3: embedded newline in preferred name is collapsed to one line', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q5_q5_textbox3: `Alex\nFake Label: injected`,
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.preferredName).toBe('Alex Fake Label: injected');
    expect(fields.preferredName).not.toContain('\n');
  });

  // T-N4: embedded newline in payout method is collapsed to one line
  it('T-N4: embedded newline in payout method is collapsed to one line', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q26_q26_dropdown24: `Zelle\nFake Label: injected`,
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.preferredPayoutMethod).toBe('Zelle Fake Label: injected');
    expect(fields.preferredPayoutMethod).not.toContain('\n');
  });

  // T-N5: embedded newline in phone string cannot inject a separate label
  it('T-N5: embedded newline in phone string cannot inject a separate label', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q6_q6_phone4: `+14045550000\nFake Label: injected`,
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.phone).toBe('+14045550000 Fake Label: injected');
    expect(fields.phone).not.toContain('\n');
  });

  // T-N6: embedded newline in email cannot inject a separate label
  it('T-N6: embedded newline in email cannot inject a separate label', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q8_q8_email6: `jane@example.com\nFake Label: injected`,
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.email).toBe('jane@example.com Fake Label: injected');
    expect(fields.email).not.toContain('\n');
  });

  // T-N7: Unicode line separator (U+2028) and paragraph separator (U+2029) are collapsed
  it('T-N7: Unicode LS and PS are collapsed to a single space', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q5_q5_textbox3: `Alex\u2028Injected\u2029End`,
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.preferredName).toBe('Alex Injected End');
    expect(fields.preferredName).not.toContain('\u2028');
    expect(fields.preferredName).not.toContain('\u2029');
  });

  // T-N8: phone string behavior unchanged after refactor
  it('T-N8: phone string behavior is unchanged after refactor', () => {
    const payload: OnboardingPayload = { ...BASE_PAYLOAD, q6_q6_phone4: '+14045550000' };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.phone).toBe('+14045550000');
  });

  // T-N9: phone object { full } behavior unchanged after refactor
  it('T-N9: phone object { full } behavior is unchanged after refactor', () => {
    const payload: OnboardingPayload = { ...BASE_PAYLOAD, q6_q6_phone4: { full: '+14045550000' } };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.phone).toBe('+14045550000');
  });
});

// ── extractAdditionalResponseFields ─────────────────────────────────────────

describe('extractAdditionalResponseFields', () => {
  // T-A1: all six fields populated
  it('T-A1: all six additional fields are extracted when populated', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q11_q11_textarea9:  'No longer accepting move-outs',
      q12_q12_textarea10: 'Dunwoody and Brookhaven only',
      q17_q17_textarea15: 'No power tools',
      q23_q23_radio21:    'I am uploading my completed W-9 now',
      q27_q27_textarea25: 'Will set up ACH this week',
      q40_questionsOr:    'Do I need a contractor badge?',
    };
    const fields = extractAdditionalResponseFields(payload);
    expect(fields.servicesNoLongerAccepted).toBe('No longer accepting move-outs');
    expect(fields.serviceAreaChanges).toBe('Dunwoody and Brookhaven only');
    expect(fields.toolTransportationUpdates).toBe('No power tools');
    expect(fields.w9UploadIntent).toBe('I am uploading my completed W-9 now');
    expect(fields.paymentSetupNotes).toBe('Will set up ACH this week');
    expect(fields.questionsOrComments).toBe('Do I need a contractor badge?');
  });

  // T-A2: all six fields absent when payload has no values
  it('T-A2: all six additional fields are undefined when payload fields are absent', () => {
    const fields = extractAdditionalResponseFields(BASE_PAYLOAD);
    expect(fields.servicesNoLongerAccepted).toBeUndefined();
    expect(fields.serviceAreaChanges).toBeUndefined();
    expect(fields.toolTransportationUpdates).toBeUndefined();
    expect(fields.w9UploadIntent).toBeUndefined();
    expect(fields.paymentSetupNotes).toBeUndefined();
    expect(fields.questionsOrComments).toBeUndefined();
  });

  // T-A3: blank string fields return undefined (not empty string)
  it('T-A3: blank string fields return undefined', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q11_q11_textarea9:  '',
      q12_q12_textarea10: '   ',
      q17_q17_textarea15: '',
      q23_q23_radio21:    '',
      q27_q27_textarea25: '   ',
      q40_questionsOr:    '',
    };
    const fields = extractAdditionalResponseFields(payload);
    expect(fields.servicesNoLongerAccepted).toBeUndefined();
    expect(fields.serviceAreaChanges).toBeUndefined();
    expect(fields.toolTransportationUpdates).toBeUndefined();
    expect(fields.w9UploadIntent).toBeUndefined();
    expect(fields.paymentSetupNotes).toBeUndefined();
    expect(fields.questionsOrComments).toBeUndefined();
  });

  // T-A4: legitimate multiline paragraph content is preserved across lines
  it('T-A4: legitimate multiline paragraph content is preserved', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q40_questionsOr: 'First paragraph.\n\nSecond paragraph.',
    };
    const fields = extractAdditionalResponseFields(payload);
    // Both paragraphs must be present with a blank line between them
    expect(fields.questionsOrComments).toBe('First paragraph.\n\nSecond paragraph.');
  });

  // T-A4b: CRLF line endings are normalised to LF
  it('T-A4b: CRLF line endings are normalised to LF', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q12_q12_textarea10: 'Line one\r\nLine two\r\nLine three',
    };
    const fields = extractAdditionalResponseFields(payload);
    expect(fields.serviceAreaChanges).toBe('Line one\nLine two\nLine three');
    expect(fields.serviceAreaChanges).not.toContain('\r');
  });

  // T-A4c: CR-only and Unicode line separators are normalised to LF
  it('T-A4c: CR-only and Unicode line separators are normalised to LF', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q11_q11_textarea9:  'A\rB',
      q17_q17_textarea15: 'C\u2028D\u2029E',
    };
    const fields = extractAdditionalResponseFields(payload);
    expect(fields.servicesNoLongerAccepted).toBe('A\nB');
    expect(fields.toolTransportationUpdates).toBe('C\nD\nE');
  });

  // T-A4d: excessive blank lines are collapsed to at most one blank line
  it('T-A4d: runs of more than two blank lines are collapsed to a single blank line', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q40_questionsOr: 'Para one.\n\n\n\n\nPara two.',
    };
    const fields = extractAdditionalResponseFields(payload);
    expect(fields.questionsOrComments).toBe('Para one.\n\nPara two.');
  });

  // T-A5: fake section-header injection via newline is neutralised
  it('T-A5: newline injection of a known section heading is neutralised with a zero-width space', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q40_questionsOr: 'Legit content\nDocument Results\nFake Status: hacked',
    };
    const fields = extractAdditionalResponseFields(payload);
    // The injected heading line must be prefixed with U+200B so it does not match
    // the real section heading when the summary is parsed line-by-line.
    expect(fields.questionsOrComments).toContain('\u200BDocument Results');
    // The raw unmodified heading must not appear as a standalone line
    expect(fields.questionsOrComments).not.toMatch(/^Document Results$/m);
  });

  // T-A6: meaningful values such as "None" and "No changes" are preserved
  it('T-A6: meaningful values such as None and No changes are preserved', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q11_q11_textarea9:  'None',
      q12_q12_textarea10: 'No changes',
    };
    const fields = extractAdditionalResponseFields(payload);
    expect(fields.servicesNoLongerAccepted).toBe('None');
    expect(fields.serviceAreaChanges).toBe('No changes');
  });
});

// ── extractResponseFields — new fields (dispatch phone, approved services, signed date) ─────

describe('extractResponseFields — new fields', () => {
  // T-RF1: dispatch phone string is extracted
  it('T-RF1: dispatch phone string is extracted correctly', () => {
    const payload: OnboardingPayload = { ...BASE_PAYLOAD, q7_q7_phone5: '(404) 555-0001' };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.dispatchPhone).toBe('(404) 555-0001');
  });

  // T-RF2: dispatch phone object { full } is extracted
  it('T-RF2: dispatch phone object { full } is extracted correctly', () => {
    const payload: OnboardingPayload = { ...BASE_PAYLOAD, q7_q7_phone5: { full: '(404) 555-0002' } };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.dispatchPhone).toBe('(404) 555-0002');
  });

  // T-RF3: dispatch phone absent returns undefined
  it('T-RF3: absent dispatch phone returns undefined', () => {
    const fields = extractResponseFields(BASE_PAYLOAD, 'Jane Doe');
    expect(fields.dispatchPhone).toBeUndefined();
  });

  // T-RF4: dispatch phone null-like object { full: undefined } returns undefined
  it('T-RF4: dispatch phone object with undefined full returns undefined', () => {
    const payload: OnboardingPayload = { ...BASE_PAYLOAD, q7_q7_phone5: { full: undefined } };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.dispatchPhone).toBeUndefined();
  });

  // T-RF5: dispatch phone array does not throw and returns undefined
  it('T-RF5: dispatch phone array value does not throw and returns undefined', () => {
    const payload: OnboardingPayload = { ...BASE_PAYLOAD, q7_q7_phone5: ['(404) 555-0003'] as unknown as string };
    expect(() => extractResponseFields(payload, 'Jane Doe')).not.toThrow();
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.dispatchPhone).toBeUndefined();
  });

  // T-RF6: approved services confirmed true when checkbox has value
  it('T-RF6: approvedServicesConfirmed is true when checkbox has a value', () => {
    const payload: OnboardingPayload = { ...BASE_PAYLOAD, q10_q10_checkbox8: 'I confirm' };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.approvedServicesConfirmed).toBe(true);
  });

  // T-RF7: approved services confirmed false when checkbox is absent
  it('T-RF7: approvedServicesConfirmed is false when checkbox is absent', () => {
    const fields = extractResponseFields(BASE_PAYLOAD, 'Jane Doe');
    expect(fields.approvedServicesConfirmed).toBe(false);
  });

  // T-RF8: agreement signed date parsed from {day,month,year} object
  it('T-RF8: agreementSignedDate is parsed from {day,month,year} object', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q21_q21_datetime19: { day: '30', month: '06', year: '2026' },
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.agreementSignedDate).toBe('2026-06-30');
  });

  // T-RF9: agreement signed date parsed from ISO string
  it('T-RF9: agreementSignedDate is parsed from an ISO date string', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q21_q21_datetime19: '2026-06-30',
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.agreementSignedDate).toBe('2026-06-30');
  });

  // T-RF10: invalid date string returns undefined
  it('T-RF10: invalid date string returns undefined for agreementSignedDate', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q21_q21_datetime19: 'not-a-date',
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.agreementSignedDate).toBeUndefined();
  });

  // T-RF11: partial date object (missing year) returns undefined
  it('T-RF11: partial date object missing year returns undefined', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q21_q21_datetime19: { day: '30', month: '06' },
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.agreementSignedDate).toBeUndefined();
  });

  // T-RF12: absent date field returns undefined
  it('T-RF12: absent date field returns undefined', () => {
    const fields = extractResponseFields(BASE_PAYLOAD, 'Jane Doe');
    expect(fields.agreementSignedDate).toBeUndefined();
  });

  // T-RF13: February 31 is rejected
  it('T-RF13: February 31 is rejected as a calendar-invalid date', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q21_q21_datetime19: { day: '31', month: '02', year: '2026' },
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.agreementSignedDate).toBeUndefined();
  });

  // T-RF14: February 30 is rejected
  it('T-RF14: February 30 is rejected as a calendar-invalid date', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q21_q21_datetime19: { day: '30', month: '02', year: '2026' },
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.agreementSignedDate).toBeUndefined();
  });

  // T-RF15: April 31 is rejected
  it('T-RF15: April 31 is rejected as a calendar-invalid date', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q21_q21_datetime19: { day: '31', month: '04', year: '2026' },
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.agreementSignedDate).toBeUndefined();
  });

  // T-RF16: month 13 is rejected
  it('T-RF16: month 13 is rejected as a calendar-invalid date', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q21_q21_datetime19: { day: '01', month: '13', year: '2026' },
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.agreementSignedDate).toBeUndefined();
  });

  // T-RF17: day 00 is rejected
  it('T-RF17: day 00 is rejected as a calendar-invalid date', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q21_q21_datetime19: { day: '00', month: '06', year: '2026' },
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.agreementSignedDate).toBeUndefined();
  });

  // T-RF18: valid leap day (Feb 29 in a leap year) is accepted
  it('T-RF18: Feb 29 in a leap year is accepted', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q21_q21_datetime19: { day: '29', month: '02', year: '2024' },
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.agreementSignedDate).toBe('2024-02-29');
  });

  // T-RF19: Feb 29 in a non-leap year is rejected
  it('T-RF19: Feb 29 in a non-leap year is rejected', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q21_q21_datetime19: { day: '29', month: '02', year: '2026' },
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.agreementSignedDate).toBeUndefined();
  });

  // T-RF20: century year that is not a leap year (1900) rejects Feb 29
  it('T-RF20: Feb 29 in century non-leap year 1900 is rejected', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q21_q21_datetime19: { day: '29', month: '02', year: '1900' },
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.agreementSignedDate).toBeUndefined();
  });

  // T-RF21: century year divisible by 400 (2000) accepts Feb 29
  it('T-RF21: Feb 29 in year 2000 (divisible by 400) is accepted', () => {
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q21_q21_datetime19: { day: '29', month: '02', year: '2000' },
    };
    const fields = extractResponseFields(payload, 'Jane Doe');
    expect(fields.agreementSignedDate).toBe('2000-02-29');
  });
});

// ── Additional Onboarding Responses section in Drive summary ─────────────────

describe('processOnboardingSubmission — Additional Onboarding Responses in Drive summary', () => {
  // T-AS1: Additional Onboarding Responses section appears when fields are populated
  it('T-AS1: Additional Onboarding Responses section appears when fields are populated', async () => {
    setupHappyPath();
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q11_q11_textarea9:  'No longer accepting move-outs',
      q12_q12_textarea10: 'Dunwoody and Brookhaven only',
      q17_q17_textarea15: 'No power tools',
      q23_q23_radio21:    'I am uploading my completed W-9 now',
      q27_q27_textarea25: 'Will set up ACH this week',
      q40_questionsOr:    'Do I need a contractor badge?',
    };
    await processOnboardingSubmission(payload);

    const content = (mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer }).buffer.toString('utf-8');
    expect(content).toContain('Additional Onboarding Responses');
    expect(content).toContain('Services No Longer Accepted: No longer accepting move-outs');
    expect(content).toContain('Service Area or Availability Changes: Dunwoody and Brookhaven only');
    expect(content).toContain('Tool, Transportation, or Readiness Updates: No power tools');
    expect(content).toContain('W-9 Upload Intent: I am uploading my completed W-9 now');
    expect(content).toContain('Payment Setup Notes: Will set up ACH this week');
    expect(content).toContain('Questions or Comments: Do I need a contractor badge?');
  });

  // T-AS2: Additional Onboarding Responses section is absent when all fields are blank
  it('T-AS2: Additional Onboarding Responses section is absent when all additional fields are blank', async () => {
    setupHappyPath();
    await processOnboardingSubmission(BASE_PAYLOAD);

    const content = (mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer }).buffer.toString('utf-8');
    expect(content).not.toContain('Additional Onboarding Responses');
  });

  // T-AS3: section appears after Onboarding Responses and before Document Results
  it('T-AS3: Additional Onboarding Responses section appears after Onboarding Responses and before Document Results', async () => {
    setupHappyPath();
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q40_questionsOr: 'Any questions here',
    };
    await processOnboardingSubmission(payload);

    const content = (mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer }).buffer.toString('utf-8');
    const idxOnboarding  = content.indexOf('Onboarding Responses');
    const idxAdditional  = content.indexOf('Additional Onboarding Responses');
    const idxDocResults  = content.indexOf('Document Results');
    expect(idxAdditional).toBeGreaterThan(idxOnboarding);
    expect(idxDocResults).toBeGreaterThan(idxAdditional);
  });

  // T-AS4: meaningful values such as "None" are preserved in the summary
  it('T-AS4: meaningful values such as None are preserved in the summary', async () => {
    setupHappyPath();
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q11_q11_textarea9:  'None',
      q12_q12_textarea10: 'No changes',
    };
    await processOnboardingSubmission(payload);

    const content = (mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer }).buffer.toString('utf-8');
    expect(content).toContain('Services No Longer Accepted: None');
    expect(content).toContain('Service Area or Availability Changes: No changes');
  });

  // T-AS5: multiline textarea value is preserved with continuation lines indented
  it('T-AS5: multiline textarea value is preserved with continuation lines indented in the summary', async () => {
    setupHappyPath();
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q40_questionsOr: 'First line\nSecond line',
    };
    await processOnboardingSubmission(payload);
    const content = (mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer }).buffer.toString('utf-8');
    // First content line must appear with the label
    expect(content).toContain('Questions or Comments: First line');
    // Continuation line must be indented with two spaces
    expect(content).toContain('\n  Second line');
    // The value must not appear collapsed onto one line
    expect(content).not.toContain('Questions or Comments: First line Second line');
  });
  // T-AS6: newline injection cannot create a fake section heading or standalone label
  it('T-AS6: newline injection in textarea cannot create a fake section header in the summary', async () => {
    setupHappyPath();
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q40_questionsOr: 'Legit question\nDocument Results\nFake Status: hacked',
    };
    await processOnboardingSubmission(payload);
    const content = (mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer }).buffer.toString('utf-8');
    // Document Results must appear exactly once (the real section, not injected);
    // the injected line is indented so it does not match the bare heading anchor.
    const occurrences = (content.match(/^Document Results$/gm) ?? []).length;
    expect(occurrences).toBe(1);
    // The injected fake status must not appear as a standalone (unindented) line
    expect(content).not.toMatch(/^Fake Status: hacked$/m);
    // It must appear as an indented continuation line instead
    expect(content).toContain('  Fake Status: hacked');
  });

  // T-AS7: dispatch phone appears in Onboarding Responses section of summary
  it('T-AS7: dispatch phone appears in Onboarding Responses section of summary', async () => {
    setupHappyPath();
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q7_q7_phone5: '(404) 555-9999',
    };
    await processOnboardingSubmission(payload);

    const content = (mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer }).buffer.toString('utf-8');
    expect(content).toContain('Best Phone for Dispatch: (404) 555-9999');
  });

  // T-AS8: absent dispatch phone is omitted from summary
  it('T-AS8: absent dispatch phone is omitted from summary', async () => {
    setupHappyPath();
    await processOnboardingSubmission(BASE_PAYLOAD);

    const content = (mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer }).buffer.toString('utf-8');
    expect(content).not.toContain('Best Phone for Dispatch');
  });

  // T-AS9: approved services confirmed appears in Onboarding Responses section
  it('T-AS9: Approved Services Confirmed appears in Onboarding Responses section', async () => {
    setupHappyPath();
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q10_q10_checkbox8: 'I confirm',
    };
    await processOnboardingSubmission(payload);

    const content = (mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer }).buffer.toString('utf-8');
    expect(content).toContain('Approved Services Confirmed: Yes');
  });

  // T-AS10: agreement signed date appears in Onboarding Responses section
  it('T-AS10: Agreement Signed Date appears in Onboarding Responses section', async () => {
    setupHappyPath();
    const payload: OnboardingPayload = {
      ...BASE_PAYLOAD,
      q21_q21_datetime19: { day: '30', month: '06', year: '2026' },
    };
    await processOnboardingSubmission(payload);

    const content = (mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer }).buffer.toString('utf-8');
    expect(content).toContain('Agreement Signed Date: 2026-06-30');
  });

  // T-AS11: absent agreement signed date is omitted from summary
  it('T-AS11: absent agreement signed date is omitted from summary', async () => {
    setupHappyPath();
    await processOnboardingSubmission(BASE_PAYLOAD);

    const content = (mockUploadBufferToFolder.mock.calls[0][0] as { buffer: Buffer }).buffer.toString('utf-8');
    expect(content).not.toContain('Agreement Signed Date');
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
    expect(result.documents).toContainEqual(
      expect.objectContaining({
        documentType: 'w9',
        status: 'previously_retained',
        requirementSatisfied: true,
      }),
    );

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
    expect(result.overallDocumentStatus).toBe('Submitted - Docs Complete');
    expect(result.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentType: 'signed_agreement',
          status: 'previously_retained',
          requirementSatisfied: true,
        }),
        expect.objectContaining({
          documentType: 'w9',
          status: 'previously_retained',
          requirementSatisfied: true,
        }),
        expect.objectContaining({
          documentType: 'photo_id',
          status: 'previously_retained',
          requirementSatisfied: true,
        }),
      ]),
    );

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
