/**
 * Onboarding Routes
 *
 * POST /webhooks/jotform/contractor-onboarding?token=<token>
 *
 * Receives inbound Jotform contractor onboarding submissions directly.
 * Secured by a query parameter token (JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN).
 *
 * The jotformBodyParser middleware (mounted in app.ts for /webhooks/jotform/*)
 * handles multipart/form-data and rawRequest JSON extraction before this handler runs.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../common/config';
import { logger } from '../../common/logger';
import {
  processOnboardingSubmission,
  type OnboardingPayload,
} from './onboarding.service';

export const onboardingRouter = Router();

/**
 * POST /webhooks/jotform/contractor-onboarding
 *
 * Security: requires ?token=<JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN>
 * Responds 202 Accepted immediately after durable receipt.
 * Processing is synchronous for now; structured for async queue upgrade.
 */
onboardingRouter.post(
  '/webhooks/jotform/contractor-onboarding',
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = req.correlationId ?? uuidv4();
    const log = logger.child({ correlationId, handler: 'contractor-onboarding-webhook' });

    // ── Token validation ──────────────────────────────────────────────────
    const expectedToken = config.JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN;
    const providedToken = req.query['token'] as string | undefined;

    if (expectedToken) {
      if (!providedToken || providedToken !== expectedToken) {
        log.warn({ hasToken: Boolean(providedToken) }, '[Onboarding] Invalid or missing webhook token');
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or missing webhook token' });
        return;
      }
    } else {
      // Token not configured — log a warning but allow through (dev/test mode)
      log.warn('[Onboarding] JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN is not set — token check skipped');
    }

    // ── Parse rawRequest ──────────────────────────────────────────────────
    const body = req.body as Record<string, unknown>;
    let rawPayload: OnboardingPayload;

    if (typeof body['rawRequest'] === 'string') {
      try {
        rawPayload = JSON.parse(body['rawRequest']) as OnboardingPayload;
        // Attach outer envelope fields if not already present
        if (!rawPayload.formID && body['formID']) rawPayload.formID = String(body['formID']);
        if (!rawPayload.submissionID && body['submissionID']) {
          rawPayload.submissionID = String(body['submissionID']);
        }
      } catch {
        log.warn({ body }, '[Onboarding] Failed to parse rawRequest — using body directly');
        rawPayload = body as OnboardingPayload;
      }
    } else {
      rawPayload = body as OnboardingPayload;
    }

    log.info(
      {
        formID: rawPayload.formID,
        submissionID: rawPayload.submissionID,
        contractorRecord: rawPayload.q34_contractorRecord,
      },
      '[Onboarding] Received contractor onboarding webhook',
    );

    // ── Process ───────────────────────────────────────────────────────────
    try {
      const result = await processOnboardingSubmission(rawPayload);

      if (result.status === 'duplicate') {
        res.status(200).json({
          status: 'duplicate',
          message: 'Submission already processed',
          contractorId: result.contractorId,
          documentStatus: result.documentStatus,
        });
        return;
      }

      res.status(200).json({
        status: 'processed',
        contractorId: result.contractorId,
        documentStatus: result.documentStatus,
        processedFiles: result.processedFiles,
        errors: result.errors,
      });
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : 'Unknown error';

      if (statusCode && statusCode < 500) {
        log.warn({ err, code }, '[Onboarding] Client error');
        res.status(statusCode).json({ error: code ?? 'BAD_REQUEST', message });
        return;
      }

      log.error({ err }, '[Onboarding] Unexpected error processing submission');
      next(err);
    }
  },
);
