/**
 * POST /admin/test-jobs
 *
 * Minimal validation-only endpoint: creates a backend job by calling processIntake
 * directly with a synthetic CanonicalIntake payload.  No Jotform, no frontend needed.
 *
 * Scope: validation / lifecycle testing only.
 * Safe to remove after frontend rebuild if desired — no production logic lives here.
 *
 * Auth: requireAdmin (X-Admin-Token or Bearer matching ADMIN_JWT_SECRET)
 */
import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAdmin } from '../../common/middleware/auth';
import { processIntake } from '../intake/intake.service';
import { createIntakeSubmission, markProcessing, markProcessed, markFailed } from '../intake/intake.repository';
import { CanonicalIntake } from '../intake/intake.types';
import { logger } from '../../common/logger';

export const testJobsRouter = Router();

/**
 * POST /admin/test-jobs
 *
 * Body (all optional — sensible defaults are applied):
 *   serviceTypeCode  string   "small" | "medium" | "large" | "treadmill" | "custom"
 *   city             string   Must be an in-area city (e.g. "Hampton")
 *   rushRequested    boolean
 *   paymentMode      string   "deposit" | "full"  (controls deposit vs pay-in-full flow)
 *   customerEmail    string
 *   customerName     string
 *
 * Response:
 *   { jobId, jobKey, serviceAreaStatus, paymentMode, correlationId }
 */
testJobsRouter.post(
  '/test-jobs',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = req.correlationId || uuidv4();
    const log = logger.child({ correlationId, handler: 'admin-test-jobs' });

    try {
      const {
        serviceTypeCode = 'small',
        city            = 'Hampton',
        rushRequested   = false,
        paymentMode     = 'deposit',
        customerEmail   = `test+${Date.now()}@assemblyconcierge.test`,
        customerName    = 'Test Customer',
      } = req.body as Record<string, unknown>;

      const [firstName, ...rest] = String(customerName).split(' ');
      const lastName = rest.join(' ') || 'User';

      // Build a synthetic CanonicalIntake — same shape as a real Jotform submission
      const intake: CanonicalIntake = {
        externalSubmissionId: `test-${uuidv4()}`,
        submittedAt: new Date().toISOString(),
        customer: {
          firstName,
          lastName,
          fullName: String(customerName),
          email:    String(customerEmail),
          phone:    '+14045550001',
        },
        address: {
          line1:      '123 Test Street',
          city:       String(city),
          state:      'GA',
          postalCode: '30228',
        },
        service: {
          typeCode:     String(serviceTypeCode),
          rushRequested: Boolean(rushRequested),
        },
        appointment: {
          date:   new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          window: 'Morning (8am-12pm)',
        },
        financials: {
          paymentType: paymentMode === 'full' ? 'Pay in Full' : '$25 Deposit',
        },
        media: [],
        source: {
          formName: 'admin-test-seed',
          raw: { _source: 'admin-test-jobs', paymentMode },
        },
      };

      // Persist intake submission (mirrors the Jotform webhook path exactly)
      const submission = await createIntakeSubmission({
        source:               'jotform',
        externalSubmissionId: intake.externalSubmissionId,
        rawPayload:           intake.source.raw,
        idempotencyKey:       `test:${intake.externalSubmissionId}`,
        correlationId,
      });

      await markProcessing(submission.id);

      let result: Awaited<ReturnType<typeof processIntake>>;
      try {
        result = await processIntake(submission.id, intake, correlationId);
        await markProcessed(submission.id, intake);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await markFailed(submission.id, msg);
        throw err;
      }

      log.info(
        { jobId: result.jobId, jobKey: result.jobKey, serviceAreaStatus: result.serviceAreaStatus },
        '[test-jobs] Job created',
      );

      res.status(201).json({
        jobId:             result.jobId,
        jobKey:            result.jobKey,
        serviceAreaStatus: result.serviceAreaStatus,
        paymentMode,
        correlationId,
      });
    } catch (err) {
      next(err);
    }
  },
);
