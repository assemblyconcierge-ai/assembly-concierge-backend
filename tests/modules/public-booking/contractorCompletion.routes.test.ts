import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { NextFunction, Request, Response } from 'express';
import { runInNewContext } from 'node:vm';

const mocks = vi.hoisted(() => ({
  txQuery: vi.fn(),
  enqueueAirtableSync: vi.fn(),
}));

vi.mock('../../../src/db/pool', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(async (fn: (client: any) => Promise<unknown>) =>
    fn({ query: mocks.txQuery })),
}));

vi.mock('../../../src/modules/storage/s3.service', () => ({
  deleteStorageObject: vi.fn(),
  generatePresignedUploadUrl: vi.fn(),
}));

vi.mock('../../../src/modules/airtable-sync/airtableSync.queue', () => ({
  enqueueAirtableSync: mocks.enqueueAirtableSync,
}));

vi.mock('../../../src/common/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../src/common/config', () => ({
  config: {
    NODE_ENV: 'test',
    APP_BASE_URL: 'https://test.example.com',
    STORAGE_ENDPOINT: 'https://test.r2.cloudflarestorage.com',
    STORAGE_BUCKET: 'test-bucket',
  },
}));

import { query, queryOne, withTransaction } from '../../../src/db/pool';
import {
  deleteStorageObject,
  generatePresignedUploadUrl,
} from '../../../src/modules/storage/s3.service';
import { contractorCompletionRouter } from '../../../src/modules/public-booking/contractorCompletion.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { correlationId?: string }).correlationId = 'test-corr';
    next();
  });
  app.use('/public/contractor/completion', contractorCompletionRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  });
  return app;
}

const VALID_TOKEN = `cct_${'a'.repeat(32)}`;
const ACCESS_ROW = {
  assignment_id: 'assignment-1',
  job_id: '11111111-1111-4111-8111-111111111111',
  job_key: 'AC-2026-EPME',
  job_status: 'completion_reported',
};
const CONFIRMED_AT = new Date('2026-07-25T12:00:00.000Z');

interface PendingPhoto {
  id: string;
  storageKey: string;
  originalFilename: string;
  confirmedAt: Date | null;
}

let txAccess: typeof ACCESS_ROW | null;
let acceptedPhotoCount: number;
let nextMediaId: number;
let pendingPhotos: Map<string, PendingPhoto>;
let confirmedPhotos: Map<string, PendingPhoto>;

function file(filename = 'image.jpg', mimeType = 'image/jpeg') {
  return { filename, mimeType, fileSizeBytes: 100_000 };
}

function installStatefulTransactionClient(): void {
  mocks.txQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM contractor_assignments')) {
      return { rows: txAccess ? [txAccess] : [] };
    }
    if (sql.includes('COUNT(*) FILTER')) {
      return {
        rows: [{
          accepted_count: String(acceptedPhotoCount),
          active_reservation_count: String(pendingPhotos.size),
        }],
      };
    }
    if (sql.includes('INSERT INTO uploaded_media')) {
      const storageKey = params[1] as string;
      pendingPhotos.set(storageKey, {
        id: `22222222-2222-4222-8222-${String(nextMediaId++).padStart(12, '0')}`,
        storageKey,
        originalFilename: params[3] as string,
        confirmedAt: null,
      });
      return { rows: [] };
    }
    if (sql.includes('SELECT id, storage_key, confirmed_at')) {
      const storageKeys = params[1] as string[];
      return {
        rows: storageKeys.flatMap((storageKey) => {
          const photo = pendingPhotos.get(storageKey) ?? confirmedPhotos.get(storageKey);
          return photo
            ? [{
                id: photo.id,
                storage_key: photo.storageKey,
                confirmed_at: photo.confirmedAt,
              }]
            : [];
        }),
      };
    }
    if (sql.includes('UPDATE uploaded_media')) {
      const mediaIds = params[0] as string[];
      const confirmedRows = [...pendingPhotos.values()]
        .filter((photo) => mediaIds.includes(photo.id))
        .map((photo) => {
          pendingPhotos.delete(photo.storageKey);
          const confirmed = { ...photo, confirmedAt: CONFIRMED_AT };
          confirmedPhotos.set(photo.storageKey, confirmed);
          acceptedPhotoCount += 1;
          return {
            id: confirmed.id,
            storage_key: confirmed.storageKey,
            confirmed_at: CONFIRMED_AT,
          };
        });
      return { rows: confirmedRows };
    }
    throw new Error(`Unexpected transaction SQL: ${sql}`);
  });
}

