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

/** Contractor documents are limited to 10 MiB to keep in-memory processing
 * bounded. W-9s, IDs, insurance certificates, and signed agreements should
 * all fit comfortably within this limit. */
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** Maximum total time for redirects and body streaming. */
export const DOWNLOAD_TIMEOUT_MS = 15_000;

/** At most three redirect hops are permitted before the download fails. */
export const MAX_DOWNLOAD_REDIRECTS = 3;

/** Exact hosts evidenced by Jotform's upload documentation and repository
 * fixtures. Deliberately no wildcard/suffix matching. */
const APPROVED_JOTFORM_DOWNLOAD_HOSTS = new Set([
  'jotform.com',
  'www.jotform.com',
  'files.jotform.com',
]);

/** Content-Type prefixes that indicate a non-file response (login page, API
 *  error, redirect page, etc.). Checked case-insensitively. */
const REJECTED_CONTENT_TYPES = ['text/html', 'application/json', 'text/plain'];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type TrustedDocumentContentType =
  | 'application/pdf'
  | 'image/png'
  | 'image/jpeg';

/** Filename extension for each accepted contractor document Content-Type. */
const CONTENT_TYPE_EXTENSIONS: Readonly<Record<TrustedDocumentContentType, string>> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
};

/** Required leading bytes for each accepted contractor document Content-Type. */
const CONTENT_TYPE_SIGNATURES: Readonly<Record<TrustedDocumentContentType, Buffer>> = {
  'application/pdf': Buffer.from('%PDF'),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
};

// ── Types ──────────────────────────────────────────────────────────────────

export interface DriveFile {
  id: string;
  webViewLink: string;
}

export interface DownloadedDriveFile extends DriveFile {
  originalFileName: string;
  detectedContentType: TrustedDocumentContentType;
  storedFileName: string;
}

export interface DriveFolder {
  id: string;
  webViewLink: string;
}

class SafeDownloadError extends Error {}

function downloadError(fileName: string, reason: string): SafeDownloadError {
  return new SafeDownloadError(
    `[GoogleDrive] Download rejected for "${fileName}": ${reason}. File was NOT uploaded.`,
  );
}

/** Remove Content-Type parameters and normalize the media type for comparison. */
export function normalizeContentType(contentType: string): string {
  return contentType.toLowerCase().split(';')[0].trim();
}

/** Resolve the required filename extension for an approved document Content-Type. */
export function resolveFileExtension(contentType: string, fileName: string): string {
  const ct = normalizeContentType(contentType);
  const extension = CONTENT_TYPE_EXTENSIONS[ct as TrustedDocumentContentType];
  if (!extension) {
    throw downloadError(
      fileName,
      `content-type "${ct}" is not an approved contractor document type`,
    );
  }
  return extension;
}

/** Identify an approved contractor document type solely from leading bytes. */
function detectContentTypeFromSignature(
  buffer: Buffer,
): TrustedDocumentContentType | null {
  for (const [contentType, signature] of Object.entries(CONTENT_TYPE_SIGNATURES)) {
    if (buffer.subarray(0, signature.length).equals(signature)) {
      return contentType as TrustedDocumentContentType;
    }
  }
  return null;
}

/**
 * Resolve the trusted document type from the declared MIME type and magic bytes.
 * application/octet-stream is accepted only when an approved signature identifies
 * the content. Approved declared types must agree with the detected signature.
 */
export function resolveTrustedContentType(
  buffer: Buffer,
  declaredContentType: string,
  fileName: string,
): TrustedDocumentContentType {
  const ct = normalizeContentType(declaredContentType);
  const detectedContentType = detectContentTypeFromSignature(buffer);

  if (ct === 'application/octet-stream') {
    if (!detectedContentType) {
      throw downloadError(
        fileName,
        'application/octet-stream content does not match an approved contractor document signature',
      );
    }
    return detectedContentType;
  }

  // Preserve the strict allowlist and its existing safe unsupported-type error.
  resolveFileExtension(ct, fileName);
  if (detectedContentType !== ct) {
    throw downloadError(
      fileName,
      `file signature does not match content-type "${ct}"`,
    );
  }
  return ct as TrustedDocumentContentType;
}

/** Parse and validate a Jotform download URL without making a network request. */
export function validateJotformDownloadUrl(sourceUrl: string, fileName: string): URL {
  const safeFileName = sanitizeFileName(fileName);
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw downloadError(safeFileName, 'source URL is malformed');
  }

  if (url.protocol !== 'https:') {
    throw downloadError(safeFileName, 'source URL must use HTTPS');
  }
  if (url.username || url.password) {
    throw downloadError(safeFileName, 'source URL must not contain embedded credentials');
  }
  if (url.port && url.port !== '443') {
    throw downloadError(safeFileName, 'source URL uses an unapproved port');
  }
  if (!APPROVED_JOTFORM_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase())) {
    throw downloadError(safeFileName, 'source URL host is not approved');
  }

  return url;
}

