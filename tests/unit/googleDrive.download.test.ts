import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  driveCreate: vi.fn(),
  fetch: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: class GoogleAuth {} },
    drive: vi.fn(() => ({ files: { create: mocks.driveCreate } })),
  },
}));

vi.mock('../../src/common/config', () => ({
  config: {
    GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: Buffer.from('{}').toString('base64'),
    GOOGLE_DRIVE_PARENT_FOLDER_ID: 'test-parent-folder',
  },
}));

vi.mock('../../src/common/logger', () => ({
  logger: {
    info: mocks.logInfo,
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  DOWNLOAD_TIMEOUT_MS,
  MAX_DOWNLOAD_BYTES,
  MAX_DOWNLOAD_REDIRECTS,
  downloadAndUploadFile,
  normalizeContentType,
  resolveFileExtension,
  validateJotformDownloadUrl,
} from '../../src/modules/storage/googleDrive.service';

const TEST_API_KEY = 'test-jotform-key-not-a-secret';
const VALID_SOURCE = 'https://www.jotform.com/uploads/test-account/form/submission/W9.pdf';
const PDF_SIGNATURE = Buffer.from('%PDF-1.7');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

function fileResponse(
  size = 1024,
  extraHeaders: Record<string, string> = {},
  signature = PDF_SIGNATURE,
): Response {
  const body = new Uint8Array(size);
  body.set(signature);
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/pdf', ...extraHeaders },
  });
}

function redirectResponse(location?: string): Response {
  return new Response(null, {
    status: 302,
    headers: location ? { location } : undefined,
  });
}

function download(
  sourceUrl = VALID_SOURCE,
  jotformApiKey = TEST_API_KEY,
  fileName = 'W9_test-contractor.pdf',
) {
  return downloadAndUploadFile({
    sourceUrl,
    fileName,
    folderId: 'drive-folder-id',
    jotformApiKey,
  });
}

function requestedUrl(callIndex = 0): URL {
  return new URL(String(mocks.fetch.mock.calls[callIndex][0]));
}

describe('contractor Jotform file download security', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.fetch.mockReset();
    mocks.driveCreate.mockReset();
    mocks.logInfo.mockReset();
    mocks.driveCreate.mockResolvedValue({
      data: { id: 'drive-file-id', webViewLink: 'https://drive.google.com/file/d/test' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    'https://jotform.com/uploads/account/form/submission/file.pdf',
    'https://www.jotform.com/uploads/account/form/submission/file.pdf',
    'https://files.jotform.com/account/form/submission/file.pdf',
  ])('accepts the exact approved HTTPS Jotform host %s', (url) => {
    expect(validateJotformDownloadUrl(url, 'document.pdf').hostname).toBe(new URL(url).hostname);
  });

  it('downloads a valid approved Jotform file and uploads it to Drive', async () => {
    mocks.fetch.mockResolvedValue(fileResponse());

    await expect(download()).resolves.toEqual({
      id: 'drive-file-id',
      webViewLink: 'https://drive.google.com/file/d/test',
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    expect(mocks.driveCreate).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'application/pdf; charset=binary',
      'contractor-id.png',
      'contractor-id.pdf',
      PDF_SIGNATURE,
    ],
    ['image/png', 'insurance', 'insurance.png', PNG_SIGNATURE],
    ['IMAGE/JPEG; charset=binary', 'photo.jpeg', 'photo.jpg', JPEG_SIGNATURE],
  ])(
    'accepts a valid %s signature and uploads filename %s as %s',
    async (contentType, sourceFileName, expectedFileName, signature) => {
      mocks.fetch.mockResolvedValue(
        fileResponse(1024, { 'content-type': contentType }, signature),
      );

      await download(VALID_SOURCE, TEST_API_KEY, sourceFileName);

      expect(mocks.driveCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            name: expectedFileName,
            parents: ['drive-folder-id'],
          },
          media: expect.objectContaining({
            mimeType: normalizeContentType(contentType),
          }),
        }),
      );
      expect(mocks.logInfo).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: expectedFileName }),
        '[GoogleDrive] File uploaded successfully',
      );
    },
  );

  it.each([
    ['PDF', 'application/pdf'],
    ['PNG', 'image/png'],
    ['JPEG', 'image/jpeg'],
  ])(
    'rejects a claimed %s with non-%s bytes before Drive upload',
    async (_label, contentType) => {
      mocks.fetch.mockResolvedValue(
        fileResponse(1024, { 'content-type': contentType }, Buffer.from('not-a-file')),
      );

      await expect(download()).rejects.toThrow(
        `[GoogleDrive] Download rejected for "W9_test-contractor.pdf": file signature does not match content-type "${contentType}". File was NOT uploaded.`,
      );
      expect(mocks.driveCreate).not.toHaveBeenCalled();
    },
  );

  it('rejects an unsupported MIME type before Drive upload', async () => {
    mocks.fetch.mockResolvedValue(
      fileResponse(1024, { 'content-type': 'application/octet-stream; charset=binary' }),
    );

    await expect(download()).rejects.toThrow(
      '[GoogleDrive] Download rejected for "W9_test-contractor.pdf": content-type "application/octet-stream" is not an approved contractor document type. File was NOT uploaded.',
    );
    expect(mocks.driveCreate).not.toHaveBeenCalled();
  });

  it('uses the normalized filename in incomplete-upload errors', async () => {
    mocks.fetch.mockResolvedValue(
      fileResponse(1024, { 'content-type': 'image/jpeg' }, JPEG_SIGNATURE),
    );
    mocks.driveCreate.mockResolvedValue({ data: { id: 'drive-file-id' } });

    await expect(download(VALID_SOURCE, TEST_API_KEY, 'photo.png')).rejects.toThrow(
      'uploadFile returned incomplete data for "photo.jpg"',
    );
  });

  it.each([
    ['malformed URL', 'not a URL'],
    ['HTTP URL', 'http://www.jotform.com/uploads/file.pdf'],
    ['external host', 'https://attacker.example/file.pdf'],
    ['localhost', 'https://localhost/file.pdf'],
    ['IPv4 loopback', 'https://127.0.0.1/file.pdf'],
    ['IPv6 loopback', 'https://[::1]/file.pdf'],
    ['cloud metadata IP', 'https://169.254.169.254/latest/meta-data'],
    ['deceptive subdomain', 'https://jotform.com.attacker.example/file.pdf'],
    ['deceptive suffix', 'https://attackerjotform.com/file.pdf'],
    ['unapproved Jotform subdomain', 'https://form.jotform.com/file.pdf'],
    ['non-default HTTPS port', 'https://www.jotform.com:444/file.pdf'],
    ['embedded credentials', 'https://user:password@www.jotform.com/file.pdf'],
  ])('rejects %s before fetch', async (_label, url) => {
    await expect(download(url)).rejects.toThrow(/Download rejected/);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.driveCreate).not.toHaveBeenCalled();
  });

  it('does not attach the API key to a rejected initial URL', async () => {
    await expect(download('https://attacker.example/file.pdf')).rejects.toThrow(/host is not approved/);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects a redirect to an unapproved host without forwarding the API key', async () => {
    mocks.fetch.mockResolvedValue(redirectResponse('https://attacker.example/stolen.pdf'));

    await expect(download()).rejects.toThrow(/host is not approved/);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(requestedUrl().hostname).toBe('www.jotform.com');
    expect(requestedUrl().searchParams.get('apiKey')).toBe(TEST_API_KEY);
    expect(mocks.driveCreate).not.toHaveBeenCalled();
  });

  it('rejects an approved-host redirect that downgrades to HTTP', async () => {
    mocks.fetch.mockResolvedValue(redirectResponse('http://www.jotform.com/uploads/file.pdf'));

    await expect(download()).rejects.toThrow(/must use HTTPS/);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.driveCreate).not.toHaveBeenCalled();
  });

  it('rejects a redirect with no Location header', async () => {
    mocks.fetch.mockResolvedValue(redirectResponse());

    await expect(download()).rejects.toThrow(/redirect location is missing/);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('rejects a malformed redirect Location', async () => {
    mocks.fetch.mockResolvedValue(redirectResponse('https://[::1'));

    await expect(download()).rejects.toThrow(/redirect location is malformed/);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('rejects an excessive redirect chain', async () => {
    mocks.fetch.mockResolvedValue(redirectResponse('/uploads/account/form/submission/next.pdf'));

    await expect(download()).rejects.toThrow(/redirect limit exceeded/);
    expect(mocks.fetch).toHaveBeenCalledTimes(MAX_DOWNLOAD_REDIRECTS + 1);
    expect(mocks.driveCreate).not.toHaveBeenCalled();
  });

  it('resolves a relative approved redirect and reapplies the API key safely', async () => {
    mocks.fetch
      .mockResolvedValueOnce(redirectResponse('/uploads/account/form/submission/redirected.pdf?step=2'))
      .mockResolvedValueOnce(fileResponse());

    await expect(download()).resolves.toMatchObject({ id: 'drive-file-id' });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(requestedUrl(1).href).toContain('/uploads/account/form/submission/redirected.pdf');
    expect(requestedUrl(1).searchParams.get('step')).toBe('2');
    expect(requestedUrl(1).searchParams.get('apiKey')).toBe(TEST_API_KEY);
  });

  it('preserves existing query parameters when adding the API key', async () => {
    mocks.fetch.mockResolvedValue(fileResponse());

    await download(`${VALID_SOURCE}?download=1&version=latest`);
    expect(requestedUrl().searchParams.get('download')).toBe('1');
    expect(requestedUrl().searchParams.get('version')).toBe('latest');
    expect(requestedUrl().searchParams.get('apiKey')).toBe(TEST_API_KEY);
  });

  it('rejects a request that exceeds the download timeout', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(
      (_input: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    const pendingDownload = download();
    const rejection = expect(pendingDownload).rejects.toThrow(/request timed out/);
    await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS);
    await rejection;
    expect(mocks.driveCreate).not.toHaveBeenCalled();
  });

  it('rejects an oversized Content-Length before reading or uploading', async () => {
    mocks.fetch.mockResolvedValue(
      fileResponse(1024, { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) }),
    );

    await expect(download()).rejects.toThrow(/size limit/);
    expect(mocks.driveCreate).not.toHaveBeenCalled();
  });

  it('rejects an oversized Content-Length beyond the safe-integer range', async () => {
    mocks.fetch.mockResolvedValue(
      fileResponse(1024, { 'content-length': '999999999999999999999999999999' }),
    );

    await expect(download()).rejects.toThrow(/size limit/);
    expect(mocks.driveCreate).not.toHaveBeenCalled();
  });

  it('rejects an oversized streamed body without a Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6 * 1024 * 1024));
        controller.enqueue(new Uint8Array(5 * 1024 * 1024));
        controller.close();
      },
    });
    mocks.fetch.mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );

    await expect(download()).rejects.toThrow(/size limit/);
    expect(mocks.driveCreate).not.toHaveBeenCalled();
  });

  it('accepts a valid file just under the maximum size', async () => {
    mocks.fetch.mockResolvedValue(fileResponse(MAX_DOWNLOAD_BYTES - 1));

    await expect(download()).resolves.toMatchObject({ id: 'drive-file-id' });
    expect(mocks.driveCreate).toHaveBeenCalledOnce();
  });

  it('does not expose the API key or credential-bearing URL in logs or errors', async () => {
    const sourceCredential = 'source-query-credential';
    const sourceUrl = `${VALID_SOURCE}?download=1&apiKey=${sourceCredential}`;
    mocks.fetch.mockResolvedValue(new Response(null, { status: 500 }));

    let errorMessage = '';
    try {
      await download(sourceUrl, TEST_API_KEY);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const logOutput = JSON.stringify(mocks.logInfo.mock.calls);
    expect(errorMessage).not.toContain(TEST_API_KEY);
    expect(errorMessage).not.toContain(sourceCredential);
    expect(errorMessage).not.toContain('apiKey=');
    expect(logOutput).not.toContain(TEST_API_KEY);
    expect(logOutput).not.toContain(sourceCredential);
    expect(logOutput).not.toContain('apiKey=');
    expect(mocks.driveCreate).not.toHaveBeenCalled();
  });

  it('sanitizes streamed-body failures that contain the credential-bearing URL', async () => {
    const credentialBearingUrl = `${VALID_SOURCE}?apiKey=${TEST_API_KEY}`;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`socket failure while reading ${credentialBearingUrl}`));
      },
    });
    mocks.fetch.mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );

    let errorMessage = '';
    try {
      await download();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    expect(errorMessage).toMatch(/response processing failed/);
    expect(errorMessage).not.toContain(TEST_API_KEY);
    expect(errorMessage).not.toContain(credentialBearingUrl);
    expect(JSON.stringify(mocks.logInfo.mock.calls)).not.toContain(TEST_API_KEY);
    expect(mocks.driveCreate).not.toHaveBeenCalled();
  });
});

describe('contractor document MIME helpers', () => {
  it('normalizes case, whitespace, and Content-Type parameters', () => {
    expect(normalizeContentType(' Image/JPEG ; charset=binary')).toBe('image/jpeg');
  });

  it.each([
    ['application/pdf', '.pdf'],
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
  ])('resolves %s to %s', (contentType, extension) => {
    expect(resolveFileExtension(contentType, 'contractor-document')).toBe(extension);
  });

  it('safely rejects unapproved normalized MIME types with the filename', () => {
    expect(() =>
      resolveFileExtension('APPLICATION/ZIP; charset=binary', 'insurance.pdf'),
    ).toThrow(
      '[GoogleDrive] Download rejected for "insurance.pdf": content-type "application/zip" is not an approved contractor document type. File was NOT uploaded.',
    );
  });
});