async function reserve(files: ReturnType<typeof file>[]) {
  return request(buildApp())
    .post(`/public/contractor/completion/${VALID_TOKEN}/presign`)
    .send({ files });
}

async function confirm(storageKeys: string[]) {
  return request(buildApp())
    .post(`/public/contractor/completion/${VALID_TOKEN}/confirm`)
    .send({ storageKeys });
}

async function cancelReservation(storageKeys: string[]) {
  vi.mocked(queryOne).mockResolvedValueOnce({
    job_id: ACCESS_ROW.job_id,
  } as any);
  return request(buildApp())
    .post(`/public/contractor/completion/${VALID_TOKEN}/cancel-reservation`)
    .send({ storageKeys });
}

async function uploadRequest(files: ReturnType<typeof file>[]) {
  const presignResponse = await reserve(files);
  expect(presignResponse.status).toBe(201);
  const storageKeys = presignResponse.body.uploads.map(
    (upload: { storageKey: string }) => upload.storageKey,
  );
  const confirmResponse = await confirm(storageKeys);
  return { presignResponse, confirmResponse, storageKeys };
}

beforeEach(() => {
  vi.clearAllMocks();
  txAccess = ACCESS_ROW;
  acceptedPhotoCount = 0;
  nextMediaId = 1;
  pendingPhotos = new Map();
  confirmedPhotos = new Map();
  installStatefulTransactionClient();

  vi.mocked(queryOne).mockResolvedValue(null);
  vi.mocked(query).mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('DELETE FROM uploaded_media') && params) {
      const deletedRows = (params[1] as string[]).flatMap((storageKey) => {
        if (!pendingPhotos.delete(storageKey)) return [];
        return [{ storage_key: storageKey }];
      });
      return deletedRows;
    }
    return [];
  });
  vi.mocked(generatePresignedUploadUrl).mockImplementation(
    async (storageKey) => `https://r2.example.com/${encodeURIComponent(storageKey)}`,
  );
  vi.mocked(deleteStorageObject).mockResolvedValue(undefined);
  mocks.enqueueAirtableSync.mockResolvedValue(undefined);
});

