import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../common/config';
import { logger } from '../../common/logger';

// Lazy initialization so it doesn't throw at startup if env vars are missing
let s3Client: S3Client | null = null;

function getClient(): S3Client {
  if (s3Client) return s3Client;

  if (
    !config.STORAGE_ENDPOINT ||
    !config.STORAGE_ACCESS_KEY ||
    !config.STORAGE_SECRET_KEY
  ) {
    throw new Error('Storage configuration is incomplete. Missing endpoint or credentials.');
  }

  s3Client = new S3Client({
    region: 'auto', // R2 uses 'auto'
    endpoint: config.STORAGE_ENDPOINT,
    credentials: {
      accessKeyId: config.STORAGE_ACCESS_KEY,
      secretAccessKey: config.STORAGE_SECRET_KEY,
    },
  });

  return s3Client;
}

export async function generatePresignedUploadUrl(
  storageKey: string,
  mimeType: string,
  expiresInSeconds = 300,
): Promise<string> {
  if (!config.STORAGE_BUCKET) {
    throw new Error('STORAGE_BUCKET is not configured.');
  }

  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: config.STORAGE_BUCKET,
    Key: storageKey,
    ContentType: mimeType,
  });

  try {
    const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    return url;
  } catch (err) {
    logger.error({ err, storageKey }, 'Failed to generate presigned upload URL');
    throw new Error('Failed to generate upload URL');
  }
}

/**
 * Generate a short-lived presigned GET URL for a private R2 object.
 * MUST NOT be stored anywhere — generated at request time only.
 * MUST NOT be logged.
 */
export async function generatePresignedDownloadUrl(
  storageKey: string,
  expiresInSeconds = 3600,
): Promise<string> {
  if (!config.STORAGE_BUCKET) {
    throw new Error('STORAGE_BUCKET is not configured.');
  }

  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: config.STORAGE_BUCKET,
    Key: storageKey,
  });

  try {
    const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    // Intentionally not logging the URL — it is a bearer credential
    return url;
  } catch (err) {
    logger.error({ err, storageKey }, 'Failed to generate presigned download URL');
    throw new Error('Failed to generate download URL');
  }
}
