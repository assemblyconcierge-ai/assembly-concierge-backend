/**
 * Contractor Completion Photo Routes
 *
 * GET  /public/contractor/completion/:completionToken
 *   Mobile-friendly HTML landing page. Supports 1–3 photo uploads with previews.
 *   Reserves and confirms each 1–3 photo request as a batch.
 *
 * POST /public/contractor/completion/:completionToken/presign
 *   Returns a presigned PUT URL for uploading a completion photo to R2.
 *   Inserts a pending uploaded_media row with photo_type = 'completion'.
 *
 * POST /public/contractor/completion/:completionToken/confirm
 *   Atomically marks all uploaded_media rows in the request confirmed.
 *   Multiple requests per token remain supported while the job is eligible.
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
import type { PoolClient } from 'pg';
import rateLimit from 'express-rate-limit';
import { query, queryOne, withTransaction } from '../../db/pool';
import {
  deleteStorageObject,
  generatePresignedUploadUrl,
} from '../storage/s3.service';
import { logger } from '../../common/logger';
import { config } from '../../common/config';
import { enqueueAirtableSync } from '../airtable-sync/airtableSync.queue';

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
export const MAX_COMPLETION_PHOTOS_PER_REQUEST = 3;
export const MAX_COMPLETION_PHOTOS_PER_JOB = 12;
const ACTIVE_RESERVATION_MINUTES = 10;
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

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

interface CompletionPhotoInput {
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
}

interface CompletionPhotoCounts {
  acceptedCount: number;
  activeReservationCount: number;
}

interface CompletionTokenOwnershipRow {
  job_id: string;
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

async function resolveCompletionTokenForUpdate(
  client: PoolClient,
  completionToken: string,
): Promise<CompletionAccessRow | null> {
  const result = await client.query<CompletionAccessRow>(
    `SELECT ca.id AS assignment_id, ca.job_id, j.job_key, j.status AS job_status
       FROM contractor_assignments ca
       INNER JOIN jobs j ON j.id = ca.job_id
      WHERE ca.contractor_completion_token = $1
        AND j.status = 'completion_reported'
        AND ca.status = 'completed'
      FOR UPDATE OF j`,
    [completionToken],
  );
  return result.rows[0] ?? null;
}

async function resolveCompletionTokenOwnership(
  completionToken: string,
): Promise<CompletionTokenOwnershipRow | null> {
  return queryOne<CompletionTokenOwnershipRow>(
    `SELECT job_id
       FROM contractor_assignments
      WHERE contractor_completion_token = $1`,
    [completionToken],
  );
}

async function getCompletionPhotoCounts(
  client: PoolClient,
  jobId: string,
): Promise<CompletionPhotoCounts> {
  const result = await client.query<{
    accepted_count: string;
    active_reservation_count: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE confirmed_at IS NOT NULL) AS accepted_count,
       COUNT(*) FILTER (
         WHERE confirmed_at IS NULL
           AND uploaded_at >= NOW() - ($2 * INTERVAL '1 minute')
       ) AS active_reservation_count
     FROM uploaded_media
     WHERE job_id = $1
       AND photo_type = 'completion'`,
    [jobId, ACTIVE_RESERVATION_MINUTES],
  );
  return {
    acceptedCount: parseInt(result.rows[0]?.accepted_count ?? '0', 10),
    activeReservationCount: parseInt(
      result.rows[0]?.active_reservation_count ?? '0',
      10,
    ),
  };
}

function countResponse(existingPhotoCount: number, remainingPhotoSlots: number) {
  return {
    existingPhotoCount,
    remainingPhotoSlots: Math.max(0, remainingPhotoSlots),
    maximumPhotoCount: MAX_COMPLETION_PHOTOS_PER_JOB,
  };
}

async function cleanupPendingCompletionUploads(
  jobId: string,
  storageKeys: string[],
  correlationId: string,
  throwOnDatabaseError = false,
): Promise<string[]> {
  let deletedRows: Array<{ storage_key: string }>;
  try {
    deletedRows = await query<{ storage_key: string }>(
      `DELETE FROM uploaded_media
        WHERE job_id = $1
          AND storage_key = ANY($2::text[])
          AND photo_type = 'completion'
          AND confirmed_at IS NULL
      RETURNING storage_key`,
      [jobId, storageKeys],
    );
  } catch (err) {
    logger.warn(
      { err, jobId, storageKeys, correlationId },
      '[ContractorCompletion] Failed to clean up pending completion photo rows',
    );
    if (throwOnDatabaseError) throw err;
    return [];
  }

  // Delete only keys whose still-pending rows were atomically removed. This
  // prevents a cleanup race from deleting an object confirmed by another request.
  const deleteResults = await Promise.allSettled(
    deletedRows.map((row) => deleteStorageObject(row.storage_key)),
  );
  deleteResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.warn(
        {
          err: result.reason,
          storageKey: deletedRows[index].storage_key,
          jobId,
          correlationId,
        },
        '[ContractorCompletion] Failed to clean up temporary completion photo object',
      );
    }
  });
  return deletedRows.map((row) => row.storage_key);
}

// ── GET /public/contractor/completion/:completionToken ────────────────────────
// Mobile-friendly HTML landing page with 1–3 photo upload + preview.
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
      const imgSrcOrigins = new Set<string>(["'self'", 'blob:']);
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
             letter-spacing: 0.05em; margin-bottom: 0.5rem; }
    /* Photo slots */
    .slots { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .slot { position: relative; width: 96px; height: 96px; border-radius: 8px;
            border: 2px dashed #ccc; overflow: hidden; cursor: pointer;
            background: #fafafa; display: flex; align-items: center;
            justify-content: center; flex-shrink: 0; }
    .slot img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .slot .add-icon { font-size: 2rem; color: #bbb; pointer-events: none; }
    .slot .remove-btn { position: absolute; top: 2px; right: 2px; background: rgba(0,0,0,0.55);
                        color: #fff; border: none; border-radius: 50%; width: 22px; height: 22px;
                        font-size: 0.85rem; line-height: 1; cursor: pointer; display: none;
                        align-items: center; justify-content: center; padding: 0; }
    .slot.has-file .remove-btn { display: flex; }
    .slot.has-file { border-style: solid; border-color: #188038; }
    /* Hidden file input */
    .hidden-input { display: none; }
    /* Upload button */
    #upload-btn { display: block; width: 100%; padding: 0.85rem; background: #188038;
                  color: #fff; border: none; border-radius: 8px; font-size: 1rem;
                  font-weight: 600; cursor: pointer; }
    #upload-btn:disabled { background: #aaa; cursor: not-allowed; }
    /* Progress */
    .progress-bar-wrap { background: #e0e0e0; border-radius: 4px; height: 8px;
                         margin-top: 0.75rem; display: none; }
    .progress-bar { background: #1a73e8; height: 8px; border-radius: 4px;
                    width: 0%; transition: width 0.3s; }
    /* Status */
    #status { margin-top: 0.75rem; font-size: 0.95rem; min-height: 1.5rem; }
    .status-ok { color: #188038; font-weight: 600; }
    .status-err { color: #c62828; font-weight: 600; }
    footer { text-align: center; font-size: 0.75rem; color: #aaa; margin-top: 1.5rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="label">Assembly Concierge &mdash; Completion Photos</div>
    <h1>Job <span class="badge">${jobKeyEscaped}</span></h1>
    <p style="font-size:0.9rem;color:#555;margin:0.5rem 0 0;">
      Please upload 1&ndash;3 photos showing the completed assembly work.
      Tap a slot to select a photo. Tap &times; to remove.
    </p>
  </div>

  <div class="card">
    <div class="label">Select photos (1&ndash;3)</div>
    <div class="slots" id="slots">
      <div class="slot" id="slot-0" data-index="0">
        <span class="add-icon">+</span>
        <button class="remove-btn" type="button" aria-label="Remove photo">&times;</button>
      </div>
      <div class="slot" id="slot-1" data-index="1">
        <span class="add-icon">+</span>
        <button class="remove-btn" type="button" aria-label="Remove photo">&times;</button>
      </div>
      <div class="slot" id="slot-2" data-index="2">
        <span class="add-icon">+</span>
        <button class="remove-btn" type="button" aria-label="Remove photo">&times;</button>
      </div>
    </div>
    <!-- Hidden file inputs, one per slot -->
    <input class="hidden-input" id="input-0" type="file" accept="image/jpeg,image/png,image/webp,.heic,.heif" />
    <input class="hidden-input" id="input-1" type="file" accept="image/jpeg,image/png,image/webp,.heic,.heif" />
    <input class="hidden-input" id="input-2" type="file" accept="image/jpeg,image/png,image/webp,.heic,.heif" />

    <button id="upload-btn" type="button" disabled>Upload Photos</button>
    <div class="progress-bar-wrap" id="progress-wrap">
      <div class="progress-bar" id="progress-bar"></div>
    </div>
    <div id="status"></div>
  </div>

  <footer>Assembly Concierge &mdash; Contractor Use Only &mdash; Do not share this link</footer>

  <script>
    (function () {
      // BASE is the full current pathname (includes the token).
      // presign => BASE + '/presign'
      // confirm => BASE + '/confirm'
      // This is correct because the router mounts at /public/contractor/completion
      // and the routes are /:completionToken/presign and /:completionToken/confirm.
      var BASE = location.pathname.replace(/\\/+$/, '');

      var MAX_SLOTS = 3;
      var files = [null, null, null]; // File | null per slot

      var btn = document.getElementById('upload-btn');
      var statusEl = document.getElementById('status');
      var progressWrap = document.getElementById('progress-wrap');
      var progressBar = document.getElementById('progress-bar');

      function setStatus(msg, isErr) {
        statusEl.textContent = msg;
        statusEl.className = isErr ? 'status-err' : 'status-ok';
      }

      function responseErrorMessage(body, fallback) {
        var message = body && body.message ? body.message : fallback;
        if (
          body &&
          typeof body.existingPhotoCount === 'number' &&
          typeof body.remainingPhotoSlots === 'number' &&
          typeof body.maximumPhotoCount === 'number'
        ) {
          message += ' Current photos: ' + body.existingPhotoCount +
            '; remaining slots: ' + body.remainingPhotoSlots +
            '; maximum: ' + body.maximumPhotoCount + '.';
        }
        return message;
      }

      function updateBtn() {
        var hasAny = files.some(function(f) { return f !== null; });
        btn.disabled = !hasAny;
      }

      function setSlotPreview(idx, file) {
        var slot = document.getElementById('slot-' + idx);
        // Remove existing img if any
        var existingImg = slot.querySelector('img');
        if (existingImg) slot.removeChild(existingImg);
        if (file) {
          var img = document.createElement('img');
          img.src = URL.createObjectURL(file);
          img.alt = 'Photo ' + (idx + 1);
          slot.insertBefore(img, slot.firstChild);
          slot.classList.add('has-file');
        } else {
          slot.classList.remove('has-file');
        }
      }

      // Wire up each slot: click slot => open file picker
      for (var i = 0; i < MAX_SLOTS; i++) {
        (function(idx) {
          var slot = document.getElementById('slot-' + idx);
          var input = document.getElementById('input-' + idx);
          var removeBtn = slot.querySelector('.remove-btn');

          slot.addEventListener('click', function(e) {
            if (e.target === removeBtn || removeBtn.contains(e.target)) return;
            input.click();
          });

          input.addEventListener('change', function() {
            var f = input.files && input.files[0];
            files[idx] = f || null;
            setSlotPreview(idx, files[idx]);
            updateBtn();
            // Reset input so re-selecting same file fires change again
            input.value = '';
          });

          removeBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            files[idx] = null;
            setSlotPreview(idx, null);
            updateBtn();
          });
        })(i);
      }

      async function reserveUploads(selectedFiles) {
        var presignRes = await fetch(BASE + '/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: selectedFiles.map(function(file) {
              return {
                filename: file.name,
                mimeType: file.type || 'image/jpeg',
                fileSizeBytes: file.size
              };
            })
          })
        });
        if (!presignRes.ok) {
          var errBody = await presignRes.json().catch(function() { return {}; });
          throw new Error(
            responseErrorMessage(errBody, 'Presign failed: ' + presignRes.status)
          );
        }
        return presignRes.json();
      }

      // Upload one file to its server-generated storage object.
      async function uploadOne(file, upload, progressStart, progressEnd) {
        // NOTE: If R2 bucket CORS is not configured to allow PUT from this origin,
        // the browser will block the preflight and fetch() will throw a TypeError
        // (network error), not return a non-ok response. That case is caught below.
        var putRes;
        try {
          putRes = await fetch(upload.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': file.type || 'image/jpeg' },
            body: file
          });
        } catch (networkErr) {
          // fetch() throws on network failure or CORS preflight block.
          // This is the most likely symptom of a missing R2 CORS rule.
          throw new Error(
            'Upload blocked (network error). ' +
            'This is usually caused by a missing CORS rule on the R2 bucket. ' +
            'Error: ' + (networkErr && networkErr.message ? networkErr.message : String(networkErr))
          );
        }
        if (!putRes.ok) {
          var putErrText = '';
          try { putErrText = await putRes.text(); } catch (_) {}
          throw new Error(
            'Storage upload failed (HTTP ' + putRes.status + '). ' +
            (putErrText ? putErrText.slice(0, 300) : 'No response body.')
          );
        }
        progressBar.style.width = progressEnd + '%';
      }

      async function confirmUploads(storageKeys) {
        var confirmRes = await fetch(BASE + '/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storageKeys: storageKeys })
        });
        if (!confirmRes.ok) {
          var cErrBody = await confirmRes.json().catch(function() { return {}; });
          throw new Error(
            responseErrorMessage(cErrBody, 'Confirm failed: ' + confirmRes.status)
          );
        }
        return confirmRes.json();
      }

      async function cancelReservation(storageKeys) {
        if (!storageKeys || storageKeys.length === 0) return;
        try {
          await fetch(BASE + '/cancel-reservation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storageKeys: storageKeys }),
            keepalive: true
          });
        } catch (_) {
          // Best effort only. The 10-minute reservation expiry remains the
          // fallback when the browser cannot reach the backend.
        }
      }

      btn.addEventListener('click', async function () {
        var selectedFiles = files.filter(function(f) { return f !== null; });
        if (selectedFiles.length === 0) {
          setStatus('Please select at least one photo.', true);
          return;
        }

        btn.disabled = true;
        progressWrap.style.display = 'block';
        progressBar.style.width = '0%';
        setStatus('Uploading ' + selectedFiles.length + ' photo' + (selectedFiles.length > 1 ? 's' : '') + '\u2026', false);

        var reservedStorageKeys = [];
        try {
          var reservation = await reserveUploads(selectedFiles);
          var uploads = reservation.uploads || [];
          reservedStorageKeys = uploads.map(function(upload) {
            return upload.storageKey;
          });
          if (uploads.length !== selectedFiles.length) {
            throw new Error('Unable to reserve all selected photos. Please try again.');
          }

          var step = Math.floor(100 / selectedFiles.length);
          for (var i = 0; i < selectedFiles.length; i++) {
            var start = i * step;
            var end = (i === selectedFiles.length - 1) ? 100 : (i + 1) * step;
            setStatus('Uploading photo ' + (i + 1) + ' of ' + selectedFiles.length + '\u2026', false);
            await uploadOne(selectedFiles[i], uploads[i], start, end);
          }

          var confirmation = await confirmUploads(
            reservedStorageKeys
          );
          reservedStorageKeys = [];
          progressBar.style.width = '100%';
          setStatus(
            'Completion photos uploaded. ' +
            confirmation.existingPhotoCount + ' of ' + confirmation.maximumPhotoCount +
            ' photos saved; ' + confirmation.remainingPhotoSlots + ' slots remaining.',
            false
          );
          // Clear all slots after success
          for (var j = 0; j < MAX_SLOTS; j++) {
            files[j] = null;
            setSlotPreview(j, null);
          }
          btn.disabled = true;
        } catch (err) {
          await cancelReservation(reservedStorageKeys);
          setStatus(err.message || 'Unexpected error. Please check your connection and try again.', true);
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
      const fileSchema = z.object({
        filename: z.string().min(1),
        mimeType: z.string().min(1),
        fileSizeBytes: z.number().int().positive(),
      });
      const schema = z.union([
        z.object({ files: z.array(fileSchema).min(1).max(50) }),
        fileSchema,
      ]);
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
      const legacyRequest = 'filename' in parsed.data;
      const files: CompletionPhotoInput[] = 'filename' in parsed.data
        ? [parsed.data]
        : parsed.data.files;

      // 3. Validate MIME type
      if (files.some((file) => !ALLOWED_MIME_TYPES.has(file.mimeType))) {
        res.status(400).json({
          error: 'UNSUPPORTED_MIME_TYPE',
          message: 'Unsupported file type. Allowed types: jpeg, png, webp, heic, heif.',
          correlationId,
        });
        return;
      }

      // 4. Validate file size
      if (files.some((file) => file.fileSizeBytes > MAX_FILE_SIZE_BYTES)) {
        res.status(400).json({
          error: 'FILE_TOO_LARGE',
          message: 'File exceeds the 20MB limit.',
          correlationId,
        });
        return;
      }

      // 5. Validate eligibility, reserve capacity, and insert pending rows atomically.
      const reservation = await withTransaction(async (client) => {
        const access = await resolveCompletionTokenForUpdate(client, completionToken);
        if (!access) return { kind: 'not_found' as const };

        const counts = await getCompletionPhotoCounts(client, access.job_id);
        const availableBeforeRequest = Math.max(
          0,
          MAX_COMPLETION_PHOTOS_PER_JOB
            - counts.acceptedCount
            - counts.activeReservationCount,
        );
        const responseCounts = countResponse(
          counts.acceptedCount,
          availableBeforeRequest,
        );

        if (files.length > MAX_COMPLETION_PHOTOS_PER_REQUEST) {
          return { kind: 'too_many_files' as const, ...responseCounts };
        }
        if (files.length > availableBeforeRequest) {
          return { kind: 'limit_reached' as const, ...responseCounts };
        }

        const reservedUploads = files.map((file, index) => {
          const fileExt = MIME_TO_EXT[file.mimeType] ?? 'jpg';
          const objectFilename =
            `completion-${access.job_id}-${uuidv4()}-${index + 1}.${fileExt}`;
          return {
            file,
            storageKey: `jobs/${access.job_key}/completion/${objectFilename}`,
          };
        });

        for (const upload of reservedUploads) {
          await client.query(
            `INSERT INTO uploaded_media (
               job_id, storage_key, mime_type, original_filename, file_size_bytes,
               photo_type, confirmed_at
             ) VALUES ($1, $2, $3, $4, $5, 'completion', NULL)`,
            [
              access.job_id,
              upload.storageKey,
              upload.file.mimeType,
              upload.file.filename,
              upload.file.fileSizeBytes,
            ],
          );
        }

        return {
          kind: 'success' as const,
          access,
          reservedUploads,
          ...countResponse(
            counts.acceptedCount,
            availableBeforeRequest - files.length,
          ),
        };
      });

      if (reservation.kind === 'not_found') {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' });
        return;
      }
      if (reservation.kind === 'too_many_files') {
        res.status(400).json({
          error: 'TOO_MANY_FILES',
          message:
            `Upload no more than ${MAX_COMPLETION_PHOTOS_PER_REQUEST} photos at a time.`,
          maximumPhotosPerRequest: MAX_COMPLETION_PHOTOS_PER_REQUEST,
          existingPhotoCount: reservation.existingPhotoCount,
          remainingPhotoSlots: reservation.remainingPhotoSlots,
          maximumPhotoCount: reservation.maximumPhotoCount,
          correlationId,
        });
        return;
      }
      if (reservation.kind === 'limit_reached') {
        res.status(409).json({
          error: 'UPLOAD_LIMIT_REACHED',
          message:
            `This upload would exceed the maximum of ` +
            `${MAX_COMPLETION_PHOTOS_PER_JOB} completion photos for this job.`,
          existingPhotoCount: reservation.existingPhotoCount,
          remainingPhotoSlots: reservation.remainingPhotoSlots,
          maximumPhotoCount: reservation.maximumPhotoCount,
          correlationId,
        });
        return;
      }

      // 6. Generate presigned URLs only after the reservation transaction commits.
      let uploads: Array<{ uploadUrl: string; storageKey: string }>;
      try {
        uploads = await Promise.all(
          reservation.reservedUploads.map(async (upload) => ({
            uploadUrl: await generatePresignedUploadUrl(
              upload.storageKey,
              upload.file.mimeType,
            ),
            storageKey: upload.storageKey,
          })),
        );
      } catch (err) {
        await cleanupPendingCompletionUploads(
          reservation.access.job_id,
          reservation.reservedUploads.map((upload) => upload.storageKey),
          correlationId,
        );
        throw err;
      }

      const responseBody: Record<string, unknown> = {
        uploads,
        expiresAt: new Date(Date.now() + 300 * 1000).toISOString(),
        existingPhotoCount: reservation.existingPhotoCount,
        remainingPhotoSlots: reservation.remainingPhotoSlots,
        maximumPhotoCount: reservation.maximumPhotoCount,
        correlationId,
      };
      if (legacyRequest) {
        responseBody.uploadUrl = uploads[0].uploadUrl;
        responseBody.storageKey = uploads[0].storageKey;
      }
      res.status(201).json(responseBody);
    } catch (err) {
      logger.error(
        { err, correlationId },
        '[ContractorCompletion] Failed to generate presigned URL',
      );
      next(err);
    }
  },
);

