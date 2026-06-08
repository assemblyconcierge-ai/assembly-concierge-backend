/**
 * Contractor Job Packet Route Tests
 *
 * GET /public/contractor/jobs/:contractorPacketToken
 *
 * Covers:
 * - Valid token + accepted assignment + assigned job + accepted dispatch → 200 HTML
 * - SQL access conditions verified: INNER JOIN dispatches, d.job_id = ca.job_id,
 *   ca.status = 'accepted', j.status = 'assigned', d.status = 'accepted'
 * - Token value does not appear in HTML output
 * - Malformed token → 404, no DB query
 * - Unknown token → 404
 * - Assignment pending/cancelled/declined/completed → 404 (DB returns no row)
 * - Job status not 'assigned' → 404 (DB returns no row)
 * - Dispatch expired/cancelled/declined/sent/failed → 404 (DB returns no row)
 * - No confirmed photos → 200 with no-photo state
 * - Confirmed photos → signed URLs generated and rendered
 * - Signing error skips failed photo, still returns 200
 * - Cache-Control: no-store header is set
 * - CSP includes bucket-prefixed R2 origin
 */

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { contractorPacketRouter } from '../../../src/modules/public-booking/contractorPacket.routes';
import { query } from '../../../src/db/pool';
import { generatePresignedDownloadUrl } from '../../../src/modules/storage/s3.service';

// ── Module mocks ──────────────────────────────────────────────────────────────

// Explicit mock for db/pool — prevents any real DB connection in tests
vi.mock('../../../src/db/pool', () => ({
  query: vi.fn(),
}));

vi.mock('../../../src/modules/storage/s3.service', () => ({
  generatePresignedDownloadUrl: vi.fn(),
  generatePresignedUploadUrl: vi.fn(),
}));

vi.mock('../../../src/common/config', () => ({
  config: {
    NODE_ENV: 'test',
    APP_BASE_URL: 'https://api.example.com',
    QUO_PHONE_NUMBER: '+14705550000',
    STORAGE_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
    STORAGE_BUCKET: 'ac-media',
  },
}));

// ── Test app ──────────────────────────────────────────────────────────────────
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { correlationId?: string }).correlationId = 'test-corr-id';
    next();
  });
  app.use('/public/contractor', contractorPacketRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'TEST_ERROR', message: err.message });
  });
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const VALID_TOKEN = 'cpk_' + 'a'.repeat(32);

/** Valid packet row — no dispatch_status column (removed from SELECT in Fix 1) */
const packetRow = {
  job_id: 'job-uuid-1',
  job_key: 'AC-2026-TEST',
  job_status: 'assigned',
  service_type_name: 'Medium Assembly',
  appointment_date: '2026-07-15',
  appointment_window: '10am - 12pm',
  special_instructions: 'Leave at door',
  custom_job_details: 'IKEA KALLAX shelf',
  customer_full_name: 'Jane Smith',
  customer_phone: '+14045550200',
  address_line1: '456 Oak Ave',
  address_line2: null,
  address_city: 'Atlanta',
  address_state: 'GA',
  address_postal_code: '30301',
};

