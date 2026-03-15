import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getJobById,
  getJobByKey,
  searchJobs,
  updateJobStatus,
} from './job.repository';
import { getPaymentsByJobId, createJobCheckoutSession } from '../payments/payment.service';
import { getAuditEvents } from '../audit/audit.service';
import { calculatePricing } from '../pricing/pricing.service';
import { assertTransition } from './job.stateMachine';
import { recordAuditEvent } from '../audit/audit.service';
import { enqueueAirtableSync } from '../airtable-sync/airtableSync.queue';
import { requireAdmin } from '../../common/middleware/auth';
import { logger } from '../../common/logger';

export const jobsRouter = Router();

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
