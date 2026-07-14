import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyLegacyQuoSignature } from '../../src/modules/sms/quoWebhookSignature';

const SIGNING_KEY = Buffer.from('unit-test-quo-signing-key');
const SIGNING_SECRET = SIGNING_KEY.toString('base64');
const NOW = 1_750_000_000_000;
const PAYLOAD = {
  id: 'event-1',
  object: 'event',
  apiVersion: 'v3',
  type: 'message.received',
  data: {
    object: {
      direction: 'incoming',
      from: '+14045550100',
      body: 'CONFIRM AC-2026-TEST',
    },
  },
};

function digest(timestamp: number, payloadBytes: Buffer): string {
  return crypto.createHmac('sha256', SIGNING_KEY)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), payloadBytes]))
    .digest('base64');
}

function header(timestamp: number, payloadBytes: Buffer): string {
  return `hmac;1;${timestamp};${digest(timestamp, payloadBytes)}`;
}

function verify(rawBody: Buffer, signatureHeader: string | undefined, nowMs = NOW) {
  return verifyLegacyQuoSignature({
    rawBody,
    parsedBody: JSON.parse(rawBody.toString('utf8')),
    signatureHeader,
    signingSecret: SIGNING_SECRET,
    nowMs,
  });
}

describe('legacy Quo webhook signature verification', () => {
  const compactBody = Buffer.from(JSON.stringify(PAYLOAD));
  const prettyBody = Buffer.from(JSON.stringify(PAYLOAD, null, 2));

  it('rejects a missing signature', () => {
    expect(verify(compactBody, undefined)).toEqual({ valid: false, reason: 'missing_signature' });
  });

  it.each([
    'not-a-signature',
    `sha256;1;${NOW};${digest(NOW, compactBody)}`,
    `hmac;2;${NOW};${digest(NOW, compactBody)}`,
    `hmac;1;${NOW};not-base64!`,
  ])('rejects a malformed signature: %s', (signatureHeader) => {
    expect(verify(compactBody, signatureHeader)).toEqual({
      valid: false,
      reason: 'malformed_signature',
    });
  });

  it('rejects an invalid base64 signing secret', () => {
    expect(verifyLegacyQuoSignature({
      rawBody: compactBody,
      parsedBody: PAYLOAD,
      signatureHeader: header(NOW, compactBody),
      signingSecret: 'not-base64!',
      nowMs: NOW,
    })).toEqual({ valid: false, reason: 'invalid_secret' });
  });

  it('rejects an incorrect signature', () => {
    const wrongDigest = Buffer.alloc(32, 7).toString('base64');
    expect(verify(compactBody, `hmac;1;${NOW};${wrongDigest}`)).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects an altered body', () => {
    const altered = Buffer.from(JSON.stringify({ ...PAYLOAD, type: 'message.delivered' }));
    expect(verify(altered, header(NOW, compactBody))).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a stale timestamp', () => {
    const timestamp = NOW - 5 * 60 * 1000 - 1;
    expect(verify(compactBody, header(timestamp, compactBody))).toEqual({
      valid: false,
      reason: 'stale_timestamp',
    });
  });

  it('rejects an excessively future timestamp', () => {
    const timestamp = NOW + 5 * 60 * 1000 + 1;
    expect(verify(compactBody, header(timestamp, compactBody))).toEqual({
      valid: false,
      reason: 'stale_timestamp',
    });
  });

  it('accepts a signature over the exact raw request bytes', () => {
    expect(verify(prettyBody, header(NOW, prettyBody))).toEqual({ valid: true, reason: 'valid' });
  });

  it('accepts a signature over compact JSON for the temporary compatibility window', () => {
    expect(verify(prettyBody, header(NOW, compactBody))).toEqual({ valid: true, reason: 'valid' });
  });

  it('accepts a valid candidate from a comma-separated signature list', () => {
    const wrongDigest = Buffer.alloc(32, 9).toString('base64');
    const candidates = `hmac;1;${NOW};${wrongDigest}, ${header(NOW, compactBody)}`;
    expect(verify(compactBody, candidates)).toEqual({ valid: true, reason: 'valid' });
  });
});
