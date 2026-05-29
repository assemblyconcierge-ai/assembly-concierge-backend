import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { photosRouter } from '../../../src/modules/public-booking/photos.routes';
import { getJobByPublicPayToken } from '../../../src/modules/jobs/job.repository';
import { query, queryOne } from '../../../src/db/pool';
import { generatePresignedUploadUrl } from '../../../src/modules/storage/s3.service';

vi.mock('../../../src/modules/jobs/job.repository', () => ({
  getJobByPublicPayToken: vi.fn(),
}));

vi.mock('../../../src/db/pool', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

vi.mock('../../../src/modules/storage/s3.service', () => ({
  generatePresignedUploadUrl: vi.fn(),
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.correlationId = 'test-correlation-id';
    next();
  });
  app.use('/public/photos', photosRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'TEST_ERROR', message: err.message });
  });
  return app;
}

const activeJob = {
  id: 'job-uuid-1',
  job_key: 'AC-TEST-001',
  status: 'awaiting_payment',
  public_pay_token: 'ppt_valid_token',
};

const validPresignPayload = {
  publicPayToken: 'ppt_valid_token',
  filename: 'dresser-box.jpg',
  mimeType: 'image/jpeg',
  fileSizeBytes: 1_024_000,
};

const validConfirmPayload = {
  publicPayToken: 'ppt_valid_token',
  storageKey: 'jobs/AC-TEST-001/uuid.jpg',
};

// ─── POST /public/photos/presign ─────────────────────────────────────────────

