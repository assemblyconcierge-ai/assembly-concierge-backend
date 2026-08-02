import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  downloadAndUploadFile: vi.fn(),
  resolveContractorFolder: vi.fn(),
  sanitizeFileName: vi.fn((value: string) => value),
  getContractorAirtableField: vi.fn(),
  getStatuses: vi.fn(),
  updateAirtable: vi.fn(),
  sendNotification: vi.fn(),
  reserve: vi.fn(),
  getSubmission: vi.fn(),
  claimFiles: vi.fn(),
  findFolder: vi.fn(),
  markFilesProcessed: vi.fn(),
  markFilesFailed: vi.fn(),
  markAirtableSynced: vi.fn(),
  markAirtableFailed: vi.fn(),
  claimNotification: vi.fn(),
  markNotificationComplete: vi.fn(),
  markNotificationFailed: vi.fn(),
}));

vi.mock('../../src/db/pool', () => ({ queryOne: mocks.queryOne }));
vi.mock('../../src/modules/storage/googleDrive.service', () => ({
  downloadAndUploadFile: mocks.downloadAndUploadFile,
  resolveContractorFolder: mocks.resolveContractorFolder,
  sanitizeFileName: mocks.sanitizeFileName,
}));
vi.mock('../../src/modules/airtable-sync/airtable.contractor.adapter', () => ({
  getContractorAirtableField: mocks.getContractorAirtableField,
  getContractorMissingDocumentsStatuses: mocks.getStatuses,
  updateContractorMissingDocumentsFields: mocks.updateAirtable,
}));
vi.mock('../../src/modules/email/email.service', () => ({
  sendMissingDocumentsOperatorNotification: mocks.sendNotification,
}));
vi.mock('../../src/modules/onboarding/missingDocuments.repository', () => ({
  reserveMissingDocumentsSubmission: mocks.reserve,
  getMissingDocumentsSubmission: mocks.getSubmission,
  claimMissingDocumentsFileProcessing: mocks.claimFiles,
  findContractorOnboardingFolder: mocks.findFolder,
  markMissingDocumentsFilesProcessed: mocks.markFilesProcessed,
  markMissingDocumentsFilesFailed: mocks.markFilesFailed,
  markMissingDocumentsAirtableSynced: mocks.markAirtableSynced,
  markMissingDocumentsAirtableFailed: mocks.markAirtableFailed,
  claimMissingDocumentsNotification: mocks.claimNotification,
  markMissingDocumentsNotificationComplete: mocks.markNotificationComplete,
  markMissingDocumentsNotificationFailed: mocks.markNotificationFailed,
}));
vi.mock('../../src/common/config', () => ({
  config: {
    JOTFORM_MISSING_DOCS_FORM_ID: 'missing-form-1',
    JOTFORM_API_KEY: 'test-jotform-key',
  },
}));

import {
  processMissingDocumentsSubmission,
  type MissingDocumentsPayload,
} from '../../src/modules/onboarding/missingDocuments.service';

const CONTRACTOR_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const AIRTABLE_ID = 'recABC123';
const SUBMISSION_ID = 'sub-100';

let row: any;

function freshRow(submissionId = SUBMISSION_ID) {
  return {
    id: `row-${submissionId}`,
    contractor_id: CONTRACTOR_ID,
    airtable_record_id: AIRTABLE_ID,
    jotform_submission_id: submissionId,
    jotform_form_id: 'missing-form-1',
    submitted_at: '2026-08-01T12:00:00.000Z',
    contractor_message: 'Corrected documents attached',
    drive_folder_id: null,
    drive_folder_url: null,
    document_results: {},
    processing_status: 'pending',
    files_processed_at: null,
    processing_error: null,
    airtable_attempt_count: 0,
    airtable_synced_at: null,
    airtable_error: null,
    notification_status: 'pending',
    notification_attempt_count: 0,
    notification_sent_at: null,
    notification_provider_message_id: null,
    notification_error: null,
  };
}

