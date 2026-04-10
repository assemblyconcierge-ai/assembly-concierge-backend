import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getJobById,
  getJobByKey,
  getJobByPublicPayToken,
  searchJobs,
  updateJobStatus,
} from './job.repository';
import { queryOne } from '../../db/pool';
import { getPaymentsByJobId, createJobCheckoutSession } from '../payments/payment.service';
import { getAuditEvents } from '../audit/audit.service';
import { calculatePricing } from '../pricing/pricing.service';
import { assertTransition } from './job.stateMachine';
import { recordAuditEvent } from '../audit/audit.service';
import { enqueueAirtableSync } from '../airtable-sync/airtableSync.queue';
import { requireAdmin } from '../../common/middleware/auth';
import { logger } from '../../common/logger';
import { dispatchJobToContractor } from '../dispatch/dispatch.service';

export const jobsRouter = Router();

// GET /jobs/pay/:token — public job summary for customer pay page (no auth required)
// Returns only safe fields: no financial internals, no payout data
jobsRouter.get('/pay/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await getJobByPublicPayToken(req.params.token);
    if (!job) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
      return;
    }

    // Fetch customer name and service type label for display
    const customer = await queryOne<{ full_name: string }>(
      'SELECT full_name FROM customers WHERE id = $1',
      [job.customer_id],
    );
    const serviceType = await queryOne<{ display_name: string; code: string }>(
      'SELECT display_name, code FROM service_types WHERE id = $1',
      [job.service_type_id],
    );

    res.json({
      jobKey: job.job_key,
      status: job.status,
      customerName: customer?.full_name ?? '',
      serviceType: serviceType?.display_name ?? serviceType?.code ?? 'Assembly Service',
      rushRequested: job.rush_requested,
      appointmentDate: job.appointment_date,
      appointmentWindow: job.appointment_window,
      totalAmountCents: job.total_amount_cents,
      depositAmountCents: job.deposit_amount_cents,
      remainderAmountCents: job.remainder_amount_cents,
      paymentMode: job.payment_mode,
    });
  } catch (err) {
    next(err);
  }
});

// GET /jobs — search/list jobs (admin)
jobsRouter.get('/', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, city, serviceType, from, to, limit, offset } = req.query;
    const jobs = await searchJobs({
      status: status as any,
      city: city as string,
      serviceType: serviceType as string,
      from: from as string,
      to: to as string,
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
    });
    res.json({ jobs, count: jobs.length });
  } catch (err) {
    next(err);
  }
});

// GET /jobs/:jobId — get single job with payments and audit trail
jobsRouter.get('/:jobId', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await getJobById(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
      return;
    }
    const payments = await getPaymentsByJobId(job.id);
    const auditEvents = await getAuditEvents('job', job.id);
    res.json({ job, payments, auditEvents });
  } catch (err) {
    next(err);
  }
});

// POST /jobs/:jobId/create-checkout-session
jobsRouter.post(
  '/:jobId/create-checkout-session',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schema = z.object({
        paymentType: z.enum(['full', 'deposit', 'remainder']).default('full'),
      });
      const { paymentType } = schema.parse(req.body);
      const result = await createJobCheckoutSession(
        req.params.jobId,
        paymentType,
        req.correlationId,
      );
      // Enqueue Airtable sync so Stripe Checkout Session ID is written to Airtable
      setImmediate(() =>
        enqueueAirtableSync({ jobId: req.params.jobId, correlationId: req.correlationId })
          .catch((err) => logger.error({ err }, '[Jobs] Airtable sync after checkout failed')),
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /jobs/:jobId/recalculate — recalculate pricing from current rules
jobsRouter.post(
  '/:jobId/recalculate',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await getJobById(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
        return;
      }

      const RECALC_BLOCKED: ReadonlySet<string> = new Set(['paid_in_full', 'deposit_paid', 'closed_paid']);
      if (RECALC_BLOCKED.has(job.status)) {
        res.status(409).json({
          error: 'RECALCULATE_NOT_ALLOWED',
          message: `Cannot recalculate pricing for a job with status '${job.status}'.`,
        });
        return;
      }

      // Get service type code
      const stRows = await import('../../db/pool').then(({ query }) =>
        query<{ code: string }>(
          'SELECT code FROM service_types WHERE id = $1',
          [job.service_type_id],
        ),
      );
      const typeCode = stRows[0]?.code;
      if (!typeCode) {
        res.status(400).json({ error: 'MISSING_SERVICE_TYPE', message: 'Job has no service type' });
        return;
      }

      const pricing = await calculatePricing(typeCode, job.rush_requested);

      await import('../../db/pool').then(({ query }) =>
        query(
          `UPDATE jobs SET
             subtotal_amount_cents = $2,
             rush_amount_cents = $3,
             deposit_amount_cents = $4,
             remainder_amount_cents = $5,
             total_amount_cents = $6,
             updated_at = NOW()
           WHERE id = $1`,
          [
            job.id,
            pricing.subtotalCents,
            pricing.rushAmountCents,
            pricing.depositCents,
            pricing.remainderCents,
            pricing.totalCents,
          ],
        ),
      );

      await recordAuditEvent({
        aggregateType: 'job',
        aggregateId: job.id,
        eventType: 'job.pricing_recalculated',
        actorType: 'admin',
        payload: { pricing },
        correlationId: req.correlationId,
      });

      res.json({ message: 'Pricing recalculated', pricing });
    } catch (err) {
      next(err);
    }
  },
);