describe('POST /public/photos/presign', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 201 with uploadUrl and storageKey for a valid request', async () => {
    vi.mocked(getJobByPublicPayToken).mockResolvedValue(activeJob as never);
    vi.mocked(query).mockResolvedValueOnce([{ count: '0' }]); // count check
    vi.mocked(query).mockResolvedValueOnce([]); // INSERT
    vi.mocked(generatePresignedUploadUrl).mockResolvedValue('https://r2.example.com/signed-url');

    const app = createTestApp();
    const res = await request(app)
      .post('/public/photos/presign')
      .send(validPresignPayload);

    expect(res.status).toBe(201);
    expect(res.body.uploadUrl).toBe('https://r2.example.com/signed-url');
    expect(res.body.storageKey).toMatch(/^jobs\/AC-TEST-001\//);
    expect(res.body.expiresAt).toBeDefined();
  });

  it('returns 400 for missing required fields', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/public/photos/presign')
      .send({ publicPayToken: 'ppt_valid_token' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for unsupported MIME type', async () => {
    vi.mocked(getJobByPublicPayToken).mockResolvedValue(activeJob as never);

    const app = createTestApp();
    const res = await request(app)
      .post('/public/photos/presign')
      .send({ ...validPresignPayload, mimeType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNSUPPORTED_MIME_TYPE');
  });

  it('returns 400 when file exceeds 20MB', async () => {
    vi.mocked(getJobByPublicPayToken).mockResolvedValue(activeJob as never);

    const app = createTestApp();
    const res = await request(app)
      .post('/public/photos/presign')
      .send({ ...validPresignPayload, fileSizeBytes: 21 * 1024 * 1024 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('FILE_TOO_LARGE');
  });

  it('returns 401 for an invalid or unknown token', async () => {
    vi.mocked(getJobByPublicPayToken).mockResolvedValue(null);

    const app = createTestApp();
    const res = await request(app)
      .post('/public/photos/presign')
      .send(validPresignPayload);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TOKEN');
  });

  it('returns 422 when job is in a terminal status', async () => {
    vi.mocked(getJobByPublicPayToken).mockResolvedValue({
      ...activeJob,
      status: 'cancelled',
    } as never);

    const app = createTestApp();
    const res = await request(app)
      .post('/public/photos/presign')
      .send(validPresignPayload);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('JOB_NOT_ELIGIBLE');
  });

  it('returns 409 when job has reached the 10-photo limit', async () => {
    vi.mocked(getJobByPublicPayToken).mockResolvedValue(activeJob as never);
    vi.mocked(query).mockResolvedValueOnce([{ count: '10' }]);

    const app = createTestApp();
    const res = await request(app)
      .post('/public/photos/presign')
      .send(validPresignPayload);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('UPLOAD_LIMIT_REACHED');
  });

  it('does NOT call generatePresignedUploadUrl when count limit is reached', async () => {
    vi.mocked(getJobByPublicPayToken).mockResolvedValue(activeJob as never);
    vi.mocked(query).mockResolvedValueOnce([{ count: '10' }]);

    const app = createTestApp();
    await request(app)
      .post('/public/photos/presign')
      .send(validPresignPayload);

    expect(generatePresignedUploadUrl).not.toHaveBeenCalled();
  });
});

// ─── POST /public/photos/confirm ─────────────────────────────────────────────

describe('POST /public/photos/confirm', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 200 with mediaId and confirmedAt for a valid confirm', async () => {
    vi.mocked(getJobByPublicPayToken).mockResolvedValue(activeJob as never);
    vi.mocked(queryOne).mockResolvedValue({
      id: 'media-uuid-1',
      confirmed_at: null,
    });
    const confirmedAt = new Date();
    vi.mocked(query).mockResolvedValueOnce([{ confirmed_at: confirmedAt }]);

    const app = createTestApp();
    const res = await request(app)
      .post('/public/photos/confirm')
      .send(validConfirmPayload);

    expect(res.status).toBe(200);
    expect(res.body.mediaId).toBe('media-uuid-1');
    expect(res.body.storageKey).toBe(validConfirmPayload.storageKey);
    expect(res.body.confirmedAt).toBeDefined();
  });

  it('returns 400 for missing required fields', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/public/photos/confirm')
      .send({ publicPayToken: 'ppt_valid_token' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 401 for an invalid or unknown token', async () => {
    vi.mocked(getJobByPublicPayToken).mockResolvedValue(null);

    const app = createTestApp();
    const res = await request(app)
      .post('/public/photos/confirm')
      .send(validConfirmPayload);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TOKEN');
  });

  it('returns 404 when storageKey is not found for this job', async () => {
    vi.mocked(getJobByPublicPayToken).mockResolvedValue(activeJob as never);
    vi.mocked(queryOne).mockResolvedValue(null);

    const app = createTestApp();
    const res = await request(app)
      .post('/public/photos/confirm')
      .send(validConfirmPayload);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('MEDIA_NOT_FOUND');
  });

  it('returns 409 when photo is already confirmed', async () => {
    vi.mocked(getJobByPublicPayToken).mockResolvedValue(activeJob as never);
    vi.mocked(queryOne).mockResolvedValue({
      id: 'media-uuid-1',
      confirmed_at: new Date(),
    });

    const app = createTestApp();
    const res = await request(app)
      .post('/public/photos/confirm')
      .send(validConfirmPayload);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ALREADY_CONFIRMED');
  });

  it('does NOT call INSERT during confirm — only UPDATE', async () => {
    vi.mocked(getJobByPublicPayToken).mockResolvedValue(activeJob as never);
    vi.mocked(queryOne).mockResolvedValue({
      id: 'media-uuid-1',
      confirmed_at: null,
    });
    const confirmedAt = new Date();
    vi.mocked(query).mockResolvedValueOnce([{ confirmed_at: confirmedAt }]);

    const app = createTestApp();
    await request(app)
      .post('/public/photos/confirm')
      .send(validConfirmPayload);

    // The only query call should be the UPDATE RETURNING, not an INSERT
    const queryCalls = vi.mocked(query).mock.calls;
    expect(queryCalls.length).toBe(1);
    expect(queryCalls[0][0]).toMatch(/UPDATE uploaded_media/i);
    expect(queryCalls[0][0]).not.toMatch(/INSERT/i);
  });
});
