import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('../../src/common/logger');

import { LOGGER_REDACT_PATHS } from '../../src/common/logger';

describe('logger sensitive-value redaction', () => {
  it('redacts credential headers, webhook tokens, customer PII, and SMS content', () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const testLogger = pino(
      { redact: { paths: [...LOGGER_REDACT_PATHS], censor: '[REDACTED]' } },
      destination,
    );

    testLogger.info({
      req: {
        headers: {
          authorization: 'Bearer admin-secret',
          'x-admin-token': 'admin-secret',
          'x-reset-token': 'reset-secret',
          'openphone-signature': 'hmac;1;1234567890123;signature-secret',
        },
        query: { token: 'webhook-secret' },
      },
      customerEmail: 'root@example.com',
      contractorPhone: '+14045550128',
      messageBody: 'root SMS content',
      event: {
        customerName: 'Jane Customer',
        customerEmail: 'jane@example.com',
        customerPhone: '+14045550123',
        contractorPhone: '+14045550127',
        phoneE164: '+14045550124',
        to: '+14045550125',
        messageBody: 'DONE AC-SECRET',
        token: 'nested-token',
      },
      normalizedIntake: {
        customerName: 'Nested Customer',
        customerEmail: 'nested@example.com',
        customerPhone: '+14045550126',
      },
    });

    expect(output).toContain('[REDACTED]');
    for (const sensitiveValue of [
      'admin-secret',
      'reset-secret',
      'signature-secret',
      'webhook-secret',
      'root@example.com',
      '+14045550128',
      'root SMS content',
      'Jane Customer',
      'jane@example.com',
      '+14045550123',
      '+14045550127',
      '+14045550124',
      '+14045550125',
      'DONE AC-SECRET',
      'nested-token',
      'Nested Customer',
      'nested@example.com',
      '+14045550126',
    ]) {
      expect(output).not.toContain(sensitiveValue);
    }
  });
});