function addJotformApiKey(url: URL, jotformApiKey?: string): URL {
  const authenticatedUrl = new URL(url);
  if (jotformApiKey) {
    authenticatedUrl.searchParams.set('apiKey', jotformApiKey);
  }
  return authenticatedUrl;
}

async function readBoundedResponseBody(
  response: Response,
  fileName: string,
  controller: AbortController,
): Promise<Buffer> {
  const contentLength = response.headers.get('content-length')?.trim();
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredBytes = BigInt(contentLength);
    if (declaredBytes > BigInt(MAX_DOWNLOAD_BYTES)) {
      controller.abort();
      throw downloadError(
        fileName,
        `response exceeds the ${MAX_DOWNLOAD_BYTES}-byte size limit`,
      );
    }
  }

  if (!response.body) {
    throw downloadError(fileName, 'response body is missing');
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_DOWNLOAD_BYTES) {
        controller.abort();
        throw downloadError(
          fileName,
          `response exceeds the ${MAX_DOWNLOAD_BYTES}-byte size limit`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

async function fetchJotformFile(
  sourceUrl: string,
  fileName: string,
  jotformApiKey?: string,
): Promise<{ response: Response; buffer: Buffer }> {
  let currentUrl = validateJotformDownloadUrl(sourceUrl, fileName);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    for (let redirectCount = 0; ; ) {
      const requestUrl = addJotformApiKey(currentUrl, jotformApiKey);
      let response: Response;
      try {
        response = await fetch(requestUrl, {
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw downloadError(fileName, 'request timed out');
        }
        throw downloadError(fileName, 'request failed');
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirectCount >= MAX_DOWNLOAD_REDIRECTS) {
          controller.abort();
          throw downloadError(fileName, 'redirect limit exceeded');
        }
        const location = response.headers.get('location');
        if (!location) {
          controller.abort();
          throw downloadError(fileName, 'redirect location is missing');
        }

        let redirectUrl: URL;
        try {
          redirectUrl = new URL(location, currentUrl);
        } catch {
          controller.abort();
          throw downloadError(fileName, 'redirect location is malformed');
        }
        currentUrl = validateJotformDownloadUrl(redirectUrl.toString(), fileName);
        redirectCount += 1;
        continue;
      }

      if (response.status !== 200) {
        controller.abort();
        throw downloadError(fileName, `request returned HTTP ${response.status}`);
      }

      const buffer = await readBoundedResponseBody(response, fileName, controller);
      return { response, buffer };
    }
  } catch (err) {
    if (err instanceof SafeDownloadError) {
      throw err;
    }
    if (controller.signal.aborted) {
      throw downloadError(fileName, 'request timed out');
    }
    // Never propagate fetch/stream exceptions: they may embed the authenticated URL.
    throw downloadError(fileName, 'response processing failed');
  } finally {
    clearTimeout(timeout);
  }
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
  const ct = normalizeContentType(contentType);

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
}): Promise<DownloadedDriveFile> {
  const safeFileName = sanitizeFileName(opts.fileName);
  const { response, buffer } = await fetchJotformFile(
    opts.sourceUrl,
    safeFileName,
    opts.jotformApiKey,
  );
  const declaredContentType = normalizeContentType(
    response.headers.get('content-type') ?? 'application/octet-stream',
  );

  // Safe log: status, content-type, and byte size only — no file contents
  logger.info(
    {
      fileName: safeFileName,
      httpStatus: response.status,
      contentType: declaredContentType,
      byteSize: buffer.length,
    },
    '[GoogleDrive] Download response received — validating before upload',
  );

  // Guards 2–4: content-type, HTML body, minimum size
  validateDownloadedBuffer(buffer, declaredContentType, safeFileName);

  const trustedContentType = resolveTrustedContentType(
    buffer,
    declaredContentType,
    safeFileName,
  );
  const extension = resolveFileExtension(trustedContentType, safeFileName);
  const fileNameWithoutExtension = safeFileName.replace(/\.[^./\\]+$/, '');
  const normalizedFileName = `${fileNameWithoutExtension.slice(0, 255 - extension.length)}${extension}`;

  // Upload to Drive — supportsAllDrives required for Shared Drive targets
  const drive = getDriveClient();
  const uploadRes = await drive.files.create({
    requestBody: {
      name: normalizedFileName,
      parents: [opts.folderId],
    },
    media: {
      mimeType: trustedContentType,
      body: Readable.from(buffer),
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

  const id = uploadRes.data.id;
  const webViewLink = uploadRes.data.webViewLink;
  if (!id || !webViewLink) {
    throw new Error(
      `[GoogleDrive] uploadFile returned incomplete data for "${normalizedFileName}"`,
    );
  }

  logger.info(
    {
      fileId: id,
      fileName: normalizedFileName,
      contentType: trustedContentType,
      folderId: opts.folderId,
      byteSize: buffer.length,
    },
    '[GoogleDrive] File uploaded successfully',
  );

  return {
    id,
    webViewLink,
    originalFileName: safeFileName,
    detectedContentType: trustedContentType,
    storedFileName: normalizedFileName,
  };
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
