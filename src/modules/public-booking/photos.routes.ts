import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import { query, queryOne } from '../../db/pool';
import { getJobByPublicPayToken, getJobByOperatorPhotoToken } from '../jobs/job.repository';
import { generatePresignedUploadUrl, generatePresignedDownloadUrl } from '../storage/s3.service';
import { logger } from '../../common/logger';
import { config } from '../../common/config';
import { enqueueAirtableSync } from '../airtable-sync/airtableSync.queue';

export const photosRouter = Router();

const photosRateLimiter = rateLimit({
  windowMs: 60_000,
  max: config.NODE_ENV === 'test' ? 1_000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: 'RATE_LIMITED',
      message: 'Too many upload attempts. Please try again later.',
    });
  },
});

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_PHOTOS_PER_JOB = 10;

const TERMINAL_STATUSES = new Set([
  'cancelled',
  'closed_paid',
  'work_completed',
  'error_review',
  'completion_reported',
]);

// ─── Rate limiter for the operator review page (read-only, more generous) ───
const reviewRateLimiter = rateLimit({
  windowMs: 60_000,
  max: config.NODE_ENV === 'test' ? 1_000 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).send('<h1>Too Many Requests</h1><p>Please try again later.</p>');
  },
});

// GET /public/photos/review/:operatorPhotoToken
// Read-only operator photo review page. Returns HTML with short-lived presigned image URLs.
// Invalid/unknown token → generic 404 (no information disclosure).
photosRouter.get(
  '/review/:operatorPhotoToken',
  reviewRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = req.correlationId || uuidv4();

    try {
      const { operatorPhotoToken } = req.params;

      // Validate token format — must start with opt_ and be the right length
      if (!operatorPhotoToken || !/^opt_[a-f0-9]{32}$/.test(operatorPhotoToken)) {
        res.status(404).send('<h1>Not Found</h1>');
        return;
      }

      const job = await getJobByOperatorPhotoToken(operatorPhotoToken);
      if (!job) {
        // Generic 404 — do not reveal whether token is valid or not
        res.status(404).send('<h1>Not Found</h1>');
        return;
      }

      // Query confirmed photos only
      const photos = await query<{ id: string; storage_key: string; mime_type: string | null; original_filename: string | null; uploaded_at: Date; confirmed_at: Date | null }>(
        `SELECT id, storage_key, mime_type, original_filename, uploaded_at, confirmed_at
         FROM uploaded_media
         WHERE job_id = $1 AND confirmed_at IS NOT NULL
         ORDER BY confirmed_at ASC`,
        [job.id],
      );

      // Generate presigned GET URLs for each photo (server-side, short-lived, never stored)
      const photoItems: Array<{ url: string; filename: string | null; uploadedAt: string }> = [];
      for (const photo of photos) {
        try {
          const url = await generatePresignedDownloadUrl(photo.storage_key, 3600);
          photoItems.push({
            url,
            filename: photo.original_filename,
            uploadedAt: photo.confirmed_at?.toISOString() ?? photo.uploaded_at.toISOString(),
          });
        } catch (signErr) {
          // Log key only (not the URL) and skip this photo rather than failing the whole page
          logger.warn({ err: signErr, storageKey: photo.storage_key, correlationId }, 'Failed to sign photo URL — skipping');
        }
      }

      const photoCount = photoItems.length;
      const jobRef = job.job_key;

      // Build HTML response
      const photosHtml = photoCount === 0
        ? `<div class="empty"><p>No photos have been uploaded for this job yet.</p></div>`
        : photoItems.map((p, i) => `
          <div class="photo-card">
            <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">
              <img src="${escapeHtml(p.url)}" alt="Photo ${i + 1}${p.filename ? ': ' + escapeHtml(p.filename) : ''}" loading="lazy" />
            </a>
            <div class="photo-meta">
              <span class="photo-num">#${i + 1}</span>
              ${p.filename ? `<span class="photo-name">${escapeHtml(p.filename)}</span>` : ''}
              <span class="photo-date">${new Date(p.uploadedAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })}</span>
            </div>
          </div>`).join('\n');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Job Photos — ${escapeHtml(jobRef)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #111; color: #f5f5f5; min-height: 100vh; padding: 2rem 1rem; }
    header { max-width: 960px; margin: 0 auto 2rem; border-bottom: 2px solid #f5c518; padding-bottom: 1rem; }
    header h1 { font-size: 1.5rem; font-weight: 700; color: #f5c518; letter-spacing: 0.02em; }
    header p { font-size: 0.9rem; color: #aaa; margin-top: 0.25rem; }
    .badge { display: inline-block; background: #f5c518; color: #111; font-weight: 700; font-size: 0.8rem; padding: 0.2rem 0.6rem; border-radius: 4px; margin-top: 0.5rem; }
    .grid { max-width: 960px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1.25rem; }
    .photo-card { background: #1e1e1e; border-radius: 8px; overflow: hidden; border: 1px solid #333; }
    .photo-card a { display: block; }
    .photo-card img { width: 100%; height: 220px; object-fit: cover; display: block; transition: opacity 0.2s; }
    .photo-card img:hover { opacity: 0.88; }
    .photo-meta { padding: 0.6rem 0.75rem; display: flex; flex-direction: column; gap: 0.2rem; }
    .photo-num { font-size: 0.75rem; font-weight: 700; color: #f5c518; }
    .photo-name { font-size: 0.8rem; color: #ccc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .photo-date { font-size: 0.75rem; color: #888; }
    .empty { max-width: 960px; margin: 0 auto; background: #1e1e1e; border-radius: 8px; padding: 3rem 2rem; text-align: center; color: #888; border: 1px dashed #444; }
    footer { max-width: 960px; margin: 2rem auto 0; font-size: 0.75rem; color: #555; text-align: center; }
  </style>
</head>
<body>
  <header>
    <h1>Assembly Concierge — Job Photos</h1>
    <p>Reference: <span class="badge">${escapeHtml(jobRef)}</span></p>
    <p style="margin-top:0.5rem;color:#888;font-size:0.85rem;">${photoCount} confirmed photo${photoCount !== 1 ? 's' : ''} &nbsp;&bull;&nbsp; Photo links expire in 1 hour</p>
  </header>
  <div class="grid">
    ${photosHtml}
  </div>
  <footer>Assembly Concierge &mdash; Internal Use Only &mdash; Do not share this link</footer>
</body>
</html>`;

      // Scoped CSP for this HTML page: allow images from R2 (presigned URLs are
      // cross-origin). Global helmet() sets img-src 'self' which would block them.
      // R2 presigned URLs use the bucket-prefixed origin
      // (https://{bucket}.{account}.r2.cloudflarestorage.com), not the bare endpoint.
      const imgSrcOrigins = new Set<string>(["'self'"]);
      try {
        if (config.STORAGE_ENDPOINT) {
          const endpointUrl = new URL(config.STORAGE_ENDPOINT);
          imgSrcOrigins.add(endpointUrl.origin);
          if (
            config.STORAGE_BUCKET &&
            endpointUrl.hostname.endsWith('.r2.cloudflarestorage.com')
          ) {
            imgSrcOrigins.add(`${endpointUrl.protocol}//${config.STORAGE_BUCKET}.${endpointUrl.hostname}`);
          }
        }
      } catch {
        // Malformed endpoint — omit external origins rather than throwing
      }
      const imgSrc = [...imgSrcOrigins].join(' ');

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; frame-ancestors 'none';`,
      );
      // Prevent caching — presigned URLs are short-lived and must not be cached by proxies
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.status(200).send(html);
    } catch (err) {
      logger.error({ err, correlationId }, 'Failed to render operator photo review page');
      next(err);
    }
  },
);

/** Minimal HTML entity escaping to prevent XSS in the review page */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// POST /public/photos/presign
photosRouter.post(
  '/presign',
  photosRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = req.correlationId || uuidv4();

    try {
      const schema = z.object({
        publicPayToken: z.string().min(1),
        filename: z.string().min(1),
        mimeType: z.string().min(1),
        fileSizeBytes: z.number().int().positive(),
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: parsed.error.flatten(),
          correlationId,
        });
        return;
      }

      const { publicPayToken, filename, mimeType, fileSizeBytes } = parsed.data;

      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        res.status(400).json({
          error: 'UNSUPPORTED_MIME_TYPE',
          message: 'Unsupported file type. Allowed types: jpeg, png, webp, heic, heif.',
          correlationId,
        });
        return;
      }

      if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
        res.status(400).json({
          error: 'FILE_TOO_LARGE',
          message: 'File exceeds the 20MB limit.',
          correlationId,
        });
        return;
      }

      const job = await getJobByPublicPayToken(publicPayToken);
      if (!job) {
        res.status(401).json({
          error: 'INVALID_TOKEN',
          message: 'Invalid or missing public pay token.',
          correlationId,
        });
        return;
      }

      if (TERMINAL_STATUSES.has(job.status)) {
        res.status(422).json({
          error: 'JOB_NOT_ELIGIBLE',
          message: 'This job is no longer accepting photo uploads.',
          correlationId,
        });
        return;
      }

      // Check count
      const countResult = await query<{ count: string }>(
        'SELECT COUNT(*) as count FROM uploaded_media WHERE job_id = $1',
        [job.id],
      );
      const currentCount = parseInt(countResult[0]?.count ?? '0', 10);
      if (currentCount >= MAX_PHOTOS_PER_JOB) {
        res.status(409).json({
          error: 'UPLOAD_LIMIT_REACHED',
          message: `Maximum of ${MAX_PHOTOS_PER_JOB} photos allowed per job.`,
          correlationId,
        });
        return;
      }

      // Generate storage key — extension derived from validated MIME type, not client filename
      const MIME_TO_EXT: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/heic': 'heic',
        'image/heif': 'heif',
      };
      const fileExt = MIME_TO_EXT[mimeType] ?? 'jpg';
      const storageKey = `jobs/${job.job_key}/${uuidv4()}.${fileExt}`;

      // Insert pending row
      await query(
        `INSERT INTO uploaded_media (
          job_id, storage_key, mime_type, original_filename, file_size_bytes, confirmed_at
        ) VALUES ($1, $2, $3, $4, $5, NULL)`,
        [job.id, storageKey, mimeType, filename, fileSizeBytes],
      );

      // Generate presigned URL
      const uploadUrl = await generatePresignedUploadUrl(storageKey, mimeType);

      res.status(201).json({
        uploadUrl,
        storageKey,
        expiresAt: new Date(Date.now() + 300 * 1000).toISOString(),
        correlationId,
      });
    } catch (err) {
      logger.error({ err, correlationId }, 'Failed to generate presigned URL');
      next(err);
    }
  },
);

// POST /public/photos/confirm
photosRouter.post(
  '/confirm',
  photosRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = req.correlationId || uuidv4();

    try {
      const schema = z.object({
        publicPayToken: z.string().min(1),
        storageKey: z.string().min(1),
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: parsed.error.flatten(),
          correlationId,
        });
        return;
      }

      const { publicPayToken, storageKey } = parsed.data;

      const job = await getJobByPublicPayToken(publicPayToken);
      if (!job) {
        res.status(401).json({
          error: 'INVALID_TOKEN',
          message: 'Invalid or missing public pay token.',
          correlationId,
        });
        return;
      }

      // Look up pending row
      const mediaRow = await queryOne<{ id: string; confirmed_at: Date | null }>(
        'SELECT id, confirmed_at FROM uploaded_media WHERE job_id = $1 AND storage_key = $2',
        [job.id, storageKey],
      );

      if (!mediaRow) {
        res.status(404).json({
          error: 'MEDIA_NOT_FOUND',
          message: 'Storage key not found for this job.',
          correlationId,
        });
        return;
      }

      if (mediaRow.confirmed_at !== null) {
        res.status(409).json({
          error: 'ALREADY_CONFIRMED',
          message: 'This photo has already been confirmed.',
          correlationId,
        });
        return;
      }

      // Confirm
      const updateResult = await query<{ confirmed_at: Date }>(
        'UPDATE uploaded_media SET confirmed_at = NOW() WHERE id = $1 RETURNING confirmed_at',
        [mediaRow.id],
      );

      res.status(200).json({
        mediaId: mediaRow.id,
        storageKey,
        confirmedAt: updateResult[0]?.confirmed_at.toISOString(),
        correlationId,
      });

      // Enqueue Airtable sync so photo stats are reflected in Airtable for existing records.
      // Fire-and-forget — never blocks the 200 response; failures are logged by the queue.
      enqueueAirtableSync({ jobId: job.id, correlationId }).catch((syncErr) => {
        logger.warn({ syncErr, jobId: job.id, correlationId }, 'Failed to enqueue Airtable sync after photo confirmation');
      });
    } catch (err) {
      logger.error({ err, correlationId }, 'Failed to confirm photo upload');
      next(err);
    }
  },
);