const confirmedPhoto = {
  id: 'photo-uuid-1',
  storage_key: 'jobs/AC-2026-TEST/photo1.jpg',
  mime_type: 'image/jpeg',
  original_filename: 'photo1.jpg',
  confirmed_at: new Date('2026-07-10T12:00:00Z'),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function setupPacketQuery(row: typeof packetRow | null, photos: typeof confirmedPhoto[] = []) {
  // First query() call: packet access check
  vi.mocked(query).mockResolvedValueOnce(row ? [row] : ([] as never[]));
  // Second query() call: confirmed photos (only reached when row is found)
  if (row) {
    vi.mocked(query).mockResolvedValueOnce(photos as never[]);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('GET /public/contractor/jobs/:contractorPacketToken', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── SQL access condition assertions ────────────────────────────────────────
  it('SQL query uses INNER JOIN dispatches with dual-key condition', async () => {
    setupPacketQuery(packetRow, []);

    await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);

    const sqlArg: string = vi.mocked(query).mock.calls[0][0] as string;
    expect(sqlArg).toContain('JOIN dispatches d');
    expect(sqlArg).toContain('d.job_id = ca.job_id');
  });

  it('SQL query requires ca.status = accepted', async () => {
    setupPacketQuery(packetRow, []);

    await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);

    const sqlArg: string = vi.mocked(query).mock.calls[0][0] as string;
    expect(sqlArg).toContain("ca.status = 'accepted'");
  });

  it('SQL query requires j.status = assigned (not IN list)', async () => {
    setupPacketQuery(packetRow, []);

    await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);

    const sqlArg: string = vi.mocked(query).mock.calls[0][0] as string;
    expect(sqlArg).toContain("j.status = 'assigned'");
    // Must not use an IN list that could include 'scheduled'
    expect(sqlArg).not.toContain("j.status IN");
  });

  it('SQL query requires d.status = accepted', async () => {
    setupPacketQuery(packetRow, []);

    await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);

    const sqlArg: string = vi.mocked(query).mock.calls[0][0] as string;
    expect(sqlArg).toContain("d.status = 'accepted'");
  });

  it('SQL query does not use LEFT JOIN for dispatches', async () => {
    setupPacketQuery(packetRow, []);

    await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);

    const sqlArg: string = vi.mocked(query).mock.calls[0][0] as string;
    expect(sqlArg).not.toContain('LEFT JOIN dispatches');
    expect(sqlArg).not.toContain('d.id IS NULL');
  });

  // ── Happy path ──────────────────────────────────────────────────────────────
  it('returns 200 HTML with job key, service type, appointment, address, and SMS links', async () => {
    setupPacketQuery(packetRow, []);
    vi.mocked(generatePresignedDownloadUrl).mockResolvedValue('https://signed.example.com/photo.jpg');

    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('AC-2026-TEST');
    expect(res.text).toContain('Medium Assembly');
    expect(res.text).toContain('2026-07-15');
    expect(res.text).toContain('10am - 12pm');
    expect(res.text).toContain('Jane Smith');
    expect(res.text).toContain('+14045550200');
    expect(res.text).toContain('456 Oak Ave');
    expect(res.text).toContain('Atlanta');
    expect(res.text).toContain('GA');
    expect(res.text).toContain('30301');
    // Google Maps link
    expect(res.text).toContain('www.google.com/maps/dir');
    // OTW SMS link
    expect(res.text).toContain('sms:+14705550000');
    expect(res.text).toContain('OTW%20AC-2026-TEST');
    // DONE SMS link
    expect(res.text).toContain('DONE%20AC-2026-TEST');
    // Manual fallback
    expect(res.text).toContain('+14705550000');
    expect(res.text).toContain('OTW AC-2026-TEST');
    expect(res.text).toContain('DONE AC-2026-TEST');
    // Job details
    expect(res.text).toContain('IKEA KALLAX shelf');
    expect(res.text).toContain('Leave at door');
  });

  it('does not render the contractor_packet_token value in the HTML output', async () => {
    setupPacketQuery(packetRow, []);

    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain(VALID_TOKEN);
    expect(res.text).not.toContain('cpk_');
  });

  it('sets Cache-Control: no-store on the response', async () => {
    setupPacketQuery(packetRow, []);

    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);

    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('includes bucket-prefixed R2 origin in Content-Security-Policy', async () => {
    setupPacketQuery(packetRow, []);

    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);

    const csp = res.headers['content-security-policy'] ?? '';
    expect(csp).toContain('ac-media.abc123.r2.cloudflarestorage.com');
  });

  // ── Photos ──────────────────────────────────────────────────────────────────
  it('returns 200 with no-photo state when no confirmed photos exist', async () => {
    setupPacketQuery(packetRow, []);

    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('No confirmed photos yet');
  });

  it('generates signed URLs for confirmed photos and renders them', async () => {
    setupPacketQuery(packetRow, [confirmedPhoto]);
    vi.mocked(generatePresignedDownloadUrl).mockResolvedValue('https://signed.example.com/photo1.jpg');

    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);

    expect(res.status).toBe(200);
    expect(generatePresignedDownloadUrl).toHaveBeenCalledWith(confirmedPhoto.storage_key);
    expect(res.text).toContain('https://signed.example.com/photo1.jpg');
    expect(res.text).toContain('photo1.jpg');
  });

  it('skips a failed photo signing and still returns 200', async () => {
    const photo2 = { ...confirmedPhoto, id: 'photo-uuid-2', storage_key: 'jobs/AC-2026-TEST/photo2.jpg', original_filename: 'photo2.jpg' };
    setupPacketQuery(packetRow, [confirmedPhoto, photo2]);
    vi.mocked(generatePresignedDownloadUrl)
      .mockRejectedValueOnce(new Error('R2 unavailable'))
      .mockResolvedValueOnce('https://signed.example.com/photo2.jpg');

    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);

    expect(res.status).toBe(200);
    // Second photo still rendered
    expect(res.text).toContain('https://signed.example.com/photo2.jpg');
  });

  // ── Token format validation (no DB query) ───────────────────────────────────
  it('returns 404 for malformed token (wrong prefix)', async () => {
    const res = await request(createTestApp()).get('/public/contractor/jobs/ppt_' + 'a'.repeat(32));
    expect(res.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 404 for malformed token (too short)', async () => {
    const res = await request(createTestApp()).get('/public/contractor/jobs/cpk_tooshort');
    expect(res.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 404 for malformed token (uppercase hex)', async () => {
    const res = await request(createTestApp()).get('/public/contractor/jobs/cpk_' + 'A'.repeat(32));
    expect(res.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  // ── Access denied: DB returns no row (INNER JOIN / WHERE conditions not met) ─
  it('returns 404 for unknown token', async () => {
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when assignment is pending (ca.status != accepted)', async () => {
    // INNER JOIN WHERE ca.status = 'accepted' filters this out at DB level
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when assignment is cancelled', async () => {
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when assignment is declined', async () => {
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when assignment is completed', async () => {
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when job status is dispatch_in_progress (j.status != assigned)', async () => {
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when job status is ready_for_dispatch', async () => {
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when job status is cancelled', async () => {
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when job status is completion_reported', async () => {
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when job status is work_completed', async () => {
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when job status is closed_paid', async () => {
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when dispatch is expired (d.status != accepted)', async () => {
    // INNER JOIN WHERE d.status = 'accepted' filters out expired dispatch
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when dispatch is cancelled', async () => {
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when dispatch is declined', async () => {
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when dispatch is sent (not yet accepted)', async () => {
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when dispatch is failed', async () => {
    setupPacketQuery(null);
    const res = await request(createTestApp()).get(`/public/contractor/jobs/${VALID_TOKEN}`);
    expect(res.status).toBe(404);
  });
});
