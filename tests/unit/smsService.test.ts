import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryOne, query, withTransaction } from '../../src/db/pool';
import { enqueueAirtableSync } from '../../src/modules/airtable-sync/airtableSync.queue';

const { mockSendSms, mockRecordAuditEvent } = vi.hoisted(() => ({
  mockSendSms: vi.fn(),
  mockRecordAuditEvent: vi.fn(),
}));

vi.mock('../../src/modules/sms/quo.adapter', () => ({
  sendSms: mockSendSms,
}));

vi.mock('../../src/modules/audit/audit.service', () => ({
  recordAuditEvent: mockRecordAuditEvent,
}));

import { processSmsWebhook } from '../../src/modules/sms/sms.service';

const contractor = {
  id: 'contractor-1',
  full_name: 'Alex Rivera',
  phone_e164: '+14045550100',
};

function activeJob(overrides: Record<string, unknown> = {}) {
  return {
    job_id: 'job-1',
    job_key: 'AC-TEST',
    job_status: 'dispatch_in_progress',
    airtable_record_id: 'rec-1',
    assignment_id: 'assignment-1',
    assignment_status: 'pending',
    dispatch_id: 'dispatch-1',
    customer_phone: '+14045550200',
    customer_otw_text_sent_at: null,
    ...overrides,
  };
}

function setupDb(job = activeJob()) {
  const mockQueryOne = vi.mocked(queryOne);
  const mockQuery = vi.mocked(query);
  const mockWithTransaction = vi.mocked(withTransaction);
  const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));

  mockQueryOne.mockResolvedValueOnce(contractor as any);
  mockQueryOne.mockResolvedValueOnce(job as any);
  mockQuery.mockResolvedValue([]);
  mockWithTransaction.mockImplementation(async (fn: any) => fn({ query: clientQuery }));

  return { clientQuery, mockQueryOne, mockQuery, mockWithTransaction };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queryOne).mockReset();
  vi.mocked(query).mockReset();
  vi.mocked(withTransaction).mockReset();
  mockSendSms.mockResolvedValue({ messageId: 'msg-1' });
  mockRecordAuditEvent.mockResolvedValue(undefined);
});

describe('processSmsWebhook command state safety', () => {
  it('accepts CONFIRM only for pending dispatch_in_progress assignments', async () => {
    const { clientQuery } = setupDb();

    await processSmsWebhook('+1 (404) 555-0100', 'confirm', 'corr-1');

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE jobs SET status = $2'),
      ['job-1', 'assigned'],
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'accepted', accepted_at = NOW()"),
      ['assignment-1'],
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()"),
      ['dispatch-1'],
    );
  });

  it('ignores CONFIRM after assignment is already accepted', async () => {
    const { mockWithTransaction } = setupDb(activeJob({
      assignment_status: 'accepted',
      job_status: 'assigned',
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'confirm', 'corr-1');

    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(enqueueAirtableSync).not.toHaveBeenCalled();
  });

  it('ignores OTW before assignment acceptance', async () => {
    const { mockWithTransaction } = setupDb(activeJob({
      assignment_status: 'pending',
      job_status: 'dispatch_in_progress',
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'otw', 'corr-1');

    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(enqueueAirtableSync).not.toHaveBeenCalled();
  });

  it('processes OTW only as tracking and customer notification for accepted assigned jobs', async () => {
    const { clientQuery, mockQueryOne, mockQuery } = setupDb(activeJob({
      assignment_status: 'accepted',
      job_status: 'assigned',
    }));
    mockQueryOne.mockResolvedValueOnce({ customer_otw_text_sent_at: null } as any);

    await processSmsWebhook('+1 (404) 555-0100', 'otw', 'corr-1');

    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE jobs SET status = $2'),
      expect.anything(),
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('contractor_en_route_at = COALESCE'),
      ['job-1'],
    );
    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('customer_otw_text_sent_at = $2'),
      ['job-1', expect.any(String), 'sent'],
    );
    expect(mockQuery.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(enqueueAirtableSync).mock.invocationCallOrder[0],
    );
  });

  it('does not resend customer OTW SMS when already sent', async () => {
    const { mockQueryOne, mockQuery } = setupDb(activeJob({
      assignment_status: 'accepted',
      job_status: 'assigned',
    }));
    mockQueryOne.mockResolvedValueOnce({ customer_otw_text_sent_at: new Date() } as any);

    await processSmsWebhook('+1 (404) 555-0100', 'otw', 'corr-1');

    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(enqueueAirtableSync).toHaveBeenCalledWith({ jobId: 'job-1', correlationId: 'corr-1' });
  });

  it('completes DONE only for accepted assigned jobs', async () => {
    const { clientQuery } = setupDb(activeJob({
      assignment_status: 'accepted',
      job_status: 'assigned',
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'done', 'corr-1');

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('completion_reported_at = NOW()'),
      ['job-1', 'completion_reported'],
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'completed', completed_at = NOW()"),
      ['assignment-1'],
    );
  });

  it('ignores DONE before acceptance', async () => {
    const { mockWithTransaction } = setupDb();

    await processSmsWebhook('+1 (404) 555-0100', 'done', 'corr-1');

    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(enqueueAirtableSync).not.toHaveBeenCalled();
  });

  it('declines pending or accepted active jobs back to ready_for_dispatch', async () => {
    const { clientQuery } = setupDb(activeJob({
      assignment_status: 'accepted',
      job_status: 'assigned',
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'decline', 'corr-1');

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE jobs SET status = $2'),
      ['job-1', 'ready_for_dispatch'],
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'declined'"),
      ['assignment-1'],
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'declined'"),
      ['dispatch-1'],
    );
  });
});
