/**
 * email.service.test.ts
 *
 * Unit tests for Phase 2A email modules:
 *   - buildJotformPrefillUrl
 *   - renderCustomerCompletionEmail
 *   - renderContractorOnboardingEmail
 *   - sendCustomerCompletionEmail (INSERT-first idempotency)
 *   - sendContractorOnboardingEmail (INSERT-first idempotency + forceResend)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock('../../src/modules/email/email_events.repository', () => ({
  reserveEmailEvent: vi.fn(),
  reserveEmailEventForResend: vi.fn(),
  markEmailEventSent: vi.fn(),
  markEmailEventFailed: vi.fn(),
}));

vi.mock('../../src/modules/email/resend.adapter', () => ({
  sendViaResend: vi.fn(),
  ResendError: class ResendError extends Error {
    constructor(message: string, public statusCode?: number) {
      super(message);
      this.name = 'ResendError';
    }
  },
}));

vi.mock('../../src/common/config', () => ({
  config: {
    APP_BASE_URL: 'https://app.assemblyconcierge.com',
    JOTFORM_ONBOARDING_FORM_ID: '261801729818060',
    EMAIL_SEND_MODE: 'log_only',
    RESEND_API_KEY: '',
    CUSTOMER_EMAIL_FROM: 'Assembly Concierge <noreply@assemblyconcierge.com>',
    CUSTOMER_EMAIL_REPLY_TO: 'support@assemblyconcierge.com',
  },
}));

vi.mock('../../src/common/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  buildJotformPrefillUrl,
  renderCustomerCompletionEmail,
  renderContractorOnboardingEmail,
  sendCustomerCompletionEmail,
  sendContractorOnboardingEmail,
} from '../../src/modules/email/email.service';

import {
  reserveEmailEvent,
  reserveEmailEventForResend,
  markEmailEventSent,
  markEmailEventFailed,
} from '../../src/modules/email/email_events.repository';

import { sendViaResend } from '../../src/modules/email/resend.adapter';
import { config } from '../../src/common/config';

// ── Helpers ────────────────────────────────────────────────────────────────────

const PENDING_EVENT = {
  id: 'evt-001',
  recipient_email: 'test@example.com',
  recipient_type: 'customer' as const,
  event_type: 'customer_job_complete',
  related_job_id: 'job-001',
  related_contractor_id: null,
  status: 'pending' as const,
  provider_message_id: null,
  error_message: null,
  created_at: new Date(),
  sent_at: null,
};

const SENT_EVENT = {
  ...PENDING_EVENT,
  status: 'sent' as const,
  provider_message_id: 'resend-msg-001',
  sent_at: new Date(),
};

const CONTRACTOR_PENDING_EVENT = {
  id: 'evt-002',
  recipient_email: 'contractor@example.com',
  recipient_type: 'contractor' as const,
  event_type: 'contractor_onboarding',
  related_job_id: null,
  related_contractor_id: 'ctr-001',
  status: 'pending' as const,
  provider_message_id: null,
  error_message: null,
  created_at: new Date(),
  sent_at: null,
};

// ══════════════════════════════════════════════════════════════════════════════
// 1. buildJotformPrefillUrl
// ══════════════════════════════════════════════════════════════════════════════

describe('buildJotformPrefillUrl', () => {
  it('builds a URL with all fields populated', () => {
    const url = buildJotformPrefillUrl({
      airtableRecordId: 'recABC123',
      backendContractorId: 'ctr-001',
      legalFullName: 'Marcus Johnson',
      preferredName: 'Marcus',
      phoneE164: '+14045551234',
      email: 'marcus@example.com',
    });
    expect(url).toContain('q34_contractorRecord=recABC123');
    expect(url).toContain('q35_backendContractor=ctr-001');
    expect(url).toContain('q43_typeA=Marcus%20Johnson');
    expect(url).toContain('q5_q5_textbox3=Marcus');
    expect(url).toContain('q6_q6_phone4%5Bfull%5D=%2B14045551234');
    expect(url).toContain('q7_q7_phone5%5Bfull%5D=%2B14045551234');
    expect(url).toContain('q8_q8_email6=marcus%40example.com');
  });

  it('omits null/undefined fields', () => {
    const url = buildJotformPrefillUrl({
      backendContractorId: 'ctr-001',
      legalFullName: null,
      phoneE164: null,
      email: null,
    });
    expect(url).not.toContain('q34_contractorRecord');
    expect(url).not.toContain('q43_typeA');
    expect(url).not.toContain('q6_q6_phone4');
    expect(url).not.toContain('q8_q8_email6');
    expect(url).toContain('q35_backendContractor=ctr-001');
  });

  it('omits preferredName when not provided', () => {
    const url = buildJotformPrefillUrl({ backendContractorId: 'ctr-001', legalFullName: 'Marcus' });
    expect(url).not.toContain('q5_q5_textbox3');
  });

  it('includes preferredName when provided', () => {
    const url = buildJotformPrefillUrl({
      backendContractorId: 'ctr-001',
      preferredName: 'Marc',
    });
    expect(url).toContain('q5_q5_textbox3=Marc');
  });

  it('returns base URL with no query string when only backendContractorId is provided', () => {
    const url = buildJotformPrefillUrl({ backendContractorId: 'ctr-001' });
    expect(url).toContain('261801729818060');
    expect(url).toContain('q35_backendContractor=ctr-001');
  });

  it('uses JOTFORM_ONBOARDING_FORM_ID from config', () => {
    const url = buildJotformPrefillUrl({ backendContractorId: 'ctr-001' });
    expect(url).toContain('261801729818060');
  });

  it('URL-encodes special characters in name (& is encoded, apostrophe is RFC 3986 safe)', () => {
    const url = buildJotformPrefillUrl({
      backendContractorId: 'ctr-001',
      legalFullName: "O'Brien & Sons",
    });
    expect(url).toContain('q43_typeA=');
    // & must be percent-encoded so it does not break the query string
    expect(url).toContain('%26');
    expect(url).not.toContain('& Sons');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. renderCustomerCompletionEmail
// ══════════════════════════════════════════════════════════════════════════════

describe('renderCustomerCompletionEmail', () => {
  it('contains the customer name', () => {
    const html = renderCustomerCompletionEmail({
      customerName: 'Kenneth',
      jobKey: 'AC-2026-TEST',
      serviceType: 'Treadmill Assembly',
      city: 'McDonough',
      bookAnotherUrl: 'https://app.assemblyconcierge.com/book',
    });
    expect(html).toContain('Kenneth');
  });

  it('contains the job key', () => {
    const html = renderCustomerCompletionEmail({
      customerName: 'Kenneth',
      jobKey: 'AC-2026-TEST',
      serviceType: 'Treadmill Assembly',
      city: 'McDonough',
      bookAnotherUrl: 'https://app.assemblyconcierge.com/book',
    });
    expect(html).toContain('AC-2026-TEST');
  });

  it('contains the service type', () => {
    const html = renderCustomerCompletionEmail({
      customerName: 'Kenneth',
      jobKey: 'AC-2026-TEST',
      serviceType: 'Treadmill Assembly',
      city: 'McDonough',
      bookAnotherUrl: 'https://app.assemblyconcierge.com/book',
    });
    expect(html).toContain('Treadmill Assembly');
  });

  it('contains the support email', () => {
    const html = renderCustomerCompletionEmail({
      customerName: 'Kenneth',
      jobKey: 'AC-2026-TEST',
      serviceType: 'Treadmill Assembly',
      city: 'McDonough',
      bookAnotherUrl: 'https://app.assemblyconcierge.com/book',
    });
    expect(html).toContain('support@assemblyconcierge.com');
  });

  it('contains the book-another CTA link', () => {
    const html = renderCustomerCompletionEmail({
      customerName: 'Kenneth',
      jobKey: 'AC-2026-TEST',
      serviceType: 'Treadmill Assembly',
      city: 'McDonough',
      bookAnotherUrl: 'https://app.assemblyconcierge.com/book',
    });
    expect(html).toContain('https://app.assemblyconcierge.com/book');
  });

  it('escapes HTML special characters in customer name', () => {
    const html = renderCustomerCompletionEmail({
      customerName: '<script>alert(1)</script>',
      jobKey: 'AC-2026-TEST',
      serviceType: 'Assembly',
      city: 'McDonough',
      bookAnotherUrl: 'https://app.assemblyconcierge.com/book',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. renderContractorOnboardingEmail
// ══════════════════════════════════════════════════════════════════════════════

describe('renderContractorOnboardingEmail', () => {
  it('contains the contractor name', () => {
    const html = renderContractorOnboardingEmail({
      contractorName: 'Marcus Johnson',
      onboardingFormUrl: 'https://form.jotform.com/261801729818060?q35_backendContractor=ctr-001',
    });
    expect(html).toContain('Marcus Johnson');
  });

  it('contains the onboarding form URL', () => {
    const url = 'https://form.jotform.com/261801729818060?q35_backendContractor=ctr-001';
    const html = renderContractorOnboardingEmail({ contractorName: 'Marcus', onboardingFormUrl: url });
    expect(html).toContain(url);
  });

  it('contains the support email', () => {
    const html = renderContractorOnboardingEmail({
      contractorName: 'Marcus',
      onboardingFormUrl: 'https://form.jotform.com/test',
    });
    expect(html).toContain('support@assemblyconcierge.com');
  });

  it('contains the dispatch eligibility warning', () => {
    const html = renderContractorOnboardingEmail({
      contractorName: 'Marcus',
      onboardingFormUrl: 'https://form.jotform.com/test',
    });
    expect(html).toContain('Dispatch eligibility');
  });

  it('contains all 6 onboarding step labels', () => {
    const html = renderContractorOnboardingEmail({
      contractorName: 'Marcus',
      onboardingFormUrl: 'https://form.jotform.com/test',
    });
    expect(html).toContain('Contractor Agreement');
    expect(html).toContain('W-9');
    expect(html).toContain('SMS Consent');
    expect(html).toContain('Transportation');
    expect(html).toContain('Handbook');
    expect(html).toContain('Photo ID');
  });

  it('escapes HTML special characters in contractor name', () => {
    const html = renderContractorOnboardingEmail({
      contractorName: '<b>Hacker</b>',
      onboardingFormUrl: 'https://form.jotform.com/test',
    });
    expect(html).not.toContain('<b>Hacker</b>');
    expect(html).toContain('&lt;b&gt;Hacker&lt;/b&gt;');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. sendCustomerCompletionEmail — INSERT-first idempotency
// ══════════════════════════════════════════════════════════════════════════════

describe('sendCustomerCompletionEmail', () => {
  beforeEach(() => {
    vi.mocked(reserveEmailEvent).mockReset();
    vi.mocked(markEmailEventSent).mockReset();
    vi.mocked(markEmailEventFailed).mockReset();
    vi.mocked(sendViaResend).mockReset();
    // Reset config mutations from previous tests
    (config as Record<string, unknown>).EMAIL_SEND_MODE = 'log_only';
    (config as Record<string, unknown>).RESEND_API_KEY = '';
  });

  it('returns alreadySent=true when INSERT conflicts (event already reserved)', async () => {
    vi.mocked(reserveEmailEvent).mockResolvedValueOnce({
      row: SENT_EVENT,
      alreadyExists: true,
    });

    const result = await sendCustomerCompletionEmail({
      jobId: 'job-001',
      jobKey: 'AC-2026-TEST',
      customerName: 'Kenneth',
      customerEmail: 'kenneth@example.com',
      serviceType: 'Treadmill Assembly',
      city: 'McDonough',
    });

    expect(result.alreadySent).toBe(true);
    expect(result.eventId).toBe(SENT_EVENT.id);
    expect(sendViaResend).not.toHaveBeenCalled();
  });

  it('creates a pending event and does NOT call Resend in log_only mode', async () => {
    vi.mocked(reserveEmailEvent).mockResolvedValueOnce({
      row: PENDING_EVENT,
      alreadyExists: false,
    });

    const result = await sendCustomerCompletionEmail({
      jobId: 'job-001',
      jobKey: 'AC-2026-TEST',
      customerName: 'Kenneth',
      customerEmail: 'kenneth@example.com',
      serviceType: 'Treadmill Assembly',
      city: 'McDonough',
    });

    expect(result.alreadySent).toBe(false);
    expect(result.eventId).toBe(PENDING_EVENT.id);
    expect(sendViaResend).not.toHaveBeenCalled();
    expect(markEmailEventSent).not.toHaveBeenCalled();
  });

  it('calls Resend and marks event sent in send mode', async () => {
    vi.mocked(config as Record<string, unknown>, { partial: true }).EMAIL_SEND_MODE = 'send';
    (config as Record<string, unknown>).RESEND_API_KEY = 'test-key';

    vi.mocked(reserveEmailEvent).mockResolvedValueOnce({
      row: PENDING_EVENT,
      alreadyExists: false,
    });
    vi.mocked(sendViaResend).mockResolvedValueOnce({ id: 'resend-msg-001' });
    vi.mocked(markEmailEventSent).mockResolvedValueOnce(undefined);

    const result = await sendCustomerCompletionEmail({
      jobId: 'job-001',
      jobKey: 'AC-2026-TEST',
      customerName: 'Kenneth',
      customerEmail: 'kenneth@example.com',
      serviceType: 'Treadmill Assembly',
      city: 'McDonough',
    });

    expect(sendViaResend).toHaveBeenCalledOnce();
    expect(markEmailEventSent).toHaveBeenCalledWith(PENDING_EVENT.id, 'resend-msg-001');
    expect(result.providerMessageId).toBe('resend-msg-001');

    // Reset
    (config as Record<string, unknown>).EMAIL_SEND_MODE = 'log_only';
    (config as Record<string, unknown>).RESEND_API_KEY = '';
  });

  it('marks event failed and rethrows if Resend throws in send mode', async () => {
    vi.mocked(config as Record<string, unknown>, { partial: true }).EMAIL_SEND_MODE = 'send';
    (config as Record<string, unknown>).RESEND_API_KEY = 'test-key';

    vi.mocked(reserveEmailEvent).mockResolvedValueOnce({
      row: PENDING_EVENT,
      alreadyExists: false,
    });
    vi.mocked(sendViaResend).mockRejectedValueOnce(new Error('Resend 500'));
    vi.mocked(markEmailEventFailed).mockResolvedValueOnce(undefined);

    await expect(
      sendCustomerCompletionEmail({
        jobId: 'job-001',
        jobKey: 'AC-2026-TEST',
        customerName: 'Kenneth',
        customerEmail: 'kenneth@example.com',
        serviceType: 'Treadmill Assembly',
        city: 'McDonough',
      }),
    ).rejects.toThrow('Resend 500');

    // String(new Error('Resend 500')) === 'Error: Resend 500'
    expect(markEmailEventFailed).toHaveBeenCalledWith(PENDING_EVENT.id, 'Error: Resend 500');

    // Reset
    (config as Record<string, unknown>).EMAIL_SEND_MODE = 'log_only';
    (config as Record<string, unknown>).RESEND_API_KEY = '';
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. sendContractorOnboardingEmail — INSERT-first idempotency + forceResend
// ══════════════════════════════════════════════════════════════════════════════

describe('sendContractorOnboardingEmail', () => {
  beforeEach(() => {
    vi.mocked(reserveEmailEvent).mockReset();
    vi.mocked(reserveEmailEventForResend).mockReset();
    vi.mocked(markEmailEventSent).mockReset();
    vi.mocked(markEmailEventFailed).mockReset();
    vi.mocked(sendViaResend).mockReset();
    // Reset config mutations from previous tests
    (config as Record<string, unknown>).EMAIL_SEND_MODE = 'log_only';
    (config as Record<string, unknown>).RESEND_API_KEY = '';
  });

  it('returns alreadySent=true when INSERT conflicts and forceResend is false', async () => {
    const existingEvent = { ...CONTRACTOR_PENDING_EVENT, status: 'sent' as const, provider_message_id: 'msg-x' };
    vi.mocked(reserveEmailEvent).mockResolvedValueOnce({
      row: existingEvent,
      alreadyExists: true,
    });

    const result = await sendContractorOnboardingEmail({
      contractorId: 'ctr-001',
      contractorName: 'Marcus Johnson',
      contractorEmail: 'marcus@example.com',
      forceResend: false,
    });

    expect(result.alreadySent).toBe(true);
    expect(sendViaResend).not.toHaveBeenCalled();
  });

  it('uses reserveEmailEventForResend when forceResend=true', async () => {
    vi.mocked(reserveEmailEventForResend).mockResolvedValueOnce(CONTRACTOR_PENDING_EVENT);

    await sendContractorOnboardingEmail({
      contractorId: 'ctr-001',
      contractorName: 'Marcus Johnson',
      contractorEmail: 'marcus@example.com',
      forceResend: true,
    });

    expect(reserveEmailEventForResend).toHaveBeenCalledOnce();
    expect(reserveEmailEvent).not.toHaveBeenCalled();
  });

  it('returns jotformUrl in result', async () => {
    vi.mocked(reserveEmailEvent).mockResolvedValueOnce({
      row: CONTRACTOR_PENDING_EVENT,
      alreadyExists: false,
    });

    const result = await sendContractorOnboardingEmail({
      contractorId: 'ctr-001',
      contractorName: 'Marcus Johnson',
      contractorEmail: 'marcus@example.com',
      airtableRecordId: 'recABC',
    });

    expect(result.jotformUrl).toContain('261801729818060');
    expect(result.jotformUrl).toContain('q35_backendContractor=ctr-001');
  });

  it('does NOT call Resend in log_only mode', async () => {
    vi.mocked(reserveEmailEvent).mockResolvedValueOnce({
      row: CONTRACTOR_PENDING_EVENT,
      alreadyExists: false,
    });

    await sendContractorOnboardingEmail({
      contractorId: 'ctr-001',
      contractorName: 'Marcus Johnson',
      contractorEmail: 'marcus@example.com',
    });

    expect(sendViaResend).not.toHaveBeenCalled();
  });

  it('calls Resend in send mode and returns providerMessageId', async () => {
    vi.mocked(config as Record<string, unknown>, { partial: true }).EMAIL_SEND_MODE = 'send';
    (config as Record<string, unknown>).RESEND_API_KEY = 'test-key';

    vi.mocked(reserveEmailEvent).mockResolvedValueOnce({
      row: CONTRACTOR_PENDING_EVENT,
      alreadyExists: false,
    });
    vi.mocked(sendViaResend).mockResolvedValueOnce({ id: 'resend-msg-002' });
    vi.mocked(markEmailEventSent).mockResolvedValueOnce(undefined);

    const result = await sendContractorOnboardingEmail({
      contractorId: 'ctr-001',
      contractorName: 'Marcus Johnson',
      contractorEmail: 'marcus@example.com',
    });

    expect(sendViaResend).toHaveBeenCalledOnce();
    expect(result.providerMessageId).toBe('resend-msg-002');

    // Reset
    (config as Record<string, unknown>).EMAIL_SEND_MODE = 'log_only';
    (config as Record<string, unknown>).RESEND_API_KEY = '';
  });
});
