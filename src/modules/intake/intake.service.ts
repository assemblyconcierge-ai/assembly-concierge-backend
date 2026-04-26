import { withTransaction } from '../../db/pool';
import { CanonicalIntake } from './intake.types';
import { classifyServiceArea } from '../service-areas/serviceArea.service';
import { calculatePricing, normalizeRushTier, rushTierLabel } from '../pricing/pricing.service';
import { upsertCustomer, createAddress } from '../customers/customer.repository';
import { createJob } from '../jobs/job.repository';
import { recordAuditEvent } from '../audit/audit.service';
import { generateJobKey, generatePublicPayToken } from '../../common/utils';
import { enqueueAirtableSync } from '../airtable-sync/airtableSync.queue';
import { createJobCheckoutSession } from '../payments/payment.service';
import { logger } from '../../common/logger';
import { query } from '../../db/pool';
import { parseSchedule } from '../../common/utils/scheduleUtils';

export interface IntakeProcessResult {
  jobId: string;
  jobKey: string;
  status: string;
  serviceAreaStatus: string;
  totalAmountCents: number;
  checkoutRequired: boolean;
  checkoutUrl?: string;
  sessionId?: string;
}

/**
 * Core intake processing service.
 * Runs inside a single database transaction:
 *   1. Classify service area
 *   2. Calculate pricing
 *   3. Upsert customer + create address
 *   4. Create job record
 *   5. Write audit event
 *   6. Enqueue Airtable sync (non-blocking)
 */
