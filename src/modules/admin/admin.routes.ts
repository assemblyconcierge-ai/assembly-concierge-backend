import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../../common/middleware/auth';
import { getAllPricingRules, upsertPricingRule } from '../pricing/pricing.service';
import { getAllServiceAreas, upsertServiceArea } from '../service-areas/serviceArea.service';
import { query } from '../../db/pool';

export const adminRouter = Router();

// ─────────────────────────────────────────────
// PRICING CONFIG
// ─────────────────────────────────────────────

adminRouter.get('/config/pricing', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rules = await getAllPricingRules();
    res.json({ rules });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/config/pricing', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      serviceTypeCode: z.string().min(1),
      basePriceCents: z.number().int().min(0),
      rushPriceCents: z.number().int().min(0).default(0),
      defaultDepositCents: z.number().int().min(0).optional(),
      payoutCents: z.number().int().min(0).optional(),
    });
    const body = schema.parse(req.body);
    const rule = await upsertPricingRule(body);
    res.json({ rule });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// SERVICE AREAS CONFIG
// ─────────────────────────────────────────────

adminRouter.get('/config/service-areas', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const areas = await getAllServiceAreas();
    res.json({ areas });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/config/service-areas', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      city: z.string().min(1),
      state: z.string().length(2).default('GA'),
      status: z.enum(['in_area', 'quote_only', 'blocked']),
      notes: z.string().optional(),
    });
    const body = schema.parse(req.body);
    const area = await upsertServiceArea(body);
    res.json({ area });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// CONTRACTORS
// ─────────────────────────────────────────────

adminRouter.get('/contractors', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const contractors = await query(
      'SELECT * FROM contractors WHERE is_active = TRUE ORDER BY full_name',
    );
    res.json({ contractors });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/contractors', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      fullName: z.string().min(1),
      phoneE164: z.string().min(10),
      email: z.string().email().optional(),
      city: z.string().optional(),
      notes: z.string().optional(),
    });
    const body = schema.parse(req.body);
    const { v4: uuidv4 } = await import('uuid');
    const rows = await query(
      `INSERT INTO contractors (id, full_name, phone_e164, email, city, notes, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING *`,
      [uuidv4(), body.fullName, body.phoneE164, body.email ?? null, body.city ?? null, body.notes ?? null],
    );
    res.status(201).json({ contractor: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// PAYMENTS
// ─────────────────────────────────────────────

adminRouter.get('/payments/:paymentId', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getPaymentById } = await import('../payments/payment.service');
    const payment = await getPaymentById(req.params.paymentId);
    if (!payment) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Payment not found' });
      return;
    }
    res.json({ payment });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/payments/:paymentId/refund', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getPaymentById } = await import('../payments/payment.service');
    const payment = await getPaymentById(req.params.paymentId);
    if (!payment) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Payment not found' });
      return;
    }
    if (!payment.provider_payment_intent_id) {
      res.status(400).json({ error: 'NO_INTENT', message: 'No payment intent to refund' });
      return;
    }
    const { createRefund } = await import('../payments/stripe.adapter');
    const schema = z.object({ amountCents: z.number().int().min(1).optional() });
    const { amountCents } = schema.parse(req.body);
    const refund = await createRefund(payment.provider_payment_intent_id, amountCents);
    res.json({ refund });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// INTEGRATION FAILURES
// ─────────────────────────────────────────────

adminRouter.get('/integration-failures', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const failures = await query(
      `SELECT * FROM integration_failures WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100`,
    );
    res.json({ failures });
  } catch (err) {
    next(err);
  }
});
