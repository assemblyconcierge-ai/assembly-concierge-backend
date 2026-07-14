import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/modules/sms/sms.service', () => ({ processSmsWebhook: vi.fn() }));
vi.mock('../../src/modules/audit/audit.service', () => ({ recordAuditEvent: vi.fn() }));
vi.mock('../../src/modules/sms/quo.adapter', () => ({ sendSms: vi.fn() }));
vi.mock('../../src/modules/airtable-sync/airtableSync.queue', () => ({
  enqueueAirtableSync: vi.fn(),
}));

import { createApp } from '../../src/app';
import { config } from '../../src/common/config';
import { logger } from '../../src/common/logger';
import { query, queryOne, withTransaction } from '../../src/db/pool';
import { recordAuditEvent } from '../../src/modules/audit/audit.service';
import { enqueueAirtableSync } from '../../src/modules/airtable-sync/airtableSync.queue';
import { sendSms } from '../../src/modules/sms/quo.adapter';
import { processSmsWebhook } from '../../src/modules/sms/sms.service';

const app = createApp();
const SIGNING_KEY = Buffer.from('integration-test-quo-signing-key');
const SIGNING_SECRET = SIGNING_KEY.toString('base64');
const originalConfig = {
  NODE_ENV: config.NODE_ENV,
  QUO_WEBHOOK_SIGNING_SECRET: config.QUO_WEBHOOK_SIGNING_SECRET,
};

const PAYLOAD = {
  id: 'EV-test-message-received',
  object: 'event',
  apiVersion: 'v3',
  createdAt: '2026-07-14T12:00:00.000Z',
  type: 'message.received',
  data: {
    object: {
      id: 'AC-test-message',
      object: 'message',
      from: '+14045550100',
      to: '+14705550100',
      direction: 'incoming',
      body: 'CONFIRM AC-2026-TEST',
      status: 'received',
    },
  },
};

function signature(rawBody: string, timestamp = Date.now()): string {
  const digest = crypto.createHmac('sha256', SIGNING_KEY)
    .update(`${timestamp}.${rawBody}`)
    .digest('base64');
  return `hmac;1;${timestamp};${digest}`;
}

async function flushBackgroundWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function expectNoMutation(): void {
  expect(processSmsWebhook).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  expect(queryOne).not.toHaveBeenCalled();
  expect(withTransaction).not.toHaveBeenCalled();
  expect(recordAuditEvent).not.toHaveBeenCalled();
  expect(sendSms).not.toHaveBeenCalled();
  expect(enqueueAirtableSync).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(config, { NODE_ENV: 'production', QUO_WEBHOOK_SIGNING_SECRET: SIGNING_SECRET });
});

afterEach(() => {
  Object.assign(config, originalConfig);
});

describe('POST /webhooks/sms signature authentication', () => {
  const rawBody = JSON.stringify(PAYLOAD);

  it('returns 503 when the signing secret is not configured', async () => {
    Object.assign(config, { QUO_WEBHOOK_SIGNING_SECRET: undefined });
    const res = await request(app)
      .post('/webhooks/sms')
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('WEBHOOK_SECURITY_NOT_CONFIGURED');
    await flushBackgroundWork();
    expectNoMutation();
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'not-a-signature'],
    ['wrong scheme', `sha256;1;${Date.now()};${Buffer.alloc(32).toString('base64')}`],
    ['wrong version', `hmac;2;${Date.now()};${Buffer.alloc(32).toString('base64')}`],
    ['invalid base64', `hmac;1;${Date.now()};not-base64!`],
    ['incorrect', `hmac;1;${Date.now()};${Buffer.alloc(32, 3).toString('base64')}`],
  ])('rejects a %s signature before processing', async (_label, headerValue) => {
    let req = request(app)
      .post('/webhooks/sms')
      .set('Content-Type', 'application/json');
    if (headerValue) req = req.set('OpenPhone-Signature', headerValue);
    const res = await req.send(rawBody);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'UNAUTHORIZED', message: 'Invalid webhook signature' });
    await flushBackgroundWork();
    expectNoMutation();
  });

  it('rejects an altered body', async () => {
    const alteredBody = JSON.stringify({ ...PAYLOAD, type: 'message.delivered' });
    const res = await request(app)
      .post('/webhooks/sms')
      .set('Content-Type', 'application/json')
      .set('OpenPhone-Signature', signature(rawBody))
      .send(alteredBody);

    expect(res.status).toBe(401);
    await flushBackgroundWork();
    expectNoMutation();
  });

  it.each([
    ['stale', -5 * 60 * 1000 - 1],
    ['future', 10 * 60 * 1000],
  ])('rejects a %s timestamp', async (_label, offset) => {
    const timestamp = Date.now() + offset;
    const res = await request(app)
      .post('/webhooks/sms')
      .set('Content-Type', 'application/json')
      .set('OpenPhone-Signature', signature(rawBody, timestamp))
      .send(rawBody);

    expect(res.status).toBe(401);
    await flushBackgroundWork();
    expectNoMutation();
  });

  it('accepts a valid signed v3 message.received and reaches SMS processing', async () => {
    const res = await request(app)
      .post('/webhooks/sms')
      .set('Content-Type', 'application/json')
      .set('OpenPhone-Signature', signature(rawBody))
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    await vi.waitFor(() => {
      expect(processSmsWebhook).toHaveBeenCalledWith(
        PAYLOAD.data.object.from,
        PAYLOAD.data.object.body,
        expect.any(String),
      );
    });
  });

  it('does not log the secret, signature, phone, message text, or raw payload', async () => {
    const headerValue = signature(rawBody);
    await request(app)
      .post('/webhooks/sms')
      .set('Content-Type', 'application/json')
      .set('OpenPhone-Signature', headerValue)
      .send(rawBody)
      .expect(200);
    await flushBackgroundWork();

    const loggedCalls = vi.mocked(logger.child).mock.results.flatMap((result) => {
      const child = result.value as {
        info: ReturnType<typeof vi.fn>;
        warn: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
      };
      return [...child.info.mock.calls, ...child.warn.mock.calls, ...child.error.mock.calls];
    });
    const serialized = JSON.stringify(loggedCalls);
    for (const sensitive of [
      SIGNING_SECRET,
      headerValue,
      PAYLOAD.data.object.from,
      PAYLOAD.data.object.body,
      rawBody,
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
  });
});