export async function processIntake(
  intakeSubmissionId: string,
  intake: CanonicalIntake,
  correlationId: string,
): Promise<IntakeProcessResult> {
  const log = logger.child({ correlationId, fn: 'processIntake' });

  // 1. Service area classification (outside transaction — read-only)
  const areaResult = await classifyServiceArea(
    intake.address.city,
    intake.address.state || 'GA',
  );
  log.info({ city: intake.address.city, areaStatus: areaResult.status }, 'Service area classified');

  // Honour the Jotform areaTag for standard service types.
  // classifyServiceArea falls back to 'quote_only' for cities not yet in the DB;
  // the areaTag (set by Jotform form logic) is the authoritative geographic signal.
  const STANDARD_TYPES = new Set(['small', 'medium', 'large', 'treadmill', 'fitness_equipment']);
  const areaTagLower = (intake.meta?.areaTag ?? '').toLowerCase();
  const effectiveAreaStatus =
    areaTagLower.startsWith('inside') && STANDARD_TYPES.has(intake.service.typeCode)
      ? 'in_area' as const
      : areaResult.status;
  if (effectiveAreaStatus !== areaResult.status) {
    log.info(
      { areaTag: intake.meta?.areaTag, dbStatus: areaResult.status, effectiveAreaStatus },
      'areaTag override applied — treating as in_area',
    );
  }

  // 2. Pricing (outside transaction — read-only)
  let pricing = null;
  let serviceTypeId: string | null = null;
  let paymentMode = 'full';

  if (effectiveAreaStatus === 'in_area' && intake.service.typeCode !== 'custom') {
    try {
      const rushTier = normalizeRushTier(intake.service.rushType ?? intake.service.rushRequested);
      pricing = await calculatePricing(intake.service.typeCode, rushTier);
      // Lookup service_type_id
      const stRows = await query<{ id: string }>(
        'SELECT id FROM service_types WHERE code = $1 AND is_active = TRUE LIMIT 1',
        [intake.service.typeCode],
      );
      serviceTypeId = stRows[0]?.id ?? null;
    } catch (err) {
      log.warn({ err, typeCode: intake.service.typeCode }, 'Pricing lookup failed — routing to error_review');
    }
  } else if (intake.service.typeCode === 'custom') {
    paymentMode = 'custom_review';
  } else {
    paymentMode = 'quote_only';
  }

  // 3. Determine job status
  let initialStatus: string;
  if (effectiveAreaStatus === 'blocked') {
    initialStatus = 'cancelled';
  } else if (effectiveAreaStatus === 'quote_only' || paymentMode === 'quote_only') {
    initialStatus = 'quoted_outside_area';
  } else if (paymentMode === 'custom_review') {
    initialStatus = 'intake_validated';
  } else if (!pricing) {
    initialStatus = 'error_review';
  } else {
    initialStatus = 'awaiting_payment';
  }

  const publicPayToken = generatePublicPayToken();

  // 4. Run all DB writes in a single transaction
  const result = await withTransaction(async (client) => {
    // Upsert customer
    const customer = await upsertCustomer(
      {
        firstName: intake.customer.firstName,
        lastName: intake.customer.lastName,
        fullName: intake.customer.fullName,
        email: intake.customer.email,
        phoneE164: intake.customer.phone,
      },
      client,
    );

    // Create address
    const address = await createAddress(
      {
        line1: intake.address.line1,
        city: intake.address.city,
        state: intake.address.state || 'GA',
        postalCode: intake.address.postalCode,
      },
      client,
    );

    // Compute schedule fields from appointment data (non-blocking — null on failure)
    const TIMEZONE = 'America/New_York';
    let scheduledStartAt: Date | null = null;
    let scheduledEndAt: Date | null = null;
    if (intake.appointment.date && intake.appointment.window) {
      try {
        const parsed = parseSchedule(intake.appointment.date, intake.appointment.window, TIMEZONE);
        scheduledStartAt = parsed.scheduledStartAt;
        scheduledEndAt = parsed.scheduledEndAt;
      } catch (schedErr) {
        log.warn(
          { err: schedErr, appointmentDate: intake.appointment.date, appointmentWindow: intake.appointment.window },
          '[Intake] Failed to parse schedule — scheduled_start_at/end_at will be null',
        );
      }
    }
    // Create job
    const jobKey = generateJobKey();
    const job = await createJob(
      {
        jobKey,
        customerId: customer.id,
        addressId: address.id,
        intakeSubmissionId,
        serviceTypeId: serviceTypeId ?? undefined,
        sourceChannel: 'jotform',
        serviceAreaStatus: effectiveAreaStatus,
        cityDetected: intake.address.city,
        rushRequested: intake.service.rushRequested,
        rushType: rushTierLabel(normalizeRushTier(intake.service.rushType ?? intake.service.rushRequested)),
        paymentMode,
        subtotalAmountCents: pricing?.subtotalCents ?? 0,
        rushAmountCents: pricing?.rushAmountCents ?? 0,
        depositAmountCents: pricing?.depositCents ?? 0,
        remainderAmountCents: pricing?.remainderCents ?? 0,
        totalAmountCents: pricing?.totalCents ?? 0,
        basePriceCents: pricing?.basePriceCents ?? 0,
        flatPayoutCents: pricing?.flatPayoutCents ?? 0,
        contractorRushBonusCents: pricing?.contractorRushBonusCents ?? 0,
        contractorTotalPayoutCents: pricing?.payoutCents ?? 0,
        rushPlatformShareCents: pricing?.rushPlatformShareCents ?? 0,
        stripeFeeCents: pricing?.stripeFeeCents ?? 0,
        jobMarginCents: pricing?.jobMarginCents ?? 0,
        status: initialStatus as any,
        appointmentDate: intake.appointment.date,
        appointmentWindow: intake.appointment.window,
        scheduledStartAt,
        scheduledEndAt,
        timezone: TIMEZONE,
        customJobDetails: intake.service.customJobDetails,
        publicPayToken,
      },
      client,
    );

    // Audit event
    await recordAuditEvent({
      aggregateType: 'job',
      aggregateId: job.id,
      eventType: 'job.created',
      actorType: 'system',
      payload: {
        jobKey,
        serviceAreaStatus: effectiveAreaStatus,
        serviceTypeCode: intake.service.typeCode,
        rushRequested: intake.service.rushRequested,
        rushType: rushTierLabel(normalizeRushTier(intake.service.rushType ?? intake.service.rushRequested)),
        totalAmountCents: pricing?.totalCents ?? 0,
        initialStatus,
      },
      correlationId,
      client,
    });

    return {
      jobId: job.id,
      jobKey: job.job_key,
      status: job.status,
      serviceAreaStatus: effectiveAreaStatus,
      totalAmountCents: job.total_amount_cents,
      checkoutRequired: initialStatus === 'awaiting_payment',
    };
  });

  // 5. Enqueue Airtable sync (non-blocking — failure does not affect core flow)
  try {
    await enqueueAirtableSync({ jobId: result.jobId, correlationId });
  } catch (err) {
    log.warn({ err, jobId: result.jobId }, 'Airtable sync enqueue failed — will retry');
  }

  // 6. Auto-trigger checkout session creation if payment is required (fire-and-forget)
  // This ensures payment ownership remains with backend + Stripe, not Jotform or Make.
  const rawPaymentType = (intake.financials?.paymentType ?? '').toLowerCase();
  const checkoutType: 'full' | 'deposit' = rawPaymentType.includes('full') ? 'full' : 'deposit';
  if (result.checkoutRequired) {
    setImmediate(async () => {
      try {
        const { checkoutUrl, sessionId } = await createJobCheckoutSession(
          result.jobId,
          checkoutType,
          correlationId,
        );
        log.info(
          { jobId: result.jobId, sessionId, checkoutUrl },
          'Checkout session auto-created after intake',
        );
      } catch (err) {
        log.error(
          { err, jobId: result.jobId, correlationId },
          'Auto-checkout creation failed — admin can retry via POST /jobs/:jobId/create-checkout-session',
        );
      }
    });
  }

  return result;
}
