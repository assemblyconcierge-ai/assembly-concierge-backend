import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import { query, queryOne } from '../../db/pool';
import { getJobByPublicPayToken } from '../jobs/job.repository';
import { generatePresignedUploadUrl } from '../storage/s3.service';
import { logger } from '../../common/logger';
import { config } from '../../common/config';

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
    } catch (err) {
      logger.error({ err, correlationId }, 'Failed to confirm photo upload');
      next(err);
    }
  },
);