describe('contractor completion photo landing page and eligibility', () => {
  it('returns 404 before querying for a malformed completion token', async () => {
    const response = await request(buildApp())
      .post('/public/contractor/completion/bad-token/presign')
      .send({ files: [file()] });

    expect(response.status).toBe(404);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('renders the reusable 1-3 photo batch UI for an eligible job', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);

    const response = await request(buildApp())
      .get(`/public/contractor/completion/${VALID_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.text).toContain('slot-0');
    expect(response.text).toContain('slot-2');
    expect(response.text).toContain('files: selectedFiles.map');
    expect(response.text).toContain('storageKeys: storageKeys');
    expect(response.text).toContain("BASE + '/cancel-reservation'");
    expect(response.text).toContain('await cancelReservation(reservedStorageKeys)');
    expect(response.text).toContain('keepalive: true');
    expect(response.text).toContain('body.existingPhotoCount');
    expect(response.text).toContain('remaining slots:');
    expect(response.text).not.toContain(VALID_TOKEN);
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('cancels the whole reservation when the second browser PUT fails', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(ACCESS_ROW as any);
    const response = await request(buildApp())
      .get(`/public/contractor/completion/${VALID_TOKEN}`);
    const script = response.text.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();

    type Handler = (event?: any) => unknown;
    const handlers = new Map<string, Map<string, Handler>>();
    const elements = new Map<string, any>();

    function element(id: string) {
      const eventHandlers = new Map<string, Handler>();
      handlers.set(id, eventHandlers);
      const value: any = {
        id,
        style: {},
        classList: { add: vi.fn(), remove: vi.fn() },
        files: null,
        value: '',
        disabled: false,
        textContent: '',
        className: '',
        firstChild: null,
        addEventListener: (name: string, handler: Handler) => {
          eventHandlers.set(name, handler);
        },
        querySelector: (selector: string) => {
          if (selector === '.remove-btn') return elements.get(`${id}-remove`);
          return null;
        },
        insertBefore: vi.fn(),
        removeChild: vi.fn(),
        click: vi.fn(),
        contains: vi.fn(() => false),
      };
      elements.set(id, value);
      return value;
    }

    element('upload-btn');
    element('status');
    element('progress-wrap');
    element('progress-bar');
    for (let index = 0; index < 3; index += 1) {
      element(`slot-${index}`);
      element(`slot-${index}-remove`);
      element(`input-${index}`);
    }

    const fetchMock = vi.fn(async (
      url: string,
      _options?: { body?: string },
    ) => {
      if (url.endsWith('/presign')) {
        return {
          ok: true,
          json: async () => ({
            uploads: [
              { uploadUrl: 'https://storage.example/upload-1', storageKey: 'key-1' },
              { uploadUrl: 'https://storage.example/upload-2', storageKey: 'key-2' },
            ],
          }),
        };
      }
      if (url === 'https://storage.example/upload-1') {
        return { ok: true };
      }
      if (url === 'https://storage.example/upload-2') {
        return { ok: false, status: 500, text: async () => 'failed' };
      }
      if (url.endsWith('/cancel-reservation')) {
        return { ok: true };
      }
      throw new Error(`Unexpected browser fetch: ${url}`);
    });

    runInNewContext(script!, {
      document: {
        getElementById: (id: string) => elements.get(id),
        createElement: () => element(`generated-${elements.size}`),
      },
      fetch: fetchMock,
      location: {
        pathname: `/public/contractor/completion/${VALID_TOKEN}`,
      },
      URL: { createObjectURL: () => 'blob:preview' },
    });

    for (let index = 0; index < 2; index += 1) {
      const input = elements.get(`input-${index}`);
      input.files = [{
        name: `image-${index + 1}.jpg`,
        type: 'image/jpeg',
        size: 100_000,
      }];
      handlers.get(`input-${index}`)?.get('change')?.();
    }

    await handlers.get('upload-btn')?.get('click')?.();

    const cancellationCall = fetchMock.mock.calls.find(
      ([url]) => String(url).endsWith('/cancel-reservation'),
    );
    expect(cancellationCall).toBeDefined();
    expect(JSON.parse(String(cancellationCall?.[1]?.body))).toEqual({
      storageKeys: ['key-1', 'key-2'],
    });
    expect(fetchMock.mock.calls.some(
      ([url]) => String(url).endsWith('/confirm'),
    )).toBe(false);
  });

  it('preserves rejection after completion or closure', async () => {
    txAccess = null;

    const response = await reserve([file()]);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('NOT_FOUND');
  });

  it.each(['cancelled', 'closed_paid', 'awaiting_remainder_payment'])(
    'preserves rejection for currently ineligible status %s',
    async () => {
      txAccess = null;

      const response = await reserve([file()]);

      expect(response.status).toBe(404);
    },
  );

  it('locks the job row while reusing the existing eligibility predicates', async () => {
    await reserve([file()]);

    const accessSql = mocks.txQuery.mock.calls[0][0] as string;
    expect(accessSql).toContain("j.status = 'completion_reported'");
    expect(accessSql).toContain("ca.status = 'completed'");
    expect(accessSql).toContain('FOR UPDATE OF j');
    expect(withTransaction).toHaveBeenCalledOnce();
  });
});

describe('completion photo reservation cancellation', () => {
  it('removes every still-pending row and object from the supplied batch', async () => {
    const reservation = await reserve([
      file('one.jpg'),
      file('two.jpg'),
      file('three.jpg'),
    ]);
    const storageKeys = reservation.body.uploads.map(
      (upload: { storageKey: string }) => upload.storageKey,
    );

    const response = await cancelReservation(storageKeys);

    expect(response.status).toBe(200);
    expect(response.body.cancelledStorageKeys).toEqual(storageKeys);
    expect(response.body.cancelledCount).toBe(3);
    expect(pendingPhotos.size).toBe(0);
    expect(vi.mocked(deleteStorageObject).mock.calls.map(([key]) => key))
      .toEqual(storageKeys);

    const deleteCall = vi.mocked(query).mock.calls.find(
      ([sql]) => String(sql).includes('DELETE FROM uploaded_media'),
    );
    expect(deleteCall?.[0]).toContain("photo_type = 'completion'");
    expect(deleteCall?.[0]).toContain('confirmed_at IS NULL');
    expect(deleteCall?.[1]).toEqual([ACCESS_ROW.job_id, storageKeys]);
  });

  it('deletes only objects whose still-pending rows were removed', async () => {
    const reservation = await reserve([file('confirmed.jpg'), file('pending.jpg')]);
    const storageKeys = reservation.body.uploads.map(
      (upload: { storageKey: string }) => upload.storageKey,
    );
    await confirm([storageKeys[0]]);
    vi.mocked(deleteStorageObject).mockClear();

    const response = await cancelReservation(storageKeys);

    expect(response.status).toBe(200);
    expect(response.body.cancelledStorageKeys).toEqual([storageKeys[1]]);
    expect(confirmedPhotos.has(storageKeys[0])).toBe(true);
    expect(pendingPhotos.has(storageKeys[1])).toBe(false);
    expect(deleteStorageObject).toHaveBeenCalledOnce();
    expect(deleteStorageObject).toHaveBeenCalledWith(storageKeys[1]);
    expect(deleteStorageObject).not.toHaveBeenCalledWith(storageKeys[0]);
  });

  it('cannot delete an already-confirmed photo', async () => {
    const { storageKeys, confirmResponse } = await uploadRequest([file()]);
    expect(confirmResponse.status).toBe(200);
    vi.mocked(deleteStorageObject).mockClear();

    const response = await cancelReservation(storageKeys);

    expect(response.status).toBe(200);
    expect(response.body.cancelledStorageKeys).toEqual([]);
    expect(confirmedPhotos.has(storageKeys[0])).toBe(true);
    expect(deleteStorageObject).not.toHaveBeenCalled();
  });

  it('is harmless when repeated for the same reservation', async () => {
    const reservation = await reserve([file()]);
    const storageKeys = reservation.body.uploads.map(
      (upload: { storageKey: string }) => upload.storageKey,
    );

    const first = await cancelReservation(storageKeys);
    const second = await cancelReservation(storageKeys);

    expect(first.status).toBe(200);
    expect(first.body.cancelledCount).toBe(1);
    expect(second.status).toBe(200);
    expect(second.body.cancelledCount).toBe(0);
    expect(deleteStorageObject).toHaveBeenCalledTimes(1);
  });

  it('ignores storage keys that do not belong to the token-owned job', async () => {
    const foreignStorageKey =
      'jobs/OTHER-JOB/completion/completion-other-job-foreign-1.jpg';

    const response = await cancelReservation([foreignStorageKey]);

    expect(response.status).toBe(200);
    expect(response.body.cancelledStorageKeys).toEqual([]);
    expect(deleteStorageObject).not.toHaveBeenCalled();
    const deleteCall = vi.mocked(query).mock.calls.find(
      ([sql]) => String(sql).includes('DELETE FROM uploaded_media'),
    );
    expect(deleteCall?.[1]).toEqual([
      ACCESS_ROW.job_id,
      [foreignStorageKey],
    ]);
  });
});

describe('completion photo request limits and counts', () => {
  it('rejects an unsupported MIME type without reserving media', async () => {
    const response = await reserve([file('evidence.pdf', 'application/pdf')]);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('UNSUPPORTED_MIME_TYPE');
    expect(pendingPhotos.size).toBe(0);
  });

  it('rejects an oversized file without reserving media', async () => {
    const response = await request(buildApp())
      .post(`/public/contractor/completion/${VALID_TOKEN}/presign`)
      .send({
        files: [{
          ...file(),
          fileSizeBytes: 21 * 1024 * 1024,
        }],
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('FILE_TOO_LARGE');
    expect(pendingPhotos.size).toBe(0);
  });

  it('accepts a first request with 1 photo', async () => {
    const { confirmResponse } = await uploadRequest([file()]);

    expect(confirmResponse.status).toBe(200);
    expect(confirmResponse.body).toEqual(expect.objectContaining({
      existingPhotoCount: 1,
      remainingPhotoSlots: 11,
      maximumPhotoCount: 12,
    }));
  });

  it('accepts a first request with 3 photos', async () => {
    const { confirmResponse } = await uploadRequest([
      file('one.jpg'),
      file('two.jpg'),
      file('three.jpg'),
    ]);

    expect(confirmResponse.status).toBe(200);
    expect(confirmResponse.body.existingPhotoCount).toBe(3);
    expect(confirmResponse.body.remainingPhotoSlots).toBe(9);
  });

  it('rejects more than 3 photos before inserting any row', async () => {
    const response = await reserve([
      file('one.jpg'),
      file('two.jpg'),
      file('three.jpg'),
      file('four.jpg'),
    ]);

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      error: 'TOO_MANY_FILES',
      existingPhotoCount: 0,
      remainingPhotoSlots: 12,
      maximumPhotoCount: 12,
      maximumPhotosPerRequest: 3,
    }));
    expect(pendingPhotos.size).toBe(0);
  });

  it('accepts repeated requests up to exactly 12 total', async () => {
    for (let batch = 0; batch < 4; batch += 1) {
      const { confirmResponse } = await uploadRequest([
        file('image.jpg'),
        file('image.jpg'),
        file('image.jpg'),
      ]);
      expect(confirmResponse.status).toBe(200);
    }

    expect(acceptedPhotoCount).toBe(12);
    expect(confirmedPhotos.size).toBe(12);
  });

  it('rejects an entire request that would raise the total above 12', async () => {
    acceptedPhotoCount = 10;
    const existingKey = 'jobs/existing/completion/existing.jpg';
    confirmedPhotos.set(existingKey, {
      id: '33333333-3333-4333-8333-333333333333',
      storageKey: existingKey,
      originalFilename: 'existing.jpg',
      confirmedAt: CONFIRMED_AT,
    });

    const response = await reserve([
      file('one.jpg'),
      file('two.jpg'),
      file('three.jpg'),
    ]);

    expect(response.status).toBe(409);
    expect(response.body).toEqual(expect.objectContaining({
      error: 'UPLOAD_LIMIT_REACHED',
      existingPhotoCount: 10,
      remainingPhotoSlots: 2,
      maximumPhotoCount: 12,
    }));
    expect(pendingPhotos.size).toBe(0);
    expect(confirmedPhotos.get(existingKey)?.originalFilename).toBe('existing.jpg');
  });

  it('rejects a request when 12 photos already exist', async () => {
    acceptedPhotoCount = 12;

    const response = await reserve([file()]);

    expect(response.status).toBe(409);
    expect(response.body.existingPhotoCount).toBe(12);
    expect(response.body.remainingPhotoSlots).toBe(0);
    expect(response.body.maximumPhotoCount).toBe(12);
  });

  it('counts only confirmed rows as existing accepted photos', async () => {
    acceptedPhotoCount = 5;
    pendingPhotos.set('pending-key', {
      id: '44444444-4444-4444-8444-444444444444',
      storageKey: 'pending-key',
      originalFilename: 'pending.jpg',
      confirmedAt: null,
    });

    const response = await reserve([file()]);

    expect(response.status).toBe(201);
    expect(response.body.existingPhotoCount).toBe(5);
    expect(response.body.remainingPhotoSlots).toBe(5);
    const countSql = mocks.txQuery.mock.calls.find(
      ([sql]) => String(sql).includes('COUNT(*) FILTER'),
    )?.[0] as string;
    expect(countSql).toContain('confirmed_at IS NOT NULL');
  });
});

describe('atomic confirmation and concurrency', () => {
  it('rejects a missing confirmation body', async () => {
    const response = await request(buildApp())
      .post(`/public/contractor/completion/${VALID_TOKEN}/confirm`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects a storage key that does not belong to pending completion media', async () => {
    const response = await confirm(['missing-storage-key']);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('MEDIA_NOT_FOUND');
  });

  it('rejects an already-confirmed photo without changing it', async () => {
    const storageKey = 'already-confirmed-key';
    acceptedPhotoCount = 1;
    confirmedPhotos.set(storageKey, {
      id: '88888888-8888-4888-8888-888888888888',
      storageKey,
      originalFilename: 'existing.jpg',
      confirmedAt: CONFIRMED_AT,
    });

    const response = await confirm([storageKey]);

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('ALREADY_CONFIRMED');
    expect(acceptedPhotoCount).toBe(1);
  });

  it('confirms the whole request in one UPDATE and never partially accepts it', async () => {
    const reservation = await reserve([file('one.jpg'), file('two.jpg')]);
    const storageKeys = reservation.body.uploads.map(
      (upload: { storageKey: string }) => upload.storageKey,
    );

    const response = await confirm(storageKeys);

    expect(response.status).toBe(200);
    const updateCalls = mocks.txQuery.mock.calls.filter(
      ([sql]) => String(sql).includes('UPDATE uploaded_media'),
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][0]).toContain('id = ANY($1::uuid[])');
    expect(response.body.mediaIds).toHaveLength(2);
  });

  it('serializes concurrent confirmations so accepted photos cannot exceed 12', async () => {
    acceptedPhotoCount = 10;
    const firstKeys = ['first-1', 'first-2'];
    const secondKeys = ['second-1', 'second-2'];
    [...firstKeys, ...secondKeys].forEach((storageKey, index) => {
      pendingPhotos.set(storageKey, {
        id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
        storageKey,
        originalFilename: 'image.jpg',
        confirmedAt: null,
      });
    });

    let transactionChain = Promise.resolve();
    vi.mocked(withTransaction).mockImplementation(async (fn: any) => {
      let release!: () => void;
      const predecessor = transactionChain;
      transactionChain = new Promise<void>((resolve) => { release = resolve; });
      await predecessor;
      try {
        return await fn({ query: mocks.txQuery });
      } finally {
        release();
      }
    });

    const responses = await Promise.all([
      confirm(firstKeys),
      confirm(secondKeys),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(acceptedPhotoCount).toBe(12);
    expect(confirmedPhotos.size).toBe(2);
    expect(deleteStorageObject).toHaveBeenCalledTimes(2);
  });

  it('leaves previously accepted photos unchanged when a later batch is rejected', async () => {
    acceptedPhotoCount = 11;
    const existingKey = 'existing-confirmed-key';
    confirmedPhotos.set(existingKey, {
      id: '66666666-6666-4666-8666-666666666666',
      storageKey: existingKey,
      originalFilename: 'original-evidence.jpg',
      confirmedAt: CONFIRMED_AT,
    });
    const rejectedKeys = ['new-1', 'new-2'];
    rejectedKeys.forEach((storageKey, index) => {
      pendingPhotos.set(storageKey, {
        id: `77777777-7777-4777-8777-${String(index + 1).padStart(12, '0')}`,
        storageKey,
        originalFilename: 'image.jpg',
        confirmedAt: null,
      });
    });

    const response = await confirm(rejectedKeys);

    expect(response.status).toBe(409);
    expect(confirmedPhotos.get(existingKey)).toEqual(expect.objectContaining({
      originalFilename: 'original-evidence.jpg',
      confirmedAt: CONFIRMED_AT,
    }));
    expect(acceptedPhotoCount).toBe(11);
  });

  it('cleans up temporary objects when the confirmation transaction fails', async () => {
    const reservation = await reserve([file()]);
    const storageKey = reservation.body.uploads[0].storageKey as string;
    const statefulImplementation = mocks.txQuery.getMockImplementation()!;
    mocks.txQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('UPDATE uploaded_media')) {
        throw new Error('simulated database failure');
      }
      return statefulImplementation(sql, params);
    });

    const response = await confirm([storageKey]);

    expect(response.status).toBe(500);
    expect(acceptedPhotoCount).toBe(0);
    expect(pendingPhotos.has(storageKey)).toBe(false);
    expect(deleteStorageObject).toHaveBeenCalledWith(storageKey);
  });
});

describe('completion photo object naming and metadata', () => {
  it('generates unique server filenames when every client filename is image.jpg', async () => {
    const response = await reserve([
      file('image.jpg'),
      file('image.jpg'),
      file('image.jpg'),
    ]);

    expect(response.status).toBe(201);
    const storageKeys = response.body.uploads.map(
      (upload: { storageKey: string }) => upload.storageKey,
    );
    expect(new Set(storageKeys).size).toBe(3);
    storageKeys.forEach((storageKey: string, index: number) => {
      expect(storageKey).toMatch(
        /^jobs\/AC-2026-EPME\/completion\/completion-11111111-1111-4111-8111-111111111111-[a-f0-9-]+-\d\.jpg$/,
      );
      expect(storageKey).toContain(`-${index + 1}.jpg`);
    });
  });

  it('preserves original client filename metadata and MIME-derived extensions', async () => {
    const response = await reserve([
      file('client-name.jpg', 'image/png'),
    ]);

    expect(response.status).toBe(201);
    expect(response.body.uploads[0].storageKey).toMatch(/\.png$/);
    const insertCall = mocks.txQuery.mock.calls.find(
      ([sql]) => String(sql).includes('INSERT INTO uploaded_media'),
    );
    expect(insertCall?.[1][3]).toBe('client-name.jpg');
    expect(insertCall?.[1][2]).toBe('image/png');
  });

  it('retains legacy single-item API compatibility with count fields', async () => {
    const presignResponse = await request(buildApp())
      .post(`/public/contractor/completion/${VALID_TOKEN}/presign`)
      .send(file());

    expect(presignResponse.status).toBe(201);
    expect(presignResponse.body.uploadUrl).toBeDefined();
    expect(presignResponse.body.storageKey).toBeDefined();
    expect(presignResponse.body.maximumPhotoCount).toBe(12);

    const confirmResponse = await request(buildApp())
      .post(`/public/contractor/completion/${VALID_TOKEN}/confirm`)
      .send({ storageKey: presignResponse.body.storageKey });

    expect(confirmResponse.status).toBe(200);
    expect(confirmResponse.body.mediaId).toBeDefined();
    expect(confirmResponse.body.storageKey).toBe(presignResponse.body.storageKey);
  });
});