// ── POST /public/contractor/completion/:completionToken/cancel-reservation ───
contractorCompletionRouter.post(
  '/:completionToken/cancel-reservation',
  completionRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId =
      (req as Request & { correlationId?: string }).correlationId ?? 'unknown';
    try {
      const { completionToken } = req.params;
      if (!completionToken || !COMPLETION_TOKEN_RE.test(completionToken)) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' });
        return;
      }

      const schema = z.object({
        storageKeys: z.array(z.string().min(1))
          .min(1)
          .max(MAX_COMPLETION_PHOTOS_PER_REQUEST),
      }).strict();
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

      const { storageKeys } = parsed.data;
      if (new Set(storageKeys).size !== storageKeys.length) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Each storage key may appear only once per request.',
          correlationId,
        });
        return;
      }

      // Token ownership is sufficient for cleanup even if the job became
      // ineligible after the reservation was issued.
      const ownership = await resolveCompletionTokenOwnership(completionToken);
      if (!ownership) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' });
        return;
      }

      const cancelledStorageKeys = await cleanupPendingCompletionUploads(
        ownership.job_id,
        storageKeys,
        correlationId,
        true,
      );
      res.status(200).json({
        cancelledStorageKeys,
        cancelledCount: cancelledStorageKeys.length,
        correlationId,
      });
    } catch (err) {
      logger.error(
        { err, correlationId },
        '[ContractorCompletion] Failed to cancel completion photo reservation',
      );
      next(err);
    }
  },
);

