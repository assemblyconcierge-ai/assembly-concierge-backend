import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const processSubmission = vi.hoisted(() => vi.fn());

vi.mock('../../src/modules/onboarding/missingDocuments.service', () => ({
  processMissingDocumentsSubmission: processSubmission,
}));
vi.mock('../../src/common/config', () => ({
  config: {
    JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN: 'webhook-token',
    NODE_ENV: 'test',
  },
}));

import { missingDocumentsRouter } from '../../src/modules/onboarding/missingDocuments.routes';
import { config } from '../../src/common/config';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(express.urlencoded({ extended: true }));
  instance.use('/', missingDocumentsRouter);
  return instance;
}

const BODY = {
  formID: 'missing-form',
  submissionID: 'sub-1',
  contractorRecord: 'rec-1',
  backendContractor: 'contractor-1',
  w9: 'https://www.jotform.com/uploads/w9.pdf',
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(config, {
    JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN: 'webhook-token',
    NODE_ENV: 'test',
  });
  processSubmission.mockResolvedValue({
    status: 'processed',
    contractorId: 'contractor-1',
    documentStatus: 'Owner Review Needed',
    processedFiles: ['W-9'],
    errors: [],
    notificationStatus: 'sent',
  });
});

describe('POST /webhooks/jotform/contractor-missing-documents', () => {
  it('requires the shared onboarding webhook token', async () => {
    const response = await request(app()).post('/webhooks/jotform/contractor-missing-documents').send(BODY);
    expect(response.status).toBe(401);
    expect(processSubmission).not.toHaveBeenCalled();
  });

  it('fails closed in production when webhook security is not configured', async () => {
    Object.assign(config, { JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN: undefined, NODE_ENV: 'production' });
    const response = await request(app()).post('/webhooks/jotform/contractor-missing-documents').send(BODY);
    expect(response.status).toBe(503);
  });

  it('accepts a valid dedicated missing-documents submission', async () => {
    const response = await request(app())
      .post('/webhooks/jotform/contractor-missing-documents?token=webhook-token')
      .send(BODY);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'processed',
      documentStatus: 'Owner Review Needed',
      notificationStatus: 'sent',
    });
  });

  it('parses Jotform rawRequest while retaining outer submission fields', async () => {
    await request(app())
      .post('/webhooks/jotform/contractor-missing-documents?token=webhook-token')
      .send({
        formID: 'missing-form',
        submissionID: 'outer-submission',
        rawRequest: JSON.stringify({ contractorRecord: 'rec-1', backendContractor: 'contractor-1' }),
      })
      .expect(200);
    expect(processSubmission).toHaveBeenCalledWith(expect.objectContaining({
      formID: 'missing-form',
      submissionID: 'outer-submission',
      contractorRecord: 'rec-1',
    }));
  });

  it('returns service validation errors without invoking the global 500 handler', async () => {
    processSubmission.mockRejectedValueOnce(Object.assign(new Error('Identity mismatch'), {
      statusCode: 409,
      code: 'CONTRACTOR_IDENTITY_MISMATCH',
    }));
    const response = await request(app())
      .post('/webhooks/jotform/contractor-missing-documents?token=webhook-token')
      .send(BODY);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('CONTRACTOR_IDENTITY_MISMATCH');
  });

  it('returns 503 for persisted downstream failures so Jotform can retry', async () => {
    processSubmission.mockResolvedValueOnce({
      status: 'retry_pending',
      contractorId: 'contractor-1',
      documentStatus: 'Owner Review Needed',
      processedFiles: ['W-9'],
      errors: ['Airtable sync failed: unavailable'],
      notificationStatus: 'pending',
    });
    const response = await request(app())
      .post('/webhooks/jotform/contractor-missing-documents?token=webhook-token')
      .send(BODY);
    expect(response.status).toBe(503);
    expect(response.body.status).toBe('retry_pending');
  });
});