const BASE_PAYLOAD: MissingDocumentsPayload = {
  formID: 'missing-form-1',
  submissionID: SUBMISSION_ID,
  contractorRecord: AIRTABLE_ID,
  backendContractor: CONTRACTOR_ID,
  submissionDate: '2026-08-01T12:00:00Z',
  contractorMessage: 'Corrected documents attached',
  w9: 'https://www.jotform.com/uploads/account/form/sub/w9.pdf',
};

function configureStatefulRepository() {
  mocks.reserve.mockImplementation(async (params: any) => {
    const isNew = !row;
    if (!row) row = freshRow(params.submissionId);
    return { row, isNew };
  });
  mocks.getSubmission.mockImplementation(async () => row);
  mocks.claimFiles.mockImplementation(async () => {
    row = { ...row, processing_status: 'processing_files' };
    return row;
  });
  mocks.markFilesProcessed.mockImplementation(async (params: any) => {
    row = {
      ...row,
      drive_folder_id: params.folderId,
      drive_folder_url: params.folderUrl,
      document_results: params.documentResults,
      processing_status: 'files_processed',
      files_processed_at: '2026-08-01T12:01:00.000Z',
    };
    return row;
  });
  mocks.markFilesFailed.mockImplementation(async (_id: string, error: string) => {
    row = { ...row, processing_status: 'files_failed', processing_error: error };
    return row;
  });
  mocks.markAirtableSynced.mockImplementation(async () => {
    row = { ...row, processing_status: 'airtable_synced', airtable_synced_at: '2026-08-01T12:02:00.000Z' };
    return row;
  });
  mocks.markAirtableFailed.mockImplementation(async (_id: string, error: string) => {
    row = { ...row, airtable_error: error, airtable_attempt_count: row.airtable_attempt_count + 1 };
    return row;
  });
  mocks.claimNotification.mockImplementation(async () => {
    row = { ...row, notification_status: 'sending' };
    return row;
  });
  mocks.markNotificationComplete.mockImplementation(async (params: any) => {
    row = { ...row, processing_status: 'completed', notification_status: params.mode };
    return row;
  });
  mocks.markNotificationFailed.mockImplementation(async (_id: string, error: string) => {
    row = { ...row, notification_status: 'failed', notification_error: error };
    return row;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  row = null;
  mocks.queryOne.mockResolvedValue({
    id: CONTRACTOR_ID,
    full_name: 'Jane Contractor',
    airtable_record_id: AIRTABLE_ID,
  });
  mocks.findFolder.mockResolvedValue({ drive_folder_id: 'folder-1', drive_folder_url: 'https://drive.google.com/drive/folders/folder-1' });
  mocks.getContractorAirtableField.mockResolvedValue(null);
  mocks.getStatuses.mockResolvedValue({
    onboardingDocumentStatus: null,
    missingDocsReviewStatus: null,
  });
  mocks.resolveContractorFolder.mockResolvedValue({ id: 'folder-1', webViewLink: 'https://drive.google.com/drive/folders/folder-1' });
  mocks.downloadAndUploadFile.mockResolvedValue({
    id: 'file-1',
    webViewLink: 'https://drive.google.com/file/d/file-1/view',
    storedFileName: `W9_${AIRTABLE_ID}_${SUBMISSION_ID}.pdf`,
    detectedContentType: 'application/pdf',
  });
  mocks.updateAirtable.mockResolvedValue(undefined);
  mocks.sendNotification.mockResolvedValue({ mode: 'sent', providerMessageId: 'email-1' });
  configureStatefulRepository();
});

describe('processMissingDocumentsSubmission', () => {
  it('processes only supplied files, writes review fields, and sends one operator notification', async () => {
    const result = await processMissingDocumentsSubmission(BASE_PAYLOAD);

    expect(result.status).toBe('processed');
    expect(result.processedFiles).toEqual(['W-9']);
    expect(mocks.downloadAndUploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.downloadAndUploadFile).toHaveBeenCalledWith(expect.objectContaining({
      fileName: `W9_${AIRTABLE_ID}_${SUBMISSION_ID}.pdf`,
      jotformApiKey: 'test-jotform-key',
    }));

    const fields = mocks.updateAirtable.mock.calls[0][1];
    expect(fields).toMatchObject({
      fldQHTr0eSxmhGGOW: SUBMISSION_ID,
      fld06XS5VPue6uSj8: true,
      fldauRRFrJoe7FrKQ: 'Owner Review Needed',
      fldhp1o95RqRv3Oy0: 'Awaiting Review',
    });
    expect(Object.keys(fields).sort()).toEqual([
      'fld0Is7pUxLh2TZj3',
      'fld06XS5VPue6uSj8',
      'fldQHTr0eSxmhGGOW',
      'fldXR2KV5uq7DYbZ9',
      'fldauRRFrJoe7FrKQ',
      'fldhp1o95RqRv3Oy0',
    ].sort());
    expect(Object.values(fields)).not.toContain(false);
    expect(fields).not.toHaveProperty('fldTHFlf5RuluUjLK');
    expect(fields).not.toHaveProperty('fldj3x3BnSQt9IpKv');
    expect(fields).not.toHaveProperty('fldZ1q3cYMvYwni8q');
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).toHaveBeenCalledWith(expect.objectContaining({
      submissionId: SUBMISSION_ID,
      receivedDocuments: ['W-9'],
      failedDocuments: [],
    }));
  });

  it.each([
    [{ ...BASE_PAYLOAD, contractorRecord: '' }, 'MISSING_CONTRACTOR_RECORD'],
    [{ ...BASE_PAYLOAD, backendContractor: '' }, 'MISSING_BACKEND_CONTRACTOR_ID'],
    [{ ...BASE_PAYLOAD, submissionID: '' }, 'MISSING_SUBMISSION_ID'],
  ])('rejects missing required identifiers', async (payload, code) => {
    await expect(processMissingDocumentsSubmission(payload)).rejects.toMatchObject({ code });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('rejects an unknown contractor and an Airtable/backend identity mismatch', async () => {
    mocks.queryOne.mockResolvedValueOnce(null);
    await expect(processMissingDocumentsSubmission(BASE_PAYLOAD)).rejects.toMatchObject({ code: 'CONTRACTOR_NOT_FOUND' });

    mocks.queryOne.mockResolvedValueOnce({ id: CONTRACTOR_ID, full_name: 'Jane', airtable_record_id: 'recOTHER' });
    await expect(processMissingDocumentsSubmission(BASE_PAYLOAD)).rejects.toMatchObject({ code: 'CONTRACTOR_IDENTITY_MISMATCH' });
  });

  it('preserves prior receipt/contact/approval state by never writing omitted or unrelated fields', async () => {
    await processMissingDocumentsSubmission({ ...BASE_PAYLOAD, w9: undefined, photoId: 'https://www.jotform.com/uploads/photo.pdf' });
    const fields = mocks.updateAirtable.mock.calls[0][1];
    expect(fields.fldqZOgILUTVbqzii).toBe(true);
    expect(fields).not.toHaveProperty('fld06XS5VPue6uSj8');
    expect(fields).not.toHaveProperty('fldTHFlf5RuluUjLK');
    expect(fields).not.toHaveProperty('email');
    expect(Object.values(fields)).not.toContain(false);
  });

  it('records a rejected upload, omits its receipt field, and reports it to the operator', async () => {
    mocks.downloadAndUploadFile.mockRejectedValueOnce(new Error('File signature does not match allowed MIME type'));
    const result = await processMissingDocumentsSubmission(BASE_PAYLOAD);
    expect(result.errors[0]).toContain('File signature');
    expect(mocks.updateAirtable.mock.calls[0][1]).not.toHaveProperty('fld06XS5VPue6uSj8');
    expect(mocks.sendNotification).toHaveBeenCalledWith(expect.objectContaining({
      receivedDocuments: [],
      failedDocuments: [expect.stringContaining('File signature')],
    }));
  });

  it('does not re-upload or notify again for a completed duplicate submission', async () => {
    row = { ...freshRow(), processing_status: 'completed', files_processed_at: 'now', airtable_synced_at: 'now', notification_status: 'sent' };
    const result = await processMissingDocumentsSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('duplicate');
    expect(mocks.downloadAndUploadFile).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it('treats a new submission ID as a new correction and sends another notification', async () => {
    await processMissingDocumentsSubmission(BASE_PAYLOAD);
    row = null;
    await processMissingDocumentsSubmission({ ...BASE_PAYLOAD, submissionID: 'sub-101' });
    expect(mocks.sendNotification).toHaveBeenCalledTimes(2);
    expect(mocks.sendNotification.mock.calls[1][0].submissionId).toBe('sub-101');
  });

  it('retries Airtable after failure without re-uploading or sending an early notification', async () => {
    mocks.updateAirtable.mockRejectedValueOnce(new Error('Airtable unavailable'));
    const first = await processMissingDocumentsSubmission(BASE_PAYLOAD);
    expect(first.status).toBe('retry_pending');
    expect(mocks.downloadAndUploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).not.toHaveBeenCalled();

    mocks.updateAirtable.mockResolvedValueOnce(undefined);
    const retry = await processMissingDocumentsSubmission(BASE_PAYLOAD);
    expect(retry.status).toBe('processed');
    expect(mocks.downloadAndUploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.updateAirtable).toHaveBeenCalledTimes(2);
    expect(mocks.getStatuses).toHaveBeenCalledTimes(2);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['empty', ''],
    ['unset', null],
    ['already awaiting review', 'Awaiting Review'],
    ['unknown', 'Unexpected Value'],
  ])('writes Awaiting Review when Missing Docs Review Status is %s', async (_label, currentStatus) => {
    mocks.getStatuses.mockResolvedValueOnce({
      onboardingDocumentStatus: null,
      missingDocsReviewStatus: currentStatus,
    });
    await processMissingDocumentsSubmission(BASE_PAYLOAD);
    expect(mocks.updateAirtable.mock.calls[0][1].fldhp1o95RqRv3Oy0).toBe('Awaiting Review');
  });

  it.each(['Reviewed - Accepted', 'More Documents Needed'])(
    'preserves terminal Missing Docs Review Status %s by omitting it from PATCH',
    async (currentStatus) => {
      mocks.getStatuses.mockResolvedValueOnce({
        onboardingDocumentStatus: null,
        missingDocsReviewStatus: currentStatus,
      });
      await processMissingDocumentsSubmission(BASE_PAYLOAD);
      expect(mocks.updateAirtable.mock.calls[0][1]).not.toHaveProperty('fldhp1o95RqRv3Oy0');
    },
  );

  it('preserves Approved for Activation Request by omitting Onboarding Document Status', async () => {
    mocks.getStatuses.mockResolvedValueOnce({
      onboardingDocumentStatus: 'Approved for Activation Request',
      missingDocsReviewStatus: null,
    });
    await processMissingDocumentsSubmission(BASE_PAYLOAD);
    expect(mocks.updateAirtable.mock.calls[0][1]).not.toHaveProperty('fldauRRFrJoe7FrKQ');
  });

  it('preserves Blocked while still placing the submission in Awaiting Review', async () => {
    mocks.getStatuses.mockResolvedValueOnce({
      onboardingDocumentStatus: 'Blocked',
      missingDocsReviewStatus: null,
    });
    await processMissingDocumentsSubmission(BASE_PAYLOAD);
    const fields = mocks.updateAirtable.mock.calls[0][1];
    expect(fields).not.toHaveProperty('fldauRRFrJoe7FrKQ');
    expect(fields.fldhp1o95RqRv3Oy0).toBe('Awaiting Review');
    expect(Object.values(fields)).not.toContain(false);
  });

  it.each([
    '',
    null,
    'Not Started',
    'Submitted - Missing Items',
    'Submitted - Docs Complete',
    'Owner Review Needed',
    'Unexpected Value',
  ])(
    'writes Owner Review Needed for non-terminal Onboarding Document Status %s',
    async (currentStatus) => {
      mocks.getStatuses.mockResolvedValueOnce({
        onboardingDocumentStatus: currentStatus,
        missingDocsReviewStatus: null,
      });
      await processMissingDocumentsSubmission(BASE_PAYLOAD);
      expect(mocks.updateAirtable.mock.calls[0][1].fldauRRFrJoe7FrKQ).toBe('Owner Review Needed');
    },
  );

  it('performs the two-status GET before the combined PATCH', async () => {
    await processMissingDocumentsSubmission(BASE_PAYLOAD);
    expect(mocks.getStatuses).toHaveBeenCalledWith(AIRTABLE_ID);
    expect(mocks.getStatuses.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateAirtable.mock.invocationCallOrder[0],
    );
    expect(mocks.updateAirtable).toHaveBeenCalledTimes(1);
  });

  it('preserves an operator terminal review value on an Airtable-only retry', async () => {
    mocks.getStatuses
      .mockResolvedValueOnce({ onboardingDocumentStatus: null, missingDocsReviewStatus: null })
      .mockResolvedValueOnce({ onboardingDocumentStatus: null, missingDocsReviewStatus: 'Reviewed - Accepted' });
    mocks.markAirtableSynced.mockResolvedValueOnce(null);

    expect((await processMissingDocumentsSubmission(BASE_PAYLOAD)).status).toBe('retry_pending');
    expect((await processMissingDocumentsSubmission(BASE_PAYLOAD)).status).toBe('processed');

    expect(mocks.downloadAndUploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.getStatuses).toHaveBeenCalledTimes(2);
    expect(mocks.updateAirtable).toHaveBeenCalledTimes(2);
    expect(mocks.updateAirtable.mock.calls[1][1]).not.toHaveProperty('fldhp1o95RqRv3Oy0');
  });

  it('returns retry_pending when the status GET fails and does not PATCH, sync, or notify', async () => {
    mocks.getStatuses.mockRejectedValueOnce(new Error('Airtable GET unavailable'));
    const result = await processMissingDocumentsSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('retry_pending');
    expect(mocks.updateAirtable).not.toHaveBeenCalled();
    expect(mocks.markAirtableSynced).not.toHaveBeenCalled();
    expect(mocks.markAirtableFailed).toHaveBeenCalledTimes(1);
    expect(mocks.claimNotification).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it('does not read or write review status when file-processing setup fails', async () => {
    mocks.resolveContractorFolder.mockRejectedValueOnce(new Error('Drive unavailable'));
    await expect(processMissingDocumentsSubmission(BASE_PAYLOAD)).rejects.toThrow('Drive unavailable');
    expect(mocks.getStatuses).not.toHaveBeenCalled();
    expect(mocks.updateAirtable).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it('does not persist Airtable sync or notify when the combined PATCH fails', async () => {
    mocks.updateAirtable.mockRejectedValueOnce(new Error('Airtable PATCH unavailable'));
    const result = await processMissingDocumentsSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('retry_pending');
    expect(mocks.getStatuses).toHaveBeenCalledTimes(1);
    expect(mocks.markAirtableSynced).not.toHaveBeenCalled();
    expect(mocks.markAirtableFailed).toHaveBeenCalledTimes(1);
    expect(mocks.claimNotification).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it('does not notify if persisting airtable_synced_at fails after GET and PATCH', async () => {
    mocks.markAirtableSynced.mockResolvedValueOnce(null);
    const result = await processMissingDocumentsSubmission(BASE_PAYLOAD);
    expect(result.status).toBe('retry_pending');
    expect(mocks.getStatuses).toHaveBeenCalledTimes(1);
    expect(mocks.updateAirtable).toHaveBeenCalledTimes(1);
    expect(mocks.claimNotification).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it('never adds acceptance, activation, contractor-status, contact, or dispatch fields', async () => {
    await processMissingDocumentsSubmission(BASE_PAYLOAD);
    const fields = mocks.updateAirtable.mock.calls[0][1];
    for (const forbidden of [
      'fldTHFlf5RuluUjLK',
      'fldj3x3BnSQt9IpKv',
      'fldPHh2SUD6F6XLEA',
      'fldgmMKvhbrzRQ2MK',
      'fldi1iftUdPGspZzH',
      'fldkFViCRSeSNr4IH',
      'fldkCvSCInutLztbZ',
      'fldS3TKRHv92bm6oD',
      'fldsIyDLEqtzWM7mT',
      'fldKMQKKrGKgzBMRL',
      'fldcmdKg901dExZY4',
      'email',
      'phone',
    ]) {
      expect(fields).not.toHaveProperty(forbidden);
    }
  });
});
