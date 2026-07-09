import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../../common/middleware/auth';
import { getAllPricingRules, upsertPricingRule } from '../pricing/pricing.service';
import { getAllServiceAreas, upsertServiceArea } from '../service-areas/serviceArea.service';
import { query, queryOne } from '../../db/pool';
import { strictNormalizePhone } from '../../common/utils';
import { recordAuditEvent } from '../audit/audit.service';
import { logger } from '../../common/logger';
import {
  sendContractorOnboardingEmail,
  sendContractorMissingDocsEmail,
  sendContractorOnboardingAcceptedEmail,
  sendContractorActivatedEmail,
} from '../email/email.service';
import { config } from '../../common/config';

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

adminRouter.get('/contractors', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const contractors = await query(
      includeInactive
        ? 'SELECT * FROM contractors ORDER BY full_name'
        : 'SELECT * FROM contractors WHERE is_active = TRUE ORDER BY full_name',
    );
    res.json({ contractors });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/contractors', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Accept phoneE164, phone, or phoneNumber for Make/Airtable compatibility
    const schema = z.object({
      fullName:    z.string().min(1),
      phoneE164:   z.string().optional(),
      phone:       z.string().optional(),
      phoneNumber: z.string().optional(),
      email:       z.string().email().optional(),
      city:        z.string().optional(),
      notes:       z.string().optional(),
    });
    const body = schema.parse(req.body);

    // Resolve raw phone from whichever field was provided
    const rawPhone = body.phoneE164 ?? body.phone ?? body.phoneNumber;
    if (!rawPhone) {
      res.status(400).json({ error: 'MISSING_PHONE', message: 'Phone number is required (phoneE164, phone, or phoneNumber)' });
      return;
    }

    // Normalize to E.164 — throws TypeError on malformed input
    let phoneE164: string;
    try {
      phoneE164 = strictNormalizePhone(rawPhone);
    } catch (normErr: any) {
      res.status(400).json({ error: 'INVALID_PHONE', message: normErr.message });
      return;
    }

    // 409 if phone already belongs to an existing contractor
    const conflict = await query(
      'SELECT id FROM contractors WHERE phone_e164 = $1',
      [phoneE164],
    );
    if (conflict[0]) {
      res.status(409).json({ error: 'PHONE_IN_USE', message: 'Phone number is already in use by another contractor' });
      return;
    }

    const { v4: uuidv4 } = await import('uuid');
    const id = uuidv4();
    const rows = await query(
      `INSERT INTO contractors (id, full_name, phone_e164, email, city, notes, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE)
       RETURNING *`,
      [id, body.fullName, phoneE164, body.email ?? null, body.city ?? null, body.notes ?? null],
    );
    const contractor = rows[0];

    // Audit event — fire-and-forget, non-blocking
    recordAuditEvent({
      aggregateType: 'contractor',
      aggregateId:   id,
      eventType:     'contractor.created',
      actorType:     'admin',
      payload:       { fullName: body.fullName, phoneE164, city: body.city ?? null },
    }).catch(() => { /* audit failure must not break contractor creation */ });

    res.status(201).json({ contractor });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/contractors/:id', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      fullName:   z.string().min(1).optional(),
      phoneE164:  z.string().min(10).optional(),
      email:      z.string().email().optional(),
      city:       z.string().optional(),
      notes:      z.string().optional(),
      isActive:   z.boolean().optional(),
    });
    const body = schema.parse(req.body);

    // 404 if contractor does not exist
    const existing = await query(
      'SELECT id FROM contractors WHERE id = $1',
      [req.params.id],
    );
    if (!existing[0]) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Contractor not found' });
      return;
    }

    // 409 if new phone conflicts with a different contractor
    if (body.phoneE164) {
      const conflict = await query(
        'SELECT id FROM contractors WHERE phone_e164 = $1 AND id != $2',
        [body.phoneE164, req.params.id],
      );
      if (conflict[0]) {
        res.status(409).json({ error: 'CONFLICT', message: 'Phone number already in use by another contractor' });
        return;
      }
    }

    // Build SET clause from only the fields present in the request body
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (body.fullName  !== undefined) { setClauses.push(`full_name  = $${idx++}`); values.push(body.fullName); }
    if (body.phoneE164 !== undefined) { setClauses.push(`phone_e164 = $${idx++}`); values.push(body.phoneE164); }
    if (body.email     !== undefined) { setClauses.push(`email      = $${idx++}`); values.push(body.email); }
    if (body.city      !== undefined) { setClauses.push(`city       = $${idx++}`); values.push(body.city); }
    if (body.notes     !== undefined) { setClauses.push(`notes      = $${idx++}`); values.push(body.notes); }
    if (body.isActive  !== undefined) { setClauses.push(`is_active  = $${idx++}`); values.push(body.isActive); }

    if (setClauses.length === 0) {
      res.status(400).json({ error: 'NO_FIELDS', message: 'No fields provided to update' });
      return;
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(req.params.id);

    const rows = await query(
      `UPDATE contractors SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING id, full_name, phone_e164, email, city, notes, is_active`,
      values,
    );
    res.json({ contractor: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// POST /contractors/:id/activate
// Dedicated activation endpoint — validates contractor readiness payload
// from Make.com/Airtable before setting is_active = TRUE.
// All 10 readiness fields must be present and true.
// Optional: backendContractorId must match :id if provided.
// ─────────────────────────────────────────────

/** All boolean readiness fields that must be true before activation. */
const ACTIVATION_REQUIRED_FIELDS = [
  'activationRequested',
  'onboardingComplete',
  'activationReady',
  'agreementReceived',
  'w9Received',
  'paymentSetupComplete',
  'smsConsentConfirmed',
  'toolsTransportationConfirmed',
  'handbookAcknowledged',
  'photoIdReceived',
  'onboardingDocumentsAccepted',
] as const;

type ActivationField = typeof ACTIVATION_REQUIRED_FIELDS[number];

adminRouter.post('/contractors/:id/activate', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const contractorId = req.params.id;

    // ── 1. Validate readiness payload ──────────────────────────────────────
    const bodySchema = z.object({
      activationRequested:           z.boolean().optional(),
      onboardingComplete:            z.boolean().optional(),
      activationReady:               z.boolean().optional(),
      agreementReceived:             z.boolean().optional(),
      w9Received:                    z.boolean().optional(),
      paymentSetupComplete:          z.boolean().optional(),
      smsConsentConfirmed:           z.boolean().optional(),
      toolsTransportationConfirmed:  z.boolean().optional(),
      handbookAcknowledged:          z.boolean().optional(),
      photoIdReceived:               z.boolean().optional(),
      // Phase 3 — owner/admin must explicitly accept onboarding documents before activation
      onboardingDocumentsAccepted:   z.boolean().optional(),
      // Optional — if provided must match :id
      backendContractorId:           z.string().optional(),
    });

    const body = bodySchema.parse(req.body);

    // Collect missing / false required fields
    const missingRequirements: string[] = [];

    for (const field of ACTIVATION_REQUIRED_FIELDS) {
      if (body[field as ActivationField] !== true) {
        missingRequirements.push(field);
      }
    }

    // backendContractorId mismatch check (only when provided)
    if (body.backendContractorId !== undefined && body.backendContractorId !== contractorId) {
      missingRequirements.push('backendContractorIdMismatch');
    }

    if (missingRequirements.length > 0) {
      res.status(422).json({
        ok: false,
        activationStatus: 'Blocked - Missing Info',
        missingRequirements,
      });
      return;
    }

    // ── 2. Look up contractor ───────────────────────────────────────────────
    const existing = await query(
      'SELECT id, is_active FROM contractors WHERE id = $1',
      [contractorId],
    );
    if (!existing[0]) {
      res.status(404).json({
        ok: false,
        activationStatus: 'Not Found',
        missingRequirements: ['contractor'],
      });
      return;
    }

    // ── 3. Already active — idempotent 200 (Make-friendly) ─────────────────
    if (existing[0].is_active === true) {
      res.status(200).json({
        ok: true,
        activationStatus: 'Already Active',
        contractorId,
        isActive: true,
        missingRequirements: [],
      });
      return;
    }

    // ── 4. Activate ─────────────────────────────────────────────────────────
    await query(
      `UPDATE contractors SET is_active = TRUE, updated_at = NOW() WHERE id = $1`,
      [contractorId],
    );

    // Audit event — fire-and-forget, non-blocking
    recordAuditEvent({
      aggregateType: 'contractor',
      aggregateId:   contractorId,
      eventType:     'contractor.activated',
      actorType:     'admin',
      correlationId: req.correlationId,
    }).catch((err: unknown) => {
      logger.warn({ err, contractorId }, '[activate] Audit event failed (non-fatal)');
    });

    res.status(200).json({
      ok: true,
      activationStatus: 'Activated',
      contractorId,
      isActive: true,
      missingRequirements: [],
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// CONTRACTOR ONBOARDING EMAIL
// ─────────────────────────────────────────────

// POST /contractors/:id/send-onboarding-email
// Sends (or logs in log_only mode) the contractor onboarding email with a
// prefilled Jotform URL. Never activates or marks the contractor dispatch-eligible.
//
// Body:
//   airtableRecordId  string  (required on first call; optional if already stored)
//   preferredName     string  (optional — used for q5_q5_textbox3 Jotform field)
//   forceResend       boolean (optional, default false)
adminRouter.post(
  '/contractors/:id/send-onboarding-email',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schema = z.object({
        airtableRecordId: z.string().min(1).optional(),
        preferredName:    z.string().max(100).optional(),
        forceResend:      z.boolean().optional().default(false),
      });
      const body = schema.parse(req.body);

      // ── 1. Look up contractor ─────────────────────────────────────────────
      const contractor = await queryOne<{
        id: string;
        full_name: string;
        email: string | null;
        phone_e164: string;
        airtable_record_id: string | null;
      }>(
        'SELECT id, full_name, email, phone_e164, airtable_record_id FROM contractors WHERE id = $1',
        [req.params.id],
      );
      if (!contractor) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Contractor not found' });
        return;
      }

      // ── 2. Require email ──────────────────────────────────────────────────
      if (!contractor.email) {
        res.status(422).json({
          error: 'MISSING_EMAIL',
          message: 'Contractor has no email address on file',
        });
        return;
      }

      // ── 3. Resolve / validate airtableRecordId ────────────────────────────
      const incomingAirtableId = body.airtableRecordId ?? null;
      let resolvedAirtableId = contractor.airtable_record_id;

      if (incomingAirtableId) {
        if (resolvedAirtableId && resolvedAirtableId !== incomingAirtableId) {
          res.status(409).json({
            error: 'AIRTABLE_RECORD_ID_MISMATCH',
            message:
              'The provided airtableRecordId does not match the stored value for this contractor',
          });
          return;
        }
        if (!resolvedAirtableId) {
          // Persist for future calls
          await query(
            'UPDATE contractors SET airtable_record_id = $2, updated_at = NOW() WHERE id = $1',
            [contractor.id, incomingAirtableId],
          );
          resolvedAirtableId = incomingAirtableId;
        }
      }

      // ── 4. Send / log email ───────────────────────────────────────────────
      const result = await sendContractorOnboardingEmail({
          contractorId:     contractor.id,
          contractorName:   contractor.full_name,
          contractorEmail:  contractor.email,
          phoneE164:        contractor.phone_e164,
          airtableRecordId: resolvedAirtableId ?? undefined,
          preferredName:    body.preferredName,
          forceResend:      body.forceResend,
        });

      if (result.alreadySent) {
        res.status(200).json({
          status:             'already_sent',
          alreadySent:        true,
          eventId:            result.eventId,
          providerMessageId:  result.providerMessageId ?? null,
          mode:               config.EMAIL_SEND_MODE,
          onboardingFormUrl:  result.jotformUrl ?? null,
          message:            'Onboarding email already sent — use forceResend=true to resend',
        });
        return;
      }

      res.status(200).json({
        status:             config.EMAIL_SEND_MODE === 'send' ? 'sent' : 'logged',
        alreadySent:        false,
        eventId:            result.eventId,
        providerMessageId:  result.providerMessageId ?? null,
        mode:               config.EMAIL_SEND_MODE,
        onboardingFormUrl:  result.jotformUrl ?? null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// Sends (or logs in log_only mode) a missing-docs / correction-needed email to the contractor.
// Requires missingOrCorrectionText in the request body.
// Never activates or marks the contractor dispatch-eligible.
//
// Body:
//   missingOrCorrectionText  string   (required)
//   onboardingFormUrl        string   (optional — include to add a resubmit button)
//   forceResend              boolean  (optional, default false)
adminRouter.post(
  '/contractors/:id/send-missing-docs-email',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schema = z.object({
        missingOrCorrectionText: z.string().min(1, 'missingOrCorrectionText is required'),
        onboardingFormUrl:       z.string().url().optional().nullable(),
        forceResend:             z.boolean().optional().default(false),
      });
      const body = schema.parse(req.body);

      // ── 1. Look up contractor ─────────────────────────────────────────────────────────────────────────────────────
      const contractor = await queryOne<{
        id: string;
        full_name: string;
        email: string | null;
      }>(
        'SELECT id, full_name, email FROM contractors WHERE id = $1',
        [req.params.id],
      );
      if (!contractor) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Contractor not found' });
        return;
      }

      // ── 2. Require email ─────────────────────────────────────────────────────────────────────────────────────────────
      if (!contractor.email) {
        res.status(422).json({ error: 'MISSING_EMAIL', message: 'Contractor has no email address on file' });
        return;
      }

      // ── 3. Send / log email ─────────────────────────────────────────────────────────────────────────────────────────────
      const result = await sendContractorMissingDocsEmail({
        contractorId:            contractor.id,
        contractorName:          contractor.full_name,
        contractorEmail:         contractor.email,
        missingOrCorrectionText: body.missingOrCorrectionText,
        onboardingFormUrl:       body.onboardingFormUrl,
        forceResend:             body.forceResend,
      });

      if (result.alreadySent) {
        res.status(200).json({
          status:            'already_sent',
          alreadySent:       true,
          eventId:           result.eventId,
          providerMessageId: result.providerMessageId ?? null,
          mode:              config.EMAIL_SEND_MODE,
          message:           'Missing-docs email already sent — use forceResend=true to resend',
        });
        return;
      }

      res.status(200).json({
        status:            config.EMAIL_SEND_MODE === 'send' ? 'sent' : 'logged',
        alreadySent:       false,
        eventId:           result.eventId,
        providerMessageId: result.providerMessageId ?? null,
        mode:              config.EMAIL_SEND_MODE,
      });
    } catch (err) {
      next(err);
    }
  },
);

// Sends (or logs in log_only mode) the onboarding-accepted email to the contractor.
// Never activates or marks the contractor dispatch-eligible.
//
// Body:
//   forceResend  boolean  (optional, default false)
adminRouter.post(
  '/contractors/:id/send-onboarding-accepted-email',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schema = z.object({
        forceResend: z.boolean().optional().default(false),
      });
      const body = schema.parse(req.body);

      // ── 1. Look up contractor ─────────────────────────────────────────────────────────────────────────────────────
      const contractor = await queryOne<{
        id: string;
        full_name: string;
        email: string | null;
      }>(
        'SELECT id, full_name, email FROM contractors WHERE id = $1',
        [req.params.id],
      );
      if (!contractor) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Contractor not found' });
        return;
      }

      // ── 2. Require email ─────────────────────────────────────────────────────────────────────────────────────────────
      if (!contractor.email) {
        res.status(422).json({ error: 'MISSING_EMAIL', message: 'Contractor has no email address on file' });
        return;
      }

      // ── 3. Send / log email ─────────────────────────────────────────────────────────────────────────────────────────────
      const result = await sendContractorOnboardingAcceptedEmail({
        contractorId:    contractor.id,
        contractorName:  contractor.full_name,
        contractorEmail: contractor.email,
        forceResend:     body.forceResend,
      });

      if (result.alreadySent) {
        res.status(200).json({
          status:            'already_sent',
          alreadySent:       true,
          eventId:           result.eventId,
          providerMessageId: result.providerMessageId ?? null,
          mode:              config.EMAIL_SEND_MODE,
          message:           'Onboarding-accepted email already sent — use forceResend=true to resend',
        });
        return;
      }

      res.status(200).json({
        status:            config.EMAIL_SEND_MODE === 'send' ? 'sent' : 'logged',
        alreadySent:       false,
        eventId:           result.eventId,
        providerMessageId: result.providerMessageId ?? null,
        mode:              config.EMAIL_SEND_MODE,
      });
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.post(
  '/contractors/:id/send-activated-email',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schema = z.object({
        forceResend: z.boolean().optional().default(false),
      });
      const body = schema.parse(req.body);

      // ── 1. Look up contractor ─────────────────────────────────────────────────────────────────────────────────────
      const contractor = await queryOne<{
        id: string;
        full_name: string;
        email: string | null;
        is_active: boolean;
      }>(
        'SELECT id, full_name, email, is_active FROM contractors WHERE id = $1',
        [req.params.id],
      );
      if (!contractor) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Contractor not found' });
        return;
      }

      // ── 2. Require email ─────────────────────────────────────────────────────────────────────────────────────────────
      if (!contractor.email) {
        res.status(422).json({ error: 'MISSING_EMAIL', message: 'Contractor has no email address on file' });
        return;
      }

      // ── 3. Require active ─────────────────────────────────────────────────────────────────────────────────────────────
      if (!contractor.is_active) {
        res.status(422).json({ error: 'NOT_ACTIVE', message: 'Contractor is not yet active — activate before sending activated email' });
        return;
      }

      // ── 4. Send / log email ─────────────────────────────────────────────────────────────────────────────────────────────
      const result = await sendContractorActivatedEmail({
        contractorId:    contractor.id,
        contractorName:  contractor.full_name,
        contractorEmail: contractor.email,
        forceResend:     body.forceResend,
      });

      // Audit event — fire-and-forget, non-blocking
      recordAuditEvent({
        aggregateType: 'contractor',
        aggregateId:   contractor.id,
        eventType:     'contractor.activated_email_sent',
        actorType:     'admin',
        correlationId: req.correlationId,
      }).catch((err: unknown) => {
        logger.warn({ err, contractorId: contractor.id }, '[send-activated-email] Audit event failed (non-fatal)');
      });

      if (result.alreadySent) {
        res.status(200).json({
          status:            'already_sent',
          alreadySent:       true,
          eventId:           result.eventId,
          providerMessageId: result.providerMessageId ?? null,
          mode:              config.EMAIL_SEND_MODE,
          message:           'Activated email already sent — use forceResend=true to resend',
        });
        return;
      }

      res.status(200).json({
        status:            config.EMAIL_SEND_MODE === 'send' ? 'sent' : 'logged',
        alreadySent:       false,
        eventId:           result.eventId,
        providerMessageId: result.providerMessageId ?? null,
        mode:              config.EMAIL_SEND_MODE,
      });
    } catch (err) {
      next(err);
    }
  },
);

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
