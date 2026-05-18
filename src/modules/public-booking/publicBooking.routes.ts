import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../common/logger';
import { computeIdempotencyKey, normalizePhone } from '../../common/utils';
import { CanonicalIntake } from '../intake/intake.types';
import {
  createIntakeSubmission,
  markProcessing,
  markProcessed,
  markFailed,
} from '../intake/intake.repository';
import { processIntake } from '../intake/intake.service';

export const publicBookingRouter = Router();

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const publicBookingSchema = z
  .object({
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    email: z.string().trim().email(),
    phone: z.string().trim().min(7),
    addressLine1: z.string().trim().min(1),
    city: z.string().trim().min(1),
    state: z
      .string()
      .trim()
      .length(2)
      .default('GA')
      .transform((value) => value.toUpperCase()),
    postalCode: z.string().trim().min(1).optional(),
    serviceType: z.enum(['small', 'medium', 'large', 'treadmill']),
    rushType: z.enum(['No Rush', 'Same-day (+30)', 'Next-day (+20)']).default('No Rush'),
    appointmentDate: z.string().regex(isoDatePattern).optional(),
    appointmentWindow: z.enum(['Morning(8am-12pm)', 'Afternoon(12pm-4pm)', 'Evening(4pm-8pm)']),
    paymentType: z.enum(['deposit', 'full']).default('deposit'),
    customJobDetails: z.string().trim().min(1).optional(),
  })
  .strict();

type PublicBookingRequest = z.infer<typeof publicBookingSchema>;

const publicBookingRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: 'RATE_LIMITED',
      message: 'Too many booking attempts. Please try again later.',
    });
  },
});

function isRushRequested(rushType: string): boolean {
  const normalized = rushType.trim().toLowerCase();
  return normalized !== '' && normalized !== 'no rush' && normalized !== 'no';
}

function toCanonicalIntake(
  body: PublicBookingRequest,
  externalSubmissionId: string,
): CanonicalIntake {
  return {
    externalSubmissionId,
    submittedAt: new Date().toISOString(),
    customer: {
      firstName: body.firstName,
      lastName: body.lastName,
      fullName: `${body.firstName} ${body.lastName}`.trim(),
      email: body.email,
      phone: normalizePhone(body.phone),
    },
    address: {
      line1: body.addressLine1,
      city: body.city,
      state: body.state,
      postalCode: body.postalCode,
    },
    service: {
      typeCode: body.serviceType,
      rushRequested: isRushRequested(body.rushType),
      rushType: body.rushType,
      customJobDetails: body.customJobDetails,
    },
    appointment: {
      date: body.appointmentDate,
      window: body.appointmentWindow,
    },
    financials: {
      paymentType: body.paymentType,
    },
    media: [],
    source: {
      formName: 'web-booking',
      raw: body,
    },
  };
}

publicBookingRouter.post(
  '/bookings',
  publicBookingRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = req.correlationId || uuidv4();
    const parsed = publicBookingSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: parsed.error.flatten(),
        correlationId,
      });
      return;
    }

    let submissionId: string | undefined;

    try {
      const externalSubmissionId = `web-${uuidv4()}`;
      const idempotencyKey = computeIdempotencyKey('web', externalSubmissionId);
      const intake = toCanonicalIntake(parsed.data, externalSubmissionId);
      const submission = await createIntakeSubmission({
        source: 'web',
        externalSubmissionId,
        rawPayload: parsed.data,
        idempotencyKey,
        correlationId,
      });
      submissionId = submission.id;

      await markProcessing(submission.id);
      const result = await processIntake(submission.id, intake, correlationId, { sourceChannel: 'web' });
      await markProcessed(submission.id, intake);

      res.status(201).json({
        jobKey: result.jobKey,
        publicPayToken: result.publicPayToken,
        status: result.status,
        serviceAreaStatus: result.serviceAreaStatus,
        totalAmountCents: result.totalAmountCents,
        checkoutRequired: result.checkoutRequired,
      });
    } catch (err) {
      if (submissionId) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          await markFailed(submissionId, message);
        } catch (markErr) {
          logger.error({ err: markErr, submissionId, correlationId }, 'Failed to mark public booking submission failed');
        }
      }
      next(err);
    }
  },
);
