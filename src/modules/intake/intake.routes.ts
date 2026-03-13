import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../common/logger';
import { computeIdempotencyKey } from '../../common/utils';
import { normalizeJotformPayload } from './jotform.normalizer';
import {
  findByIdempotencyKey,
  createIntakeSubmission,
  markProcessing,
  markProcessed,
  markFailed,
  markDuplicate,
} from './intake.repository';
import { processIntake } from './intake.service';

export const intakeRouter = Router();

/**
 * POST /webhooks/jotform
 * Receives raw Jotform submission webhook.
 * Responds fast (202) after durable receipt; processing is synchronous for MVP
 * but structured so it can be moved to a queue in Phase 4.
 */
intakeRouter.post('/webhooks/jotform', async (req: Request, res: Response, next: NextFunction) => {
  const correlationId = req.correlationId || uuidv4();
  const log = logger.child({ correlationId, handler: 'jotform-webhook' });

  try {
    const body = req.body as Record<string, unknown>;

    /**
     * Jotform webhook format:
     *   { "rawRequest": "{...JSON string...}", "formID": "12345", "formTitle": "..." }
     * The actual field data is inside the rawRequest JSON string.
     * We parse it here and fall back to using body directly if rawRequest is absent
     * (e.g., when called from Make.com or tests that send the payload directly).
     */
    let rawPayload: Record<string, unknown>;
    if (typeof body['rawRequest'] === 'string') {
      try {
        rawPayload = JSON.parse(body['rawRequest'] as string) as Record<string, unknown>;
        // Also attach formID and formTitle from the outer envelope if not already present
        if (!rawPayload['formID'] && body['formID']) rawPayload['formID'] = body['formID'];
        if (!rawPayload['formTitle'] && body['formTitle']) rawPayload['formTitle'] = body['formTitle'];
      } catch {
        log.warn({ body }, 'Failed to parse rawRequest — using body directly');
        rawPayload = body;
      }
    } else {
      // Direct JSON payload (Make.com, tests, or already-parsed format)
      rawPayload = body;
    }

    // Extract external submission ID
    const externalId =
      (rawPayload['submissionID'] as string) ||
      (rawPayload['submission_id'] as string) ||
      uuidv4();

    const idempotencyKey = computeIdempotencyKey('jotform', externalId);

    // Idempotency check — return 200 if already received
    const existing = await findByIdempotencyKey(idempotencyKey);
    if (existing) {
      log.info({ externalId, status: existing.processing_status }, 'Duplicate webhook — skipping');
      await markDuplicate(existing.id);
      res.status(200).json({
        status: 'duplicate',
        message: 'Submission already received',
        submissionId: existing.id,
        correlationId,
      });
      return;
    }

    // Persist raw payload immediately
    const submission = await createIntakeSubmission({
      source: 'jotform',
      externalSubmissionId: externalId,
      rawPayload,
      idempotencyKey,
      correlationId,
    });

    log.info({ submissionId: submission.id, externalId }, 'Intake submission persisted');

    // Acknowledge receipt immediately
    res.status(202).json({
      status: 'received',
      submissionId: submission.id,
      correlationId,
    });

    // Process asynchronously (in-process for MVP; move to queue in Phase 4)
    setImmediate(async () => {
      try {
        await markProcessing(submission.id);
        const normalized = normalizeJotformPayload(rawPayload);

        // Structured log of normalized intake — confirms field mapping is working
        log.info({
          normalizedIntake: {
            customerName:     normalized.customer.fullName,
            customerEmail:    normalized.customer.email,
            customerPhone:    normalized.customer.phone,
            city:             normalized.address.city,
            state:            normalized.address.state,
            postalCode:       normalized.address.postalCode,
            serviceTypeCode:  normalized.service.typeCode,
            rushRequested:    normalized.service.rushRequested,
            rushType:         normalized.service.rushType,
            appointmentDate:  normalized.appointment.date,
            appointmentWindow: normalized.appointment.window,
            totalAmount:      normalized.financials?.totalAmount,
            depositAmount:    normalized.financials?.amountChargedToday,
            remainingBalance: normalized.financials?.remainingBalance,
            paymentType:      normalized.financials?.paymentType,
            areaTag:          normalized.meta?.areaTag,
            uniqueId:         normalized.meta?.uniqueId,
          },
        }, 'Normalized intake object');

        const result = await processIntake(submission.id, normalized, correlationId);
        await markProcessed(submission.id, normalized);
        log.info({ jobId: result.jobId, jobKey: result.jobKey, serviceAreaStatus: result.serviceAreaStatus }, 'Intake processed successfully');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err, submissionId: submission.id }, 'Intake processing failed');
        await markFailed(submission.id, msg);
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /webhooks/dispatch-response
 * Receives contractor dispatch response (stub for Phase 6)
 */
intakeRouter.post('/webhooks/dispatch-response', (req: Request, res: Response) => {
  const correlationId = req.correlationId;
  logger.info({ correlationId, body: req.body }, 'Dispatch response received (stub)');
  res.status(200).json({ status: 'received', correlationId });
});
