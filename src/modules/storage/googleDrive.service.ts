/**
 * Google Drive Service
 *
 * Provides folder creation/reuse and file upload operations using a
 * Google Service Account. Credentials are loaded from the
 * GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 environment variable (base64-encoded
 * service account JSON key).
 *
 * All Drive API calls include supportsAllDrives: true and, where applicable,
 * includeItemsFromAllDrives: true so that Shared Drive folders are accessible.
 *
 * File downloads are validated before upload:
 *   - HTTP status must be 200.
 *   - Content-Type must not be text/html or application/json (login/error pages).
 *   - Response body must not begin with an HTML doctype or tag.
 *   - Response body must be at least MIN_FILE_BYTES in size.
 * Any validation failure throws a descriptive error; the file is never uploaded.
 *
 * Files are never stored in Postgres — only Drive file IDs and web-view URLs
 * are returned to callers for metadata persistence.
 */

import { Readable } from 'stream';
import { google } from 'googleapis';
import { config } from '../../common/config';
import { logger } from '../../common/logger';

// ── Constants ──────────────────────────────────────────────────────────────

/** Minimum acceptable file size in bytes. Responses smaller than this are
 *  almost certainly error pages or empty bodies. */
const MIN_FILE_BYTES = 512;

/** Content-Type prefixes that indicate a non-file response (login page, API
 *  error, redirect page, etc.). Checked case-insensitively. */
const REJECTED_CONTENT_TYPES = ['text/html', 'application/json', 'text/plain'];

// ── Types ──────────────────────────────────────────────────────────────────

export interface DriveFile {
  id: string;
  webViewLink: string;
}

export interface DriveFolder {
  id: string;
  webViewLink: string;
}

// ── Auth ───────────────────────────────────────────────────────────────────

function getAuthClient() {
  const b64 = config.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!b64) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not configured. ' +
        'Cannot authenticate with Google Drive.',
    );
  }
  const json = Buffer.from(b64, 'base64').toString('utf-8');
  const credentials = JSON.parse(json) as Record<string, unknown>;
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return auth;
}

// Lazy singleton drive client
let _driveClient: ReturnType<typeof google.drive> | null = null;

function getDriveClient() {
  if (_driveClient) return _driveClient;
  const auth = getAuthClient();
  _driveClient = google.drive({ version: 'v3', auth });
  return _driveClient;
}

// ── Download validation ────────────────────────────────────────────────────

/**
 * Validate that a downloaded buffer is genuine binary file content and not
 * an HTML login page, JSON error, or empty response.
 *
 * Throws a descriptive error if validation fails.
 * Safe logging: logs content-type and byte size only — never logs file contents.
 */
export function validateDownloadedBuffer(
  buffer: Buffer,
  contentType: string,
  fileName: string,
): void {
  const ct = contentType.toLowerCase().split(';')[0].trim();

  // 1. Reject known non-file content types
  for (const rejected of REJECTED_CONTENT_TYPES) {
    if (ct.startsWith(rejected)) {
      throw new Error(
        `[GoogleDrive] Download rejected for "${fileName}": ` +
          `content-type "${ct}" indicates a non-file response (login page or error). ` +
          `Byte size: ${buffer.length}. File was NOT uploaded.`,
      );
    }
  }

  // 2. Reject HTML body regardless of content-type header
  //    (some servers return text/octet-stream with an HTML body)
  const prefix = buffer.slice(0, 512).toString('utf-8').trimStart().toLowerCase();
  if (prefix.startsWith('<!doctype html') || prefix.startsWith('<html')) {
    throw new Error(
      `[GoogleDrive] Download rejected for "${fileName}": ` +
        `response body begins with HTML markup (likely a login or redirect page). ` +
        `Content-Type: "${ct}", Byte size: ${buffer.length}. File was NOT uploaded.`,
    );
  }

  // 3. Reject suspiciously small files
  if (buffer.length < MIN_FILE_BYTES) {
    throw new Error(
      `[GoogleDrive] Download rejected for "${fileName}": ` +
        `file is too small (${buffer.length} bytes < ${MIN_FILE_BYTES} byte minimum). ` +
        `Content-Type: "${ct}". File was NOT uploaded.`,
    );
  }
}

