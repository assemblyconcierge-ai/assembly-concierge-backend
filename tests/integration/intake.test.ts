import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';

// Mock all DB and service dependencies
vi.mock('../../src/db/pool', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTransaction: vi.fn(async (fn: any) => {
    const client = { query: vi.fn(async () => ({ rows: [] })) };
    return fn(client);
  }),
  getPool: vi.fn(() => ({ query: vi.fn(async () => ({ rows: [] })) })),
  closePool: vi.fn(),
}));

vi.mock('../../src/modules/airtable-sync/airtableSync.queue', () => ({
  enqueueAirtableSync: vi.fn(async () => {}),
}));

vi.mock('../../src/common/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

vi.mock('../../src/modules/intake/intake.service', () => ({
  processIntake: vi.fn(async () => ({
    jobId: 'job-123',
    jobKey: 'AC-2024-TEST',
    status: 'awaiting_payment',
    serviceAreaStatus: 'in_area',
    totalAmountCents: 10900,
    checkoutRequired: true,
  })),
}));

vi.mock('../../src/modules/intake/intake.repository', () => ({
  findByIdempotencyKey: vi.fn(async () => null),
  createIntakeSubmission: vi.fn(async () => ({
    id: 'sub-123',
    source: 'jotform',
    external_submission_id: 'SUB-001',
    processing_status: 'received',
    idempotency_key: 'jotform:SUB-001',
    correlation_id: 'corr-123',
  })),
  markProcessing: vi.fn(async () => {}),
  markProcessed: vi.fn(async () => {}),
  markFailed: vi.fn(async () => {}),
  markDuplicate: vi.fn(async () => {}),
}));

const app = createApp();

describe('POST /webhooks/jotform', () => {
  const validPayload = {
    submissionID: 'SUB-001',
    'q3_name[first]': 'Jane',
    'q3_name[last]': 'Smith',
    q4_email: 'jane@example.com',
    q5_phone: '4045551234',
    q7_city: 'Hampton',
    q8_serviceType: 'Small Assembly',
    q9_rush: 'No',
  };

  it('returns 202 for a valid new submission', async () => {
    const res = await request(app)
      .post('/webhooks/jotform')
      .send(validPayload)
      .expect(202);

    expect(res.body.status).toBe('received');
    expect(res.body.submissionId).toBe('sub-123');
    expect(res.body.correlationId).toBeDefined();
  });

  it('returns 200 with status=duplicate for repeated submission', async () => {
    const { findByIdempotencyKey } = await import('../../src/modules/intake/intake.repository');
    vi.mocked(findByIdempotencyKey).mockResolvedValueOnce({
      id: 'sub-existing',
      source: 'jotform',
      external_submission_id: 'SUB-001',
      raw_payload_json: {},
      normalized_payload_json: null,
      received_at: new Date(),
      processed_at: null,
      processing_status: 'processed',
      idempotency_key: 'jotform:SUB-001',
      correlation_id: 'corr-old',
      error_message: null,
    });

    const res = await request(app)
      .post('/webhooks/jotform')
      .send(validPayload)
      .expect(200);

    expect(res.body.status).toBe('duplicate');
  });

  it('accepts payload without submissionID (generates one)', async () => {
    const { findByIdempotencyKey } = await import('../../src/modules/intake/intake.repository');
    vi.mocked(findByIdempotencyKey).mockResolvedValueOnce(null);

    const noIdPayload = { ...validPayload };
    delete (noIdPayload as any).submissionID;

    const res = await request(app)
      .post('/webhooks/jotform')
      .send(noIdPayload)
      .expect(202);

    expect(res.body.status).toBe('received');
  });
});

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe('2.0.0');
  });
});

describe('POST /webhooks/dispatch-response', () => {
  it('returns 200 stub response', async () => {
    const res = await request(app)
      .post('/webhooks/dispatch-response')
      .send({ dispatchId: 'disp-1', response: 'accepted' })
      .expect(200);

    expect(res.body.status).toBe('received');
  });
});
