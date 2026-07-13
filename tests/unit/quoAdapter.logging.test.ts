import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/common/config';
import { logger } from '../../src/common/logger';
import { sendSms } from '../../src/modules/sms/quo.adapter';

const originalFetch = global.fetch;
const originalQuoConfig = {
  QUO_API_KEY: config.QUO_API_KEY,
  QUO_PHONE_NUMBER: config.QUO_PHONE_NUMBER,
  QUO_PHONE_NUMBER_ID: config.QUO_PHONE_NUMBER_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(config, {
    QUO_API_KEY: 'test-quo-api-key',
    QUO_PHONE_NUMBER: '+14045550000',
    QUO_PHONE_NUMBER_ID: 'phone-number-id',
  });
  global.fetch = vi.fn(async () => new Response(
    JSON.stringify({ data: { id: 'message-id' } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  Object.assign(config, originalQuoConfig);
});

describe('Quo adapter logging safety', () => {
  it('does not log the destination phone and still logs the provider message ID', async () => {
    const destination = '+14045550999';
    await sendSms(destination, 'Operational message', 'corr-quo-log');

    const childResults = vi.mocked(logger.child).mock.results;
    const loggedCalls = childResults.flatMap((result) => {
      const child = result.value as { info: ReturnType<typeof vi.fn> };
      return child?.info?.mock.calls ?? [];
    });
    const serializedLogs = JSON.stringify(loggedCalls);
    expect(serializedLogs).not.toContain(destination);
    expect(serializedLogs).toContain('message-id');
  });
});