// ── Folder operations ──────────────────────────────────────────────────────

/**
 * Find an existing folder by name inside a parent folder.
 * supportsAllDrives + includeItemsFromAllDrives required for Shared Drive.
 * Returns the folder ID if found, null otherwise.
 */
export async function findFolderByName(
  name: string,
  parentFolderId: string,
): Promise<string | null> {
  const drive = getDriveClient();
  const safeName = name.replace(/'/g, "\\'");
  const q = `mimeType='application/vnd.google-apps.folder' and name='${safeName}' and '${parentFolderId}' in parents and trashed=false`;
  const res = await drive.files.list({
    q,
    fields: 'files(id, name)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = res.data.files ?? [];
  if (files.length > 0 && files[0].id) {
    logger.info(
      { folderId: files[0].id, name },
      '[GoogleDrive] Found existing folder',
    );
    return files[0].id;
  }
  return null;
}

/**
 * Create a new folder inside a parent folder.
 * supportsAllDrives required for Shared Drive targets.
 * Returns the new folder's ID and web-view link.
 */
export async function createFolder(
  name: string,
  parentFolderId: string,
): Promise<DriveFolder> {
  const drive = getDriveClient();
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  const id = res.data.id;
  const webViewLink = res.data.webViewLink;
  if (!id || !webViewLink) {
    throw new Error(`[GoogleDrive] createFolder returned incomplete data for "${name}"`);
  }
  logger.info({ folderId: id, name }, '[GoogleDrive] Created new folder');
  return { id, webViewLink };
}

/**
 * Extract a Google Drive folder ID from a folder URL.
 * Handles both /folders/<id> and /drive/folders/<id> patterns.
 * Returns null if the URL is not a recognisable Drive folder URL.
 */
export function extractFolderIdFromUrl(url: string): string | null {
  if (!url) return null;
  const match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match?.[1]) return match[1];
  return null;
}

/**
 * Resolve the contractor's Google Drive folder using the priority order:
 *   1. Existing drive_folder_id in Postgres (passed as existingFolderId)
 *   2. Folder URL from Airtable (passed as airtableFolderUrl)
 *   3. Search for an existing folder by name in Drive
 *   4. Create a new folder
 *
 * Returns the resolved folder ID and URL.
 */
export async function resolveContractorFolder(opts: {
  existingFolderId?: string | null;
  existingFolderUrl?: string | null;
  airtableFolderUrl?: string | null;
  legalName: string;
  airtableRecordId: string;
  parentFolderId?: string;
}): Promise<DriveFolder> {
  const parentFolderId = opts.parentFolderId ?? config.GOOGLE_DRIVE_PARENT_FOLDER_ID;
  const folderName = sanitizeFolderName(`${opts.legalName} - ${opts.airtableRecordId}`);

  // 1. Postgres has a folder ID — reuse it directly
  if (opts.existingFolderId) {
    logger.info(
      { folderId: opts.existingFolderId },
      '[GoogleDrive] Reusing folder ID from Postgres',
    );
    const url =
      opts.existingFolderUrl ??
      `https://drive.google.com/drive/folders/${opts.existingFolderId}`;
    return { id: opts.existingFolderId, webViewLink: url };
  }

  // 2. Airtable has a folder URL — extract and reuse the ID
  if (opts.airtableFolderUrl) {
    const extractedId = extractFolderIdFromUrl(opts.airtableFolderUrl);
    if (extractedId) {
      logger.info(
        { folderId: extractedId, url: opts.airtableFolderUrl },
        '[GoogleDrive] Reusing folder ID extracted from Airtable URL',
      );
      return { id: extractedId, webViewLink: opts.airtableFolderUrl };
    }
  }

  // 3. Search Drive for an existing folder by name
  const existingId = await findFolderByName(folderName, parentFolderId);
  if (existingId) {
    const url = `https://drive.google.com/drive/folders/${existingId}`;
    return { id: existingId, webViewLink: url };
  }

  // 4. Create a new folder
  return createFolder(folderName, parentFolderId);
}

// ── File upload ────────────────────────────────────────────────────────────

/**
 * Download a file from a URL and upload it to a Google Drive folder.
 *
 * Validates the download response before uploading:
 *   - HTTP status must be 200
 *   - Content-Type must not be text/html, application/json, or text/plain
 *   - Body must not begin with HTML markup
 *   - Body must be at least MIN_FILE_BYTES in size
 *
 * Throws a descriptive error if any validation fails; the file is never
 * uploaded in that case.
 *
 * supportsAllDrives required for Shared Drive targets.
 *
 * If jotformApiKey is provided, it is appended to the download URL as a
 * query parameter for protected Jotform file downloads.
 */
export async function downloadAndUploadFile(opts: {
  sourceUrl: string;
  fileName: string;
  folderId: string;
  jotformApiKey?: string;
}): Promise<DriveFile> {
  const drive = getDriveClient();

  // Build download URL — append Jotform API key if provided
  let downloadUrl = opts.sourceUrl;
  if (opts.jotformApiKey) {
    const sep = downloadUrl.includes('?') ? '&' : '?';
    downloadUrl = `${downloadUrl}${sep}apiKey=${opts.jotformApiKey}`;
  }

  // Download the file — follow redirects (fetch default)
  const response = await fetch(downloadUrl, { redirect: 'follow' });

  // Guard 1: HTTP status must be 200
  if (response.status !== 200) {
    throw new Error(
      `[GoogleDrive] Download failed for "${opts.fileName}": ` +
        `HTTP ${response.status} ${response.statusText}. File was NOT uploaded.`,
    );
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Safe log: status, content-type, and byte size only — no file contents
  logger.info(
    {
      fileName: opts.fileName,
      httpStatus: response.status,
      contentType,
      byteSize: buffer.length,
    },
    '[GoogleDrive] Download response received — validating before upload',
  );

  // Guards 2–4: content-type, HTML body, minimum size
  validateDownloadedBuffer(buffer, contentType, opts.fileName);

  // Upload to Drive — supportsAllDrives required for Shared Drive targets
  const safeFileName = sanitizeFileName(opts.fileName);
  const uploadRes = await drive.files.create({
    requestBody: {
      name: safeFileName,
      parents: [opts.folderId],
    },
    media: {
      mimeType: contentType.split(';')[0].trim(),
      body: Readable.from(buffer),
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

  const id = uploadRes.data.id;
  const webViewLink = uploadRes.data.webViewLink;
  if (!id || !webViewLink) {
    throw new Error(
      `[GoogleDrive] uploadFile returned incomplete data for "${safeFileName}"`,
    );
  }

  logger.info(
    { fileId: id, fileName: safeFileName, folderId: opts.folderId, byteSize: buffer.length },
    '[GoogleDrive] File uploaded successfully',
  );

  return { id, webViewLink };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Sanitize a folder name: strip characters that are invalid in Drive folder names.
 */
export function sanitizeFolderName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255);
}

/**
 * Sanitize a file name for upload to Drive.
 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255);
}

/**
 * Upload a raw in-memory buffer directly to a Drive folder.
 *
 * Unlike downloadAndUploadFile, this function does not fetch from a URL —
 * it accepts a pre-built Buffer and uploads it as-is.  Used to store
 * generated documents (e.g. onboarding submission summaries) that are
 * created in-process rather than downloaded from an external source.
 */
export async function uploadBufferToFolder(opts: {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  folderId: string;
}): Promise<DriveFile> {
  const drive = getDriveClient();
  const safeFileName = sanitizeFileName(opts.fileName);
  const uploadRes = await drive.files.create({
    requestBody: {
      name:    safeFileName,
      parents: [opts.folderId],
    },
    media: {
      mimeType: opts.mimeType,
      body:     Readable.from(opts.buffer),
    },
    fields:            'id, webViewLink',
    supportsAllDrives: true,
  });
  const id          = uploadRes.data.id;
  const webViewLink = uploadRes.data.webViewLink;
  if (!id || !webViewLink) {
    throw new Error(
      `[GoogleDrive] uploadBufferToFolder returned incomplete data for "${safeFileName}"`,
    );
  }
  logger.info(
    { fileId: id, fileName: safeFileName, folderId: opts.folderId, byteSize: opts.buffer.length },
    '[GoogleDrive] Buffer uploaded successfully',
  );
  return { id, webViewLink };
}
