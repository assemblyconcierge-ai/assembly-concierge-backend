/**
 * Contractor Completion Photo Routes
 *
 * GET  /public/contractor/completion/:completionToken
 *   Mobile-friendly HTML landing page with file picker. Calls presign + confirm via JS.
 *
 * POST /public/contractor/completion/:completionToken/presign
 *   Returns a presigned PUT URL for uploading a completion photo to R2.
 *   Inserts a pending uploaded_media row with photo_type = 'completion'.
 *
 * POST /public/contractor/completion/:completionToken/confirm
 *   Marks the uploaded_media row confirmed (sets confirmed_at = NOW()).
 *
 * Security:
 * - Token format validated before any DB query.
 * - Generic 404 for invalid token, unknown token, wrong job/assignment state.
 * - contractor_completion_token value is NEVER rendered in HTML output.
 * - photo_type = 'completion' is explicitly set on INSERT (not relying on DEFAULT).
 * - Cache-Control: no-store to prevent proxy/browser caching.
 * - Scoped CSP on the HTML page.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import { query, queryOne } from '../../db/pool';
import { generatePresignedUploadUrl } from '../storage/s3.service';
import { logger } from '../../common/logger';
import { config } from '../../common/config';

export const contractorCompletionRouter = Router();

// ── Token format guard ────────────────────────────────────────────────────────
const COMPLETION_TOKEN_RE = /^cct_[a-f0-9]{32}$/;

// ── Constants ─────────────────────────────────────────────────────────────────
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_COMPLETION_PHOTOS = 20;

// ── Rate limiter ──────────────────────────────────────────────────────────────
const completionRateLimiter = rateLimit({
  windowMs: 60_000,
  max: config.NODE_ENV === 'test' ? 1_000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: 'RATE_LIMITED',
      message: 'Too many requests. Please try again later.',
    });
  },
});

// ── HTML helper ───────────────────────────────────────────────────────────────
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Access check helper ───────────────────────────────────────────────────────
interface CompletionAccessRow {
  assignment_id: string;
  job_id: string;
  job_key: string;
  job_status: string;
}

async function resolveCompletionToken(
  completionToken: string,
): Promise<CompletionAccessRow | null> {
  return queryOne<CompletionAccessRow>(
    `SELECT ca.id AS assignment_id, ca.job_id, j.job_key, j.status AS job_status
       FROM contractor_assignments ca
       INNER JOIN jobs j ON j.id = ca.job_id
      WHERE ca.contractor_completion_token = $1
        AND j.status = 'completion_reported'
        AND ca.status = 'completed'`,
    [completionToken],
  );
}

// ── GET /public/contractor/completion/:completionToken ────────────────────────
// Mobile-friendly HTML landing page with file picker.
// The completion token is NOT rendered anywhere in the HTML output.
contractorCompletionRouter.get(
  '/:completionToken',
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId =
      (req as Request & { correlationId?: string }).correlationId ?? 'unknown';
    try {
      const { completionToken } = req.params;

      // 1. Validate token format
      if (!completionToken || !COMPLETION_TOKEN_RE.test(completionToken)) {
        res.status(404).send('Not found');
        return;
      }

      // 2. Validate token in DB (generic 404 for all failure cases)
      const access = await resolveCompletionToken(completionToken);
      if (!access) {
        res.status(404).send('Not found');
        return;
      }

      // 3. Build HTML — completion token is NOT embedded anywhere
      const jobKeyEscaped = escapeHtml(access.job_key);

      // Build CSP img-src origins
      const imgSrcOrigins = new Set<string>(["'self'"]);
      try {
        if (config.STORAGE_ENDPOINT) {
          const endpointUrl = new URL(config.STORAGE_ENDPOINT);
          imgSrcOrigins.add(endpointUrl.origin);
          if (
            config.STORAGE_BUCKET &&
            endpointUrl.hostname.endsWith('.r2.cloudflarestorage.com')
          ) {
            imgSrcOrigins.add(
              `${endpointUrl.protocol}//${config.STORAGE_BUCKET}.${endpointUrl.hostname}`,
            );
          }
        }
      } catch {
        // Malformed endpoint — omit external origins
      }
      const imgSrc = [...imgSrcOrigins].join(' ');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Upload Completion Photos &mdash; ${jobKeyEscaped}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f5f5f5; color: #1a1a1a; margin: 0; padding: 1rem; }
    .card { background: #fff; border-radius: 10px; padding: 1.25rem;
            margin-bottom: 1rem; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    h1 { font-size: 1.2rem; margin: 0 0 0.25rem; }
    .badge { background: #1a1a2e; color: #fff; padding: 0.2rem 0.6rem;
             border-radius: 4px; font-size: 0.85rem; font-family: monospace; }
    .label { font-size: 0.8rem; color: #666; text-transform: uppercase;
             letter-spacing: 0.05em; margin-bottom: 0.15rem; }
    #file-input { display: block; width: 100%; margin: 0.75rem 0; font-size: 1rem; }
    #upload-btn { display: block; width: 100%; padding: 0.85rem; background: #188038;
                  color: #fff; border: none; border-radius: 8px; font-size: 1rem;
                  font-weight: 600; cursor: pointer; }
    #upload-btn:disabled { background: #aaa; cursor: not-allowed; }
    #status { margin-top: 1rem; font-size: 0.95rem; min-height: 1.5rem; }
    .status-ok { color: #188038; font-weight: 600; }
    .status-err { color: #c62828; font-weight: 600; }
    .progress-bar-wrap { background: #e0e0e0; border-radius: 4px; height: 8px;
                         margin-top: 0.5rem; display: none; }
    .progress-bar { background: #1a73e8; height: 8px; border-radius: 4px;
                    width: 0%; transition: width 0.2s; }
    footer { text-align: center; font-size: 0.75rem; color: #aaa; margin-top: 1.5rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="label">Assembly Concierge &mdash; Completion Photos</div>
    <h1>Job <span class="badge">${jobKeyEscaped}</span></h1>
    <p style="font-size:0.9rem;color:#555;margin:0.5rem 0 0;">
      Please upload photos showing the completed assembly work.
      You can upload multiple photos one at a time.
    </p>
  </div>

  <div class="card">
    <div class="label">Select a photo</div>
    <input id="file-input" type="file" accept="image/jpeg,image/png,image/webp,.heic,.heif" />
    <button id="upload-btn" type="button">Upload Photo</button>
    <div class="progress-bar-wrap" id="progress-wrap">
      <div class="progress-bar" id="progress-bar"></div>
    </div>
    <div id="status"></div>
  </div>

  <footer>Assembly Concierge &mdash; Contractor Use Only &mdash; Do not share this link</footer>

  <script>
    (function () {
      var TOKEN = location.pathname.split('/').pop();
      var BASE = location.pathname.replace(/\\/[^\\/]*$/, '');
      var btn = document.getElementById('upload-btn');
      var fileInput = document.getElementById('file-input');
      var statusEl = document.getElementById('status');
      var progressWrap = document.getElementById('progress-wrap');
      var progressBar = document.getElementById('progress-bar');

      function setStatus(msg, isErr) {
        statusEl.textContent = msg;
        statusEl.className = isErr ? 'status-err' : 'status-ok';
      }

      btn.addEventListener('click', async function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) { setStatus('Please select a photo first.', true); return; }

        btn.disabled = true;
        progressWrap.style.display = 'block';
        progressBar.style.width = '0%';
        setStatus('Preparing upload\u2026', false);

        try {
          // Step 1: presign
          var presignRes = await fetch(BASE + '/presign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: file.name,
              mimeType: file.type || 'image/jpeg',
              fileSizeBytes: file.size
            })
          });
          if (!presignRes.ok) {
            var errBody = await presignRes.json().catch(function(){ return {}; });
            setStatus('Upload failed: ' + (errBody.message || presignRes.status), true);
            btn.disabled = false;
            return;
          }
          var presignData = await presignRes.json();
          progressBar.style.width = '30%';
          setStatus('Uploading photo\u2026', false);

          // Step 2: PUT to R2
          var putRes = await fetch(presignData.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': file.type || 'image/jpeg' },
            body: file
          });
          if (!putRes.ok) {
            setStatus('Upload to storage failed (' + putRes.status + '). Please try again.', true);
            btn.disabled = false;
            return;
          }
          progressBar.style.width = '75%';
          setStatus('Confirming upload\u2026', false);

          // Step 3: confirm
          var confirmRes = await fetch(BASE + '/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storageKey: presignData.storageKey })
          });
          if (!confirmRes.ok) {
            var cErrBody = await confirmRes.json().catch(function(){ return {}; });
            setStatus('Confirmation failed: ' + (cErrBody.message || confirmRes.status), true);
            btn.disabled = false;
            return;
          }
          progressBar.style.width = '100%';
          setStatus('Photo uploaded successfully! You can upload another photo.', false);
          fileInput.value = '';
        } catch (err) {
          setStatus('Unexpected error. Please check your connection and try again.', true);
        } finally {
          btn.disabled = false;
        }
      });
    })();
  </script>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' *; frame-ancestors 'none';`,
      );
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('X-Frame-Options', 'DENY');
      res.status(200).send(html);
    } catch (err) {
      logger.error(
        { err, correlationId },
        '[ContractorCompletion] Failed to render landing page',
      );
      next(err);
    }
  },
);

// ── POST /public/contractor/completion/:completionToken/presign ───────────────
contractorCompletionRouter.post(
  '/:completionToken/presign',
  completionRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId =
      (req as Request & { correlationId?: string }).correlationId ?? 'unknown';
    try {
      const { completionToken } = req.params;

      // 1. Validate token format
      if (!completionToken || !COMPLETION_TOKEN_RE.test(completionToken)) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' });
        return;
      }

      // 2. Validate request body
      const schema = z.object({
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
      const { filename, mimeType, fileSizeBytes } = parsed.data;

      // 3. Validate MIME type
      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        res.status(400).json({
          error: 'UNSUPPORTED_MIME_TYPE',
          message: 'Unsupported file type. Allowed types: jpeg, png, webp, heic, heif.',
          correlationId,
        });
        return;
      }

      // 4. Validate file size
      if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
        res.status(400).json({
          error: 'FILE_TOO_LARGE',
          message: 'File exceeds the 20MB limit.',
          correlationId,
        });
        return;
      }

      // 5. Validate token in DB (generic 404 for all failure cases)
      const access = await resolveCompletionToken(completionToken);
      if (!access) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' });
        return;
      }

      // 6. Check completion photo count
      const countResult = await query<{ count: string }>(
        `SELECT COUNT(*) AS count
           FROM uploaded_media
          WHERE job_id = $1 AND photo_type = 'completion'`,
        [access.job_id],
      );
      const currentCount = parseInt(countResult[0]?.count ?? '0', 10);
      if (currentCount >= MAX_COMPLETION_PHOTOS) {
        res.status(409).json({
          error: 'UPLOAD_LIMIT_REACHED',
          message: `Maximum of ${MAX_COMPLETION_PHOTOS} completion photos allowed per job.`,
          correlationId,
        });
        return;
      }

      // 7. Generate storage key
      const MIME_TO_EXT: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/heic': 'heic',
        'image/heif': 'heif',
      };
      const fileExt = MIME_TO_EXT[mimeType] ?? 'jpg';
      const storageKey = `jobs/${access.job_key}/completion/${uuidv4()}.${fileExt}`;

      // 8. Insert pending row — photo_type = 'completion' explicitly set
      await query(
        `INSERT INTO uploaded_media (
           job_id, storage_key, mime_type, original_filename, file_size_bytes,
           photo_type, confirmed_at
         ) VALUES ($1, $2, $3, $4, $5, 'completion', NULL)`,
        [access.job_id, storageKey, mimeType, filename, fileSizeBytes],
      );

      // 9. Generate presigned upload URL
      const uploadUrl = await generatePresignedUploadUrl(storageKey, mimeType);

      res.status(201).json({
        uploadUrl,
        storageKey,
        expiresAt: new Date(Date.now() + 300 * 1000).toISOString(),
        correlationId,
      });
    } catch (err) {
      logger.error(
        { err, correlationId },
        '[ContractorCompletion] Failed to generate presigned URL',
      );
      next(err);
    }
  },
);

// ── POST /public/contractor/completion/:completionToken/confirm ───────────────
contractorCompletionRouter.post(
  '/:completionToken/confirm',
  completionRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId =
      (req as Request & { correlationId?: string }).correlationId ?? 'unknown';
    try {
      const { completionToken } = req.params;

      // 1. Validate token format
      if (!completionToken || !COMPLETION_TOKEN_RE.test(completionToken)) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' });
        return;
      }

      // 2. Validate request body
      const schema = z.object({
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
      const { storageKey } = parsed.data;

      // 3. Validate token in DB (generic 404 for all failure cases)
      const access = await resolveCompletionToken(completionToken);
      if (!access) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' });
        return;
      }

      // 4. Look up pending media row (must belong to this job, must be completion type)
      const mediaRow = await queryOne<{ id: string; confirmed_at: Date | null }>(
        `SELECT id, confirmed_at
           FROM uploaded_media
          WHERE job_id = $1
            AND storage_key = $2
            AND photo_type = 'completion'`,
        [access.job_id, storageKey],
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

      // 5. Confirm
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
    } catch (err) {
      logger.error(
        { err, correlationId },
        '[ContractorCompletion] Failed to confirm photo upload',
      );
      next(err);
    }
  },
);
