/**
 * Tests for contractor completion photo upload routes.
 *
 * GET  /public/contractor/completion/:completionToken
 * POST /public/contractor/completion/:completionToken/presign
 * POST /public/contractor/completion/:completionToken/confirm
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { contractorCompletionRouter } from '../../../src/modules/public-booking/contractorCompletion.routes';

// ── Module mocks ──────────────────────────────────────────────────────────────
vi.mock('../../../src/db/pool', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

vi.mock('../../../src/modules/storage/s3.service', () => ({
  generatePresignedUploadUrl: vi.fn(),
}));

vi.mock('../../../src/common/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../src/common/config', () => ({
  config: {
    NODE_ENV: 'test',
    APP_BASE_URL: 'https://test.example.com',
    STORAGE_ENDPOINT: 'https://test.r2.cloudflarestorage.com',
    STORAGE_BUCKET: 'test-bucket',
  },
}));

import { query, queryOne } from '../../../src/db/pool';
import { generatePresignedUploadUrl } from '../../../src/modules/storage/s3.service';

// ── Test app ──────────────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).correlationId = 'test-corr';
    next();
  });
  app.use('/public/contractor/completion', contractorCompletionRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  });
  return app;
}

const VALID_TOKEN = 'cct_' + 'a'.repeat(32);
const VALID_TOKEN_2 = 'cct_' + 'b'.repeat(32);

const ACCESS_ROW = {
  assignment_id: 'assignment-1',
  job_id: 'job-1',
  job_key: 'AC-2026-EPME',
  job_status: 'completion_reported',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
  vi.mocked(generatePresignedUploadUrl).mockReset();
  vi.mocked(query).mockResolvedValue([]);
  vi.mocked(queryOne).mockResolvedValue(null);
  vi.mocked(generatePresignedUploadUrl).mockResolvedValue('https://r2.example.com/presigned-url');
});

// ── GET landing page ──────────────────────────────────────────────────────────
describe('GET /public/contractor/completion/:completionToken', () => {
  it('returns 404 for malformed token (too short)', async () => {
    const app = buildApp();
    const res = await request(app).get('/public/contractor/completion/cct_short');
    expect(res.status).toBe(404);
  });

  it('returns 404 for malformed token (wrong prefix)', async () => {
    const app = buildApp();
    const res = await request(app).get('/public/contractor/completion/cpk_' + 'a'.repeat(32));
    expect(res.status).toBe(404);
  });

  it('returns 404 for valid-format token not in DB', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await request(app).get(`/public/contractor/completion/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 200 HTML for valid token', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    const app = buildApp();
    const res = await request(app).get(`/public/contractor/completion/${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('sets Cache-Control: no-store', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    const app = buildApp();
    const res = await request(app).get(`/public/contractor/completion/${VALID_TOKEN}`);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('sets X-Frame-Options: DENY', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    const app = buildApp();
    const res = await request(app).get(`/public/contractor/completion/${VALID_TOKEN}`);
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('does NOT render the completion token in the HTML body', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    const app = buildApp();
    const res = await request(app).get(`/public/contractor/completion/${VALID_TOKEN}`);
    expect(res.text).not.toContain(VALID_TOKEN);
  });

  it('renders the job key in the HTML body', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    const app = buildApp();
    const res = await request(app).get(`/public/contractor/completion/${VALID_TOKEN}`);
    expect(res.text).toContain('AC-2026-EPME');
  });

  it('HTML contains photo slots, hidden file inputs, and upload button', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    const app = buildApp();
    const res = await request(app).get(`/public/contractor/completion/${VALID_TOKEN}`);
    // New multi-slot UI: slot-0..2, input-0..2, upload-btn
    expect(res.text).toContain('slot-0');
    expect(res.text).toContain('input-0');
    expect(res.text).toContain('upload-btn');
  });
});

// ── POST presign ──────────────────────────────────────────────────────────────
describe('POST /public/contractor/completion/:completionToken/presign', () => {
  const validBody = {
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    fileSizeBytes: 1024 * 100,
  };

  it('returns 404 for malformed token', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/public/contractor/completion/bad_token/presign')
      .send(validBody);
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown token', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await request(app)
      .post(`/public/contractor/completion/${VALID_TOKEN}/presign`)
      .send(validBody);
    expect(res.status).toBe(404);
  });

  it('returns 400 for missing filename', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    const app = buildApp();
    const res = await request(app)
      .post(`/public/contractor/completion/${VALID_TOKEN}/presign`)
      .send({ mimeType: 'image/jpeg', fileSizeBytes: 1024 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for unsupported MIME type', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    const app = buildApp();
    const res = await request(app)
      .post(`/public/contractor/completion/${VALID_TOKEN}/presign`)
      .send({ filename: 'file.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNSUPPORTED_MIME_TYPE');
  });

  it('returns 400 for file too large', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    const app = buildApp();
    const res = await request(app)
      .post(`/public/contractor/completion/${VALID_TOKEN}/presign`)
      .send({ filename: 'big.jpg', mimeType: 'image/jpeg', fileSizeBytes: 25 * 1024 * 1024 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('FILE_TOO_LARGE');
  });

  it('returns 409 when photo limit reached', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    vi.mocked(query).mockResolvedValueOnce([{ count: '20' }] as any);
    const app = buildApp();
    const res = await request(app)
      .post(`/public/contractor/completion/${VALID_TOKEN}/presign`)
      .send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('UPLOAD_LIMIT_REACHED');
  });

  it('returns 201 with uploadUrl and storageKey on success', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    vi.mocked(query)
      .mockResolvedValueOnce([{ count: '0' }] as any) // photo count
      .mockResolvedValueOnce([] as any); // INSERT
    const app = buildApp();
    const res = await request(app)
      .post(`/public/contractor/completion/${VALID_TOKEN}/presign`)
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('uploadUrl');
    expect(res.body).toHaveProperty('storageKey');
    expect(res.body.storageKey).toContain('completion/');
  });

  it('INSERT includes photo_type = completion explicitly', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    vi.mocked(query)
      .mockResolvedValueOnce([{ count: '0' }] as any)
      .mockResolvedValueOnce([] as any);
    const app = buildApp();
    await request(app)
      .post(`/public/contractor/completion/${VALID_TOKEN}/presign`)
      .send(validBody);
    const insertCall = vi.mocked(query).mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO uploaded_media'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![0]).toContain("'completion'");
  });

  it('storageKey path includes jobs/{jobKey}/completion/', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    vi.mocked(query)
      .mockResolvedValueOnce([{ count: '0' }] as any)
      .mockResolvedValueOnce([] as any);
    const app = buildApp();
    const res = await request(app)
      .post(`/public/contractor/completion/${VALID_TOKEN}/presign`)
      .send(validBody);
    expect(res.body.storageKey).toMatch(/^jobs\/AC-2026-EPME\/completion\//);
  });
});

// ── POST confirm ──────────────────────────────────────────────────────────────
describe('POST /public/contractor/completion/:completionToken/confirm', () => {
  const validBody = { storageKey: 'jobs/AC-2026-EPME/completion/uuid.jpg' };

  it('returns 404 for malformed token', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/public/contractor/completion/bad_token/confirm')
      .send(validBody);
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown token', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await request(app)
      .post(`/public/contractor/completion/${VALID_TOKEN}/confirm`)
      .send(validBody);
    expect(res.status).toBe(404);
  });

  it('returns 400 for missing storageKey', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    const app = buildApp();
    const res = await request(app)
      .post(`/public/contractor/completion/${VALID_TOKEN}/confirm`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when media row not found', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(ACCESS_ROW as any) // access check
      .mockResolvedValueOnce(null); // media lookup
    const app = buildApp();
    const res = await request(app)
      .post(`/public/contractor/completion/${VALID_TOKEN}/confirm`)
      .send(validBody);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('MEDIA_NOT_FOUND');
  });

  it('returns 409 when photo already confirmed', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(ACCESS_ROW as any)
      .mockResolvedValueOnce({ id: 'media-1', confirmed_at: new Date() } as any);
    const app = buildApp();
    const res = await request(app)
      .post(`/public/contractor/completion/${VALID_TOKEN}/confirm`)
      .send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ALREADY_CONFIRMED');
  });

  it('returns 200 with mediaId and confirmedAt on success', async () => {
    const confirmedAt = new Date('2026-06-30T12:00:00Z');
    vi.mocked(queryOne)
      .mockResolvedValueOnce(ACCESS_ROW as any)
      .mockResolvedValueOnce({ id: 'media-1', confirmed_at: null } as any);
    vi.mocked(query).mockResolvedValueOnce([{ confirmed_at: confirmedAt }] as any);
    const app = buildApp();
    const res = await request(app)
      .post(`/public/contractor/completion/${VALID_TOKEN}/confirm`)
      .send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.mediaId).toBe('media-1');
    expect(res.body.storageKey).toBe(validBody.storageKey);
    expect(res.body.confirmedAt).toBe(confirmedAt.toISOString());
  });

  it('media lookup filters by photo_type = completion', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(ACCESS_ROW as any)
      .mockResolvedValueOnce(null);
    const app = buildApp();
    await request(app)
      .post(`/public/contractor/completion/${VALID_TOKEN}/confirm`)
      .send(validBody);
    const mediaLookupCall = vi.mocked(queryOne).mock.calls[1];
    expect(mediaLookupCall[0]).toContain("photo_type = 'completion'");
  });
});
