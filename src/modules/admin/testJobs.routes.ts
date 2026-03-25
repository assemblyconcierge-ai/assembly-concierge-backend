/**
 * Validation-only admin endpoints for payment lifecycle testing.
 *
 * Routes:
 *   POST /admin/test-jobs
 *     Creates a backend job via processIntake with a synthetic CanonicalIntake.
 *     Same code path as a real Jotform submission — no Jotform UI required.
 *
 *   GET /admin/jobs/:jobId/payment-events
 *     Returns all payments + payment_events rows for a job.
 *     Provides backend-truth proof that the Stripe webhook path executed.
 *
 * Safeguards:
 *   1. ENABLE_TEST_ROUTES=true must be set — routes return 404 otherwise.
 *   2. STRIPE_SECRET_KEY must start with sk_test_ — aborts if misconfigured.
 *   3. No customer-facing side effects: email/SMS providers are not wired up
 *      in processIntake (EMAIL_PROVIDER_API_KEY / SMS_PROVIDER_API_KEY are
 *      optional and unused in the current codebase). ALERT_WEBHOOK_URL is not
 *      triggered by intake — only by async failure handlers. Safe to run.
 *   4. Test jobs use @assemblyconcierge.test email domain and unique UUIDs
 *      per run — easy to identify and clean up.
 *
 * Auth: requireAdmin (X-Admin-Token or Bearer matching ADMIN_JWT_SECRET)
 *
 * Scope: validation / lifecycle testing only.
 * Safe to remove after frontend rebuild — no production logic lives here.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAdmin } from '../../common/middleware/auth';
import { config } from '../../common/config';
import { processIntake } from '../intake/intake.service';
import {
  createIntakeSubmission,
  markProcessing,
  markProcessed,
  markFailed,
} from '../intake/intake.repository';
import { CanonicalIntake } from '../intake/intake.types';
import { query } from '../../db/pool';
import { logger } from '../../common/logger';

export const testJobsRouter = Router();

// ── Guard: reject all test routes unless explicitly enabled ──────────────────
function requireTestRoutes(_req: Request, res: Response, next: NextFunction): void {
  if (config.ENABLE_TEST_ROUTES !== 'true') {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found' });
    return;
  }
  next();
}

// ── Guard: abort if Stripe key is not a test key ─────────────────────────────
function requireStripeTestKey(_req: Request, res: Response, next: NextFunction): void {
  const key = config.STRIPE_SECRET_KEY ?? '';
  if (!key.startsWith('sk_test_')) {
    res.status(500).json({
      error: 'STRIPE_KEY_UNSAFE',
      message:
        'STRIPE_SECRET_KEY does not start with sk_test_ — refusing to run test payment routes in this environment.',
    });
    return;
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/test-jobs
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Body (all optional — sensible defaults applied):
 *   serviceTypeCode  "small" | "medium" | "large" | "treadmill" | "custom"  (default: "small")
 *   city             in-area city name                                       (default: "Hampton")
 *   rushRequested    boolean                                                  (default: false)
 *   paymentMode      "deposit" | "full"                                      (default: "deposit")
 *   customerEmail    string                                                   (default: test+<ts>@assemblyconcierge.test)
 *   customerName     string                                                   (default: "Test Customer")
 *
 * Response:
 *   { jobId, jobKey, serviceAreaStatus, paymentMode, correlationId }
 */
testJobsRouter.post(
  '/test-jobs',
  requireTestRoutes,
  requireStripeTestKey,
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

      // Unique external ID per run — prevents idempotency collisions across reruns
      const externalSubmissionId = `test-${uuidv4()}`;

      // Build a synthetic CanonicalIntake — same shape as a real Jotform submission.
      // Side-effect audit (confirmed safe):
      //   - processIntake writes to: jobs, customers, intake_submissions, pricing_rules (read),
      //     service_areas (read), and enqueues an Airtable sync.
      //   - It does NOT call email/SMS providers (EMAIL_PROVIDER_API_KEY / SMS_PROVIDER_API_KEY
      //     are optional and not referenced in processIntake or any called module).
      //   - It does NOT trigger Make.com, Zapier, or any external webhook.
      //   - ALERT_WEBHOOK_URL is only called by the async failure handler in airtableSync.queue.ts,
      //     not by processIntake itself.
      const intake: CanonicalIntake = {
        externalSubmissionId,
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
          typeCode:      String(serviceTypeCode),
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
          raw: { _source: 'admin-test-jobs', paymentMode, externalSubmissionId },
        },
      };

      // Persist intake submission — mirrors the Jotform webhook path exactly
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/jobs/:jobId/payment-events
// Returns payments + payment_events for backend-truth verification.
// ─────────────────────────────────────────────────────────────────────────────
testJobsRouter.get(
  '/jobs/:jobId/payment-events',
  requireTestRoutes,
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.params;

      // All payments for this job
      const payments = await query<{
        id: string;
        payment_type: string;
        status: string;
        amount_due_cents: number;
        amount_paid_cents: number;
        provider_session_id: string | null;
        provider_payment_intent_id: string | null;
        paid_at: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT id, payment_type, status, amount_due_cents, amount_paid_cents,
                provider_session_id, provider_payment_intent_id,
                paid_at, created_at, updated_at
         FROM payments WHERE job_id = $1 ORDER BY created_at ASC`,
        [jobId],
      );

      if (!payments.length) {
        res.json({ jobId, payments: [], paymentEvents: [] });
        return;
      }

      const paymentIds = payments.map((p) => p.id);

      // All payment_events for those payments
      const paymentEvents = await query<{
        id: string;
        payment_id: string;
        provider_event_id: string;
        event_type: string;
        processed_at: string;
        idempotency_key: string;
      }>(
        `SELECT id, payment_id, provider_event_id, event_type, processed_at, idempotency_key
         FROM payment_events
         WHERE payment_id = ANY($1::uuid[])
         ORDER BY processed_at ASC`,
        [paymentIds],
      );

      res.json({ jobId, payments, paymentEvents });
    } catch (err) {
      next(err);
    }
  },
);
