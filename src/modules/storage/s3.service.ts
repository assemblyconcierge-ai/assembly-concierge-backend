import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
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