// ── POST /public/contractor/completion/:completionToken/confirm ───────────────
// Each call confirms one batch of 1–3 storage keys. Multiple calls per token are
// supported while the job and completed assignment remain eligible.
contractorCompletionRouter.post(
  '/:completionToken/confirm',
  completionRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId =
      (req as Request & { correlationId?: string }).correlationId ?? 'unknown';
    let cleanupJobId: string | null = null;
    let cleanupStorageKeys: string[] = [];
    try {
      const { completionToken } = req.params;

      // 1. Validate token format
      if (!completionToken || !COMPLETION_TOKEN_RE.test(completionToken)) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' });
        return;
      }

      // 2. Validate request body
      const schema = z.union([
        z.object({ storageKeys: z.array(z.string().min(1)).min(1).max(50) }),
        z.object({ storageKey: z.string().min(1) }),
      ]);
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
      const legacyRequest = 'storageKey' in parsed.data;
      const storageKeys = 'storageKey' in parsed.data
        ? [parsed.data.storageKey]
        : parsed.data.storageKeys;
      if (new Set(storageKeys).size !== storageKeys.length) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Each storage key may appear only once per request.',
          correlationId,
        });
        return;
      }

      // 3. Revalidate eligibility and atomically confirm the whole batch.
      const confirmation = await withTransaction(async (client) => {
        const access = await resolveCompletionTokenForUpdate(client, completionToken);
        if (!access) return { kind: 'not_found' as const };

        const counts = await getCompletionPhotoCounts(client, access.job_id);
        const responseCounts = countResponse(
          counts.acceptedCount,
          MAX_COMPLETION_PHOTOS_PER_JOB - counts.acceptedCount,
        );
        if (storageKeys.length > MAX_COMPLETION_PHOTOS_PER_REQUEST) {
          return { kind: 'too_many_files' as const, ...responseCounts };
        }

        const mediaResult = await client.query<{
          id: string;
          storage_key: string;
          confirmed_at: Date | null;
        }>(
          `SELECT id, storage_key, confirmed_at
             FROM uploaded_media
            WHERE job_id = $1
              AND storage_key = ANY($2::text[])
              AND photo_type = 'completion'
            FOR UPDATE`,
          [access.job_id, storageKeys],
        );

        if (mediaResult.rows.length !== storageKeys.length) {
          return { kind: 'media_not_found' as const, ...responseCounts };
        }
        if (mediaResult.rows.some((row) => row.confirmed_at !== null)) {
          return { kind: 'already_confirmed' as const, ...responseCounts };
        }

        cleanupJobId = access.job_id;
        cleanupStorageKeys = storageKeys;

        if (
          counts.acceptedCount + storageKeys.length
          > MAX_COMPLETION_PHOTOS_PER_JOB
        ) {
          return { kind: 'limit_reached' as const, access, ...responseCounts };
        }

        const mediaIds = mediaResult.rows.map((row) => row.id);
        const updateResult = await client.query<{
          id: string;
          storage_key: string;
          confirmed_at: Date;
        }>(
          `UPDATE uploaded_media
              SET confirmed_at = NOW()
            WHERE id = ANY($1::uuid[])
              AND confirmed_at IS NULL
          RETURNING id, storage_key, confirmed_at`,
          [mediaIds],
        );
        if (updateResult.rows.length !== storageKeys.length) {
          throw new Error('Completion photo batch confirmation was not atomic.');
        }

        return {
          kind: 'success' as const,
          access,
          confirmedRows: updateResult.rows,
          ...countResponse(
            counts.acceptedCount + storageKeys.length,
            MAX_COMPLETION_PHOTOS_PER_JOB
              - counts.acceptedCount
              - storageKeys.length,
          ),
        };
      });

      if (confirmation.kind === 'not_found') {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' });
        return;
      }
      if (confirmation.kind === 'too_many_files') {
        res.status(400).json({
          error: 'TOO_MANY_FILES',
          message:
            `Confirm no more than ${MAX_COMPLETION_PHOTOS_PER_REQUEST} photos at a time.`,
          maximumPhotosPerRequest: MAX_COMPLETION_PHOTOS_PER_REQUEST,
          existingPhotoCount: confirmation.existingPhotoCount,
          remainingPhotoSlots: confirmation.remainingPhotoSlots,
          maximumPhotoCount: confirmation.maximumPhotoCount,
          correlationId,
        });
        return;
      }
      if (confirmation.kind === 'media_not_found') {
        res.status(404).json({
          error: 'MEDIA_NOT_FOUND',
          message: 'One or more storage keys were not found for this job.',
          existingPhotoCount: confirmation.existingPhotoCount,
          remainingPhotoSlots: confirmation.remainingPhotoSlots,
          maximumPhotoCount: confirmation.maximumPhotoCount,
          correlationId,
        });
        return;
      }
      if (confirmation.kind === 'already_confirmed') {
        res.status(409).json({
          error: 'ALREADY_CONFIRMED',
          message: 'One or more photos have already been confirmed.',
          existingPhotoCount: confirmation.existingPhotoCount,
          remainingPhotoSlots: confirmation.remainingPhotoSlots,
          maximumPhotoCount: confirmation.maximumPhotoCount,
          correlationId,
        });
        return;
      }
      if (confirmation.kind === 'limit_reached') {
        await cleanupPendingCompletionUploads(
          confirmation.access.job_id,
          storageKeys,
          correlationId,
        );
        cleanupJobId = null;
        cleanupStorageKeys = [];
        res.status(409).json({
          error: 'UPLOAD_LIMIT_REACHED',
          message:
            `This upload would exceed the maximum of ` +
            `${MAX_COMPLETION_PHOTOS_PER_JOB} completion photos for this job.`,
          existingPhotoCount: confirmation.existingPhotoCount,
          remainingPhotoSlots: confirmation.remainingPhotoSlots,
          maximumPhotoCount: confirmation.maximumPhotoCount,
          correlationId,
        });
        return;
      }

      // 4. Respond only after the entire confirmation transaction succeeds.
      const responseBody: Record<string, unknown> = {
        mediaIds: confirmation.confirmedRows.map((row) => row.id),
        storageKeys: confirmation.confirmedRows.map((row) => row.storage_key),
        confirmedAt: confirmation.confirmedRows[0]?.confirmed_at.toISOString(),
        existingPhotoCount: confirmation.existingPhotoCount,
        remainingPhotoSlots: confirmation.remainingPhotoSlots,
        maximumPhotoCount: confirmation.maximumPhotoCount,
        correlationId,
      };
      if (legacyRequest) {
        responseBody.mediaId = confirmation.confirmedRows[0].id;
        responseBody.storageKey = confirmation.confirmedRows[0].storage_key;
      }
      res.status(200).json(responseBody);
      cleanupJobId = null;
      cleanupStorageKeys = [];

      // Enqueue Airtable sync so completion photo stats are reflected in Airtable.
      // Fire-and-forget — never blocks the 200 response; failures are logged by the queue.
      enqueueAirtableSync({
        jobId: confirmation.access.job_id,
        correlationId,
      }).catch((syncErr) => {
        logger.warn(
          { syncErr, jobId: confirmation.access.job_id, correlationId },
          '[ContractorCompletion] Failed to enqueue Airtable sync after completion photo confirmation',
        );
      });
    } catch (err) {
      if (cleanupJobId && cleanupStorageKeys.length > 0) {
        await cleanupPendingCompletionUploads(
          cleanupJobId,
          cleanupStorageKeys,
          correlationId,
        );
      }
      logger.error(
        { err, correlationId },
        '[ContractorCompletion] Failed to confirm photo upload',
      );
      next(err);
    }
  },
);
