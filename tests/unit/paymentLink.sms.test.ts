import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../../src/db/pool';

const { mockSendSms } = vi.hoisted(() => ({
  mockSendSms: vi.fn(),
}));

vi.mock('../../src/modules/sms/quo.adapter', () => ({
  sendSms: mockSendSms,
}));

import { sendPaymentLinkSms } from '../../src/modules/notifications/paymentLink.sms';

const JOB_ID = 'job-abc';
const PHONE = '+14045551234';
const CHECKOUT_URL = 'https://checkout.stripe.com/pay/cs_test_abc123';
const CORR_ID = 'corr-test-001';
const EXPECTED_MESSAGE = `Assembly Concierge: Complete your deposit to secure your preferred appointment window: ${CHECKOUT_URL}`;

describe('sendPaymentLinkSms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims guard, sends SMS, and writes sent when sendSms succeeds with a messageId', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: JOB_ID }] as any); // guard claims slot
    mockSendSms.mockResolvedValueOnce({ messageId: 'msg-123' });

    await sendPaymentLinkSms(JOB_ID, PHONE, CHECKOUT_URL, CORR_ID);

    expect(mockSendSms).toHaveBeenCalledOnce();
    expect(mockSendSms).toHaveBeenCalledWith(PHONE, EXPECTED_MESSAGE, CORR_ID);
    expect(vi.mocked(query)).toHaveBeenCalledTimes(2);
    const statusSql = vi.mocked(query).mock.calls[1][0] as string;
    expect(statusSql).toContain("'sent'");
  });

  it('skips sending and makes no status write when guard returns no row', async () => {
    // default global mock returns [] — no override needed

    await sendPaymentLinkSms(JOB_ID, PHONE, CHECKOUT_URL, CORR_ID);

    expect(mockSendSms).not.toHaveBeenCalled();
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1); // only the guard UPDATE
  });

  it('writes failed when sendSms throws', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: JOB_ID }] as any); // guard claims slot
    mockSendSms.mockRejectedValueOnce(new Error('Quo API error 500'));

    await sendPaymentLinkSms(JOB_ID, PHONE, CHECKOUT_URL, CORR_ID);

    expect(mockSendSms).toHaveBeenCalledOnce();
    expect(vi.mocked(query)).toHaveBeenCalledTimes(2);
    const statusSql = vi.mocked(query).mock.calls[1][0] as string;
    expect(statusSql).toContain("'failed'");
  });

  it('writes failed when sendSms returns no messageId', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: JOB_ID }] as any); // guard claims slot
    mockSendSms.mockResolvedValueOnce({ messageId: null });

    await sendPaymentLinkSms(JOB_ID, PHONE, CHECKOUT_URL, CORR_ID);

    expect(mockSendSms).toHaveBeenCalledOnce();
    expect(vi.mocked(query)).toHaveBeenCalledTimes(2);
    const statusSql = vi.mocked(query).mock.calls[1][0] as string;
    expect(statusSql).toContain("'failed'");
  });

  it('skips everything when phone is empty and never touches the DB or SMS provider', async () => {
    await sendPaymentLinkSms(JOB_ID, '', CHECKOUT_URL, CORR_ID);

    expect(mockSendSms).not.toHaveBeenCalled();
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });
});
