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
    customer_confirm_text_sent_at: null,
    address_line1: '123 Main St',
    address_line2: null,
    address_city: 'Atlanta',
    address_state: 'GA',
    address_postal_code: '30301',
    ...overrides,
  };
}

/**
 * Sets up standard DB mocks for a webhook call.
 * Pass a single job or an array; they become the return value of the
 * first query() call (the active-job lookup).
 */
function setupDb(jobsOrJob: ReturnType<typeof activeJob> | ReturnType<typeof activeJob>[] = activeJob()) {
  const jobs = Array.isArray(jobsOrJob) ? jobsOrJob : [jobsOrJob];
  const mockQueryOne = vi.mocked(queryOne);
  const mockQuery = vi.mocked(query);
  const mockWithTransaction = vi.mocked(withTransaction);
  const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));

  mockQueryOne.mockResolvedValueOnce(contractor as any);   // contractor lookup
  mockQuery.mockResolvedValueOnce(jobs as any);             // active-job lookup (returns array)
  mockQuery.mockResolvedValue([]);                          // subsequent query calls (UPDATEs etc.)
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

// ---------------------------------------------------------------------------
// Existing lifecycle safety tests (fc33ffe behaviour preserved)
// ---------------------------------------------------------------------------

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

  it('blocks OTW before assignment acceptance and sends confirm-first SMS', async () => {
    const { mockWithTransaction } = setupDb(activeJob({
      assignment_status: 'pending',
      job_status: 'dispatch_in_progress',
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'otw', 'corr-1');

    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('Please confirm AC-TEST first before sending OTW'),
      'corr-1',
    );
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
    // OTW text UPDATE (query index 1) must precede Airtable sync
    expect(mockQuery.mock.invocationCallOrder[1]).toBeLessThan(
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
    expect(mockQuery).toHaveBeenCalledTimes(1); // only the active-job lookup; no OTW text UPDATE
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

// ---------------------------------------------------------------------------
// Job-key routing and ambiguity guard
// ---------------------------------------------------------------------------

describe('processSmsWebhook job-key routing', () => {
  it('plain CONFIRM works when exactly one active job exists', async () => {
    const { clientQuery } = setupDb(activeJob({
      job_key: 'AC-2026-EPME',
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'confirm', 'corr-1');

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE jobs SET status = $2'),
      ['job-1', 'assigned'],
    );
  });

  it('plain OTW is rejected when multiple active jobs exist and sends ambiguity SMS', async () => {
    const job1 = activeJob({ job_id: 'job-1', job_key: 'AC-2026-EPME', assignment_status: 'accepted', job_status: 'assigned' });
    const job2 = activeJob({ job_id: 'job-2', job_key: 'AC-2026-XXXX', assignment_status: 'accepted', job_status: 'assigned' });
    const { mockWithTransaction } = setupDb([job1, job2]);

    await processSmsWebhook('+1 (404) 555-0100', 'otw', 'corr-1');

    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('multiple active Assembly Concierge jobs'),
      'corr-1',
    );
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('AC-2026-EPME'),
      'corr-1',
    );
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('AC-2026-XXXX'),
      'corr-1',
    );
    expect(enqueueAirtableSync).not.toHaveBeenCalled();
  });

  it('OTW with dashed job key routes to matching job', async () => {
    const { clientQuery, mockQueryOne } = setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      assignment_status: 'accepted',
      job_status: 'assigned',
    }));
    mockQueryOne.mockResolvedValueOnce({ customer_otw_text_sent_at: null } as any);

    await processSmsWebhook('+1 (404) 555-0100', 'OTW AC-2026-EPME', 'corr-1');

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('contractor_en_route_at = COALESCE'),
      ['job-1'],
    );
    expect(mockSendSms).toHaveBeenCalledWith(
      '+14045550200',
      expect.stringContaining('on the way'),
      'corr-1',
    );
  });

  it('OTW with no-dash job key also routes correctly', async () => {
    const { clientQuery, mockQueryOne } = setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      assignment_status: 'accepted',
      job_status: 'assigned',
    }));
    mockQueryOne.mockResolvedValueOnce({ customer_otw_text_sent_at: null } as any);

    await processSmsWebhook('+1 (404) 555-0100', 'otw AC2026EPME', 'corr-1');

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('contractor_en_route_at = COALESCE'),
      ['job-1'],
    );
  });

  it('invalid job key is rejected and sends helper SMS', async () => {
    const mockQueryOne = vi.mocked(queryOne);
    const mockQuery = vi.mocked(query);
    const mockWithTransaction = vi.mocked(withTransaction);

    mockQueryOne.mockResolvedValueOnce(contractor as any);
    mockQuery.mockResolvedValueOnce([] as any); // keyed lookup finds nothing
    mockQuery.mockResolvedValue([]);

    await processSmsWebhook('+1 (404) 555-0100', 'confirm AC-2026-XXXX', 'corr-1');

    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('could not find an active Assembly Concierge job'),
      'corr-1',
    );
    expect(enqueueAirtableSync).not.toHaveBeenCalled();
  });

  it('DONE with job key before acceptance is rejected and sends confirm-first SMS', async () => {
    const { mockWithTransaction } = setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      assignment_status: 'pending',
      job_status: 'dispatch_in_progress',
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'done AC-2026-EPME', 'corr-1');

    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('Please confirm AC-2026-EPME first before marking the job complete'),
      'corr-1',
    );
    expect(enqueueAirtableSync).not.toHaveBeenCalled();
  });

  it('successful CONFIRM sends packet URL SMS when contractor_packet_token is set', async () => {
    const packetToken = 'cpk_' + 'a'.repeat(32);
    const { clientQuery } = setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      contractor_packet_token: packetToken,
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'confirm', 'corr-1');

    // DB transition still happens
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE jobs SET status = $2'),
      ['job-1', 'assigned'],
    );
    // Post-CONFIRM SMS contains packet URL
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('Confirmed for AC-2026-EPME'),
      'corr-1',
    );
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining(`/public/contractor/jobs/${packetToken}`),
      'corr-1',
    );
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('Reply OTW AC-2026-EPME when headed there'),
      'corr-1',
    );
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('Reply DONE AC-2026-EPME when complete'),
      'corr-1',
    );
    // Address must NOT be in the SMS body — it is on the packet page
    expect(mockSendSms).not.toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('123 Main St'),
      'corr-1',
    );
  });

  it('successful CONFIRM sends fallback SMS when contractor_packet_token is null', async () => {
    setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      contractor_packet_token: null,
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'confirm', 'corr-1');

    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('Confirmed for AC-2026-EPME'),
      'corr-1',
    );
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('Job details will be provided separately'),
      'corr-1',
    );
    // No packet URL in fallback
    expect(mockSendSms).not.toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('/public/contractor/jobs/'),
      'corr-1',
    );
  });

  it('successful CONFIRM sends customer confirmation SMS to customer phone', async () => {
    setupDb(activeJob({ job_key: 'AC-2026-EPME' }));

    await processSmsWebhook('+1 (404) 555-0100', 'confirm', 'corr-1');

    expect(mockSendSms).toHaveBeenCalledWith(
      '+14045550200',
      expect.stringContaining('Your contractor has confirmed your job'),
      'corr-1',
    );
    expect(mockSendSms).toHaveBeenCalledWith(
      '+14045550200',
      expect.stringContaining("We'll text you again when they're on the way"),
      'corr-1',
    );
  });

  it('does not resend customer confirmation SMS when already sent', async () => {
    setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      customer_confirm_text_sent_at: new Date(),
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'confirm', 'corr-1');

    const customerSmsCalls = mockSendSms.mock.calls.filter(
      (call) => call[0] === '+14045550200',
    );
    expect(customerSmsCalls).toHaveLength(0);
  });

  it('customer confirmation SMS does not send when CONFIRM is blocked', async () => {
    setupDb(activeJob({ assignment_status: 'accepted', job_status: 'assigned' }));

    await processSmsWebhook('+1 (404) 555-0100', 'confirm', 'corr-1');

    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('successful CONFIRM sends fallback SMS when contractor_packet_token is absent (address line1 missing)', async () => {
    // When contractor_packet_token is not set, the fallback path runs regardless of address completeness.
    // The address is on the packet page, not in the SMS.
    setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      contractor_packet_token: null,
      address_line1: null,
      address_city: 'Decatur',
      address_state: 'GA',
      address_postal_code: '30030',
    }));
    await processSmsWebhook('+1 (404) 555-0100', 'confirm', 'corr-1');
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('Job details will be provided separately'),
      'corr-1',
    );
    // Address is NOT in the SMS body
    expect(mockSendSms).not.toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('Decatur'),
      'corr-1',
    );
  });

  it('successful DECLINE sends acknowledgement SMS to contractor', async () => {
    const { clientQuery } = setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      assignment_status: 'pending',
      job_status: 'dispatch_in_progress',
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'decline', 'corr-1');

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'declined'"),
      ['assignment-1'],
    );
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('Declined AC-2026-EPME. No further action needed.'),
      'corr-1',
    );
  });

  it('DONE with job key does not update dispatches', async () => {
    const { clientQuery } = setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      assignment_status: 'accepted',
      job_status: 'assigned',
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'done AC-2026-EPME', 'corr-1');

    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE dispatches'),
      expect.anything(),
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('completion_reported_at = NOW()'),
      ['job-1', 'completion_reported'],
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'completed', completed_at = NOW()"),
      ['assignment-1'],
    );
  });

  it('ambiguity SMS lists actual active job keys', async () => {
    const job1 = activeJob({ job_id: 'job-1', job_key: 'AC-2026-AAAA', assignment_status: 'accepted', job_status: 'assigned' });
    const job2 = activeJob({ job_id: 'job-2', job_key: 'AC-2026-BBBB', assignment_status: 'accepted', job_status: 'assigned' });
    setupDb([job1, job2]);

    await processSmsWebhook('+1 (404) 555-0100', 'done', 'corr-1');

    const sentMsg: string = mockSendSms.mock.calls[0][1];
    expect(sentMsg).toContain('AC-2026-AAAA');
    expect(sentMsg).toContain('AC-2026-BBBB');
  });

  it('ambiguity SMS uses generic [job code] example format instead of a hardcoded key', async () => {
    const job1 = activeJob({ job_id: 'job-1', job_key: 'AC-2026-AAAA', assignment_status: 'accepted', job_status: 'assigned' });
    const job2 = activeJob({ job_id: 'job-2', job_key: 'AC-2026-BBBB', assignment_status: 'accepted', job_status: 'assigned' });
    setupDb([job1, job2]);

    await processSmsWebhook('+1 (404) 555-0100', 'done', 'corr-1');

    const sentMsg: string = mockSendSms.mock.calls[0][1];
    expect(sentMsg).toContain('[job code]');
    expect(sentMsg).not.toMatch(/like: OTW AC-/);
  });

  it('OTW with job key before CONFIRM sends confirm-first SMS', async () => {
    const { mockWithTransaction } = setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      assignment_status: 'pending',
      job_status: 'dispatch_in_progress',
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'OTW AC-2026-EPME', 'corr-1');

    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('Please confirm AC-2026-EPME first before sending OTW'),
      'corr-1',
    );
    expect(enqueueAirtableSync).not.toHaveBeenCalled();
  });

  it('FINISH with job key before CONFIRM sends confirm-first SMS', async () => {
    const { mockWithTransaction } = setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      assignment_status: 'pending',
      job_status: 'dispatch_in_progress',
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'finish AC-2026-EPME', 'corr-1');

    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('Please confirm AC-2026-EPME first before marking the job complete'),
      'corr-1',
    );
    expect(enqueueAirtableSync).not.toHaveBeenCalled();
  });

  it('confirm-first SMS does not trigger customer SMS or Airtable sync', async () => {
    setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      assignment_status: 'pending',
      job_status: 'dispatch_in_progress',
    }));

    await processSmsWebhook('+1 (404) 555-0100', 'OTW AC-2026-EPME', 'corr-1');

    // Only one SMS sent - to contractor, not customer
    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockSendSms).toHaveBeenCalledWith(contractor.phone_e164, expect.any(String), 'corr-1');
    expect(mockSendSms).not.toHaveBeenCalledWith('+14045550200', expect.any(String), expect.any(String));
    expect(enqueueAirtableSync).not.toHaveBeenCalled();
  });

  it('DONE sends post-completion SMS with upload link when token is persisted', async () => {
    const { mockQuery } = setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      assignment_status: 'accepted',
      job_status: 'assigned',
    }));
    // After the transaction, the post-DONE block calls queryOne to read back the token.
    // The clientQuery inside withTransaction returns the token via SELECT.
    // We also need mockQuery to return the token for the post-transaction queryOne call.
    vi.mocked(queryOne).mockResolvedValueOnce({
      contractor_completion_token: 'cct_aabbccdd11223344aabbccdd11223344',
    } as any);

    await processSmsWebhook('+1 (404) 555-0100', 'done AC-2026-EPME', 'corr-1');

    // Post-DONE SMS sent to contractor with upload link
    expect(mockSendSms).toHaveBeenCalledWith(
      contractor.phone_e164,
      expect.stringContaining('completion reported for AC-2026-EPME'),
      'corr-1',
    );
    const sentMsg: string = mockSendSms.mock.calls[mockSendSms.mock.calls.length - 1][1];
    expect(sentMsg).toContain('Upload your completion photos here');
    expect(sentMsg).toContain('/public/contractor/completion/');
    // Token must NOT appear in SMS body (only the URL path is included, not the raw token value
    // — but the URL does contain the token as a path segment, which is expected)
    expect(sentMsg).not.toContain('payout');
  });

  it('DONE sends fallback SMS when no completion token is available', async () => {
    setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      assignment_status: 'accepted',
      job_status: 'assigned',
    }));
    // queryOne returns null for the token readback
    vi.mocked(queryOne).mockResolvedValueOnce(null);

    await processSmsWebhook('+1 (404) 555-0100', 'done AC-2026-EPME', 'corr-1');

    const sentMsg: string = mockSendSms.mock.calls[mockSendSms.mock.calls.length - 1][1];
    expect(sentMsg).toContain('completion reported for AC-2026-EPME');
    expect(sentMsg).toContain('Assembly Concierge will review the job');
    expect(sentMsg).not.toContain('Upload your completion photos here');
  });

  it('FINISH sends post-completion SMS with upload link when token is persisted', async () => {
    setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      assignment_status: 'accepted',
      job_status: 'assigned',
    }));
    vi.mocked(queryOne).mockResolvedValueOnce({
      contractor_completion_token: 'cct_aabbccdd11223344aabbccdd11223344',
    } as any);

    await processSmsWebhook('+1 (404) 555-0100', 'finish AC-2026-EPME', 'corr-1');

    const sentMsg: string = mockSendSms.mock.calls[mockSendSms.mock.calls.length - 1][1];
    expect(sentMsg).toContain('completion reported for AC-2026-EPME');
    expect(sentMsg).toContain('Upload your completion photos here');
    expect(sentMsg).toContain('/public/contractor/completion/');
  });

  it('DONE transaction sets contractor_completion_token with COALESCE', async () => {
    const { clientQuery } = setupDb(activeJob({
      job_key: 'AC-2026-EPME',
      assignment_status: 'accepted',
      job_status: 'assigned',
    }));
    // clientQuery inside transaction returns token on SELECT
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // job UPDATE
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // assignment completed UPDATE
    clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // COALESCE token UPDATE
    clientQuery.mockResolvedValueOnce({
      rows: [{ contractor_completion_token: 'cct_aabbccdd11223344aabbccdd11223344' }],
      rowCount: 1,
    } as any); // SELECT readback
    vi.mocked(queryOne).mockResolvedValueOnce({
      contractor_completion_token: 'cct_aabbccdd11223344aabbccdd11223344',
    } as any);

    await processSmsWebhook('+1 (404) 555-0100', 'done AC-2026-EPME', 'corr-1');

    // Verify COALESCE UPDATE was called
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('COALESCE(contractor_completion_token'),
      expect.arrayContaining(['assignment-1']),
    );
  });
});