// POST /jobs/:jobId/mark-complete
jobsRouter.post(
  '/:jobId/mark-complete',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await getJobById(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
        return;
      }
      assertTransition(job.status, 'work_completed');
      await updateJobStatus(job.id, 'work_completed');
      await recordAuditEvent({
        aggregateType: 'job',
        aggregateId: job.id,
        eventType: 'job.marked_complete',
        actorType: 'admin',
        correlationId: req.correlationId,
      });
      await enqueueAirtableSync({ jobId: job.id, correlationId: req.correlationId });
      res.json({ message: 'Job marked complete', jobId: job.id });
    } catch (err) {
      next(err);
    }
  },
);

// POST /jobs/:jobId/create-remainder-payment
jobsRouter.post(
  '/:jobId/create-remainder-payment',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await createJobCheckoutSession(
        req.params.jobId,
        'remainder',
        req.correlationId,
      );
      // Enqueue Airtable sync so Stripe Checkout Session ID is written to Airtable
      setImmediate(() =>
        enqueueAirtableSync({ jobId: req.params.jobId, correlationId: req.correlationId })
          .catch((err) => logger.error({ err }, '[Jobs] Airtable sync after remainder checkout failed')),
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /jobs/:jobId/retry-failed-actions
jobsRouter.post(
  '/:jobId/retry-failed-actions',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await getJobById(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
        return;
      }
      await enqueueAirtableSync({ jobId: job.id, correlationId: req.correlationId });
      res.json({ message: 'Retry actions enqueued', jobId: job.id });
    } catch (err) {
      next(err);
    }
  },
);

// POST /jobs/:jobId/approve-dispatch — advance job to ready_for_dispatch (operator approval gate)
jobsRouter.post(
  '/:jobId/approve-dispatch',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await getJobById(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
        return;
      }
      assertTransition(job.status, 'ready_for_dispatch');
      await updateJobStatus(job.id, 'ready_for_dispatch');
      await recordAuditEvent({
        aggregateType: 'job',
        aggregateId: job.id,
        eventType: 'job.dispatch_approved',
        actorType: 'admin',
        correlationId: req.correlationId,
      });
      await enqueueAirtableSync({ jobId: job.id, correlationId: req.correlationId });
      res.json({ message: 'Job approved for dispatch', jobId: job.id, status: 'ready_for_dispatch' });
    } catch (err: any) {
      if (err?.message?.startsWith('Invalid job state transition')) {
        res.status(409).json({ error: 'CONFLICT', message: err.message });
        return;
      }
      next(err);
    }
  },
);

// POST /jobs/:jobId/dispatch — send dispatch SMS to a contractor
jobsRouter.post(
  '/:jobId/dispatch',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schema = z.object({ contractorId: z.string().uuid() });
      const { contractorId } = schema.parse(req.body);
      const result = await dispatchJobToContractor(
        req.params.jobId,
        contractorId,
        req.correlationId,
      );
      res.status(201).json({ message: 'Dispatch sent', ...result });
    } catch (err: any) {
      if (err?.statusCode === 404) {
        res.status(404).json({ error: 'NOT_FOUND', message: err.message });
        return;
      }
      if (err?.statusCode === 409) {
        res.status(409).json({ error: 'CONFLICT', message: err.message });
        return;
      }
      next(err);
    }
  },
);
