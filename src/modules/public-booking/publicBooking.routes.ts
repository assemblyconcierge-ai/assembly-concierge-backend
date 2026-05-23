import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../db/pool';
import { config } from '../../common/config';
import { logger } from '../../common/logger';
import { computeIdempotencyKey, normalizePhone } from '../../common/utils';
import { parseSchedule } from '../../common/utils/scheduleUtils';
import { CanonicalIntake } from '../intake/intake.types';
import {
  createIntakeSubmission,
  markProcessing,
  markProcessed,
  markFailed,
} from '../intake/intake.repository';
import { processIntake } from '../intake/intake.service';
import { classifyServiceArea } from '../service-areas/serviceArea.service';

export const publicBookingRouter = Router();

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const PUBLIC_BOOKING_TIMEZONE = 'America/New_York';
const CAPACITY_STATUSES = [
  'awaiting_payment',
  'deposit_paid',
  'paid_in_full',
  'ready_for_dispatch',
  'dispatch_ready',
  'dispatch_in_progress',
  'assigned',
  'scheduled',
  'completion_reported',
] as const;

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
    appointmentDate: z.string().regex(isoDatePattern),
    appointmentWindow: z.enum(['Morning(8am-12pm)', 'Afternoon(12pm-4pm)', 'Evening(4pm-8pm)']),
    paymentType: z.enum(['deposit', 'full']).default('deposit'),
    customJobDetails: z.string().trim().min(1).optional(),
  })
  .strict();

const publicReviewRequestSchema = z
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
    serviceType: z
      .enum(['small', 'medium', 'large', 'treadmill', 'custom', 'fitness_equipment', 'unknown', 'uncertain'])
      .default('unknown'),
    reviewReason: z
      .enum(['custom_job', 'fitness_equipment', 'slot_full_manual_review', 'other_uncertain'])
      .default('other_uncertain'),
    rushType: z.enum(['No Rush', 'Same-day (+30)', 'Next-day (+20)']).default('No Rush'),
    appointmentDate: z.string().regex(isoDatePattern).optional(),
    appointmentWindow: z.enum(['Morning(8am-12pm)', 'Afternoon(12pm-4pm)', 'Evening(4pm-8pm)']).optional(),
    details: z.string().trim().min(1),
    customJobDetails: z.string().trim().min(1).optional(),
  })
  .strict();

type PublicBookingRequest = z.infer<typeof publicBookingSchema>;
type PublicFixedPriceServiceType = PublicBookingRequest['serviceType'];
type PublicReviewRequest = z.infer<typeof publicReviewRequestSchema>;

interface CapacityJobRow {
  service_type_code: string | null;
}

const publicBookingRateLimiter = rateLimit({
  windowMs: 60_000,
  max: config.NODE_ENV === 'test' ? 1_000 : 10,
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

function isSameDayPublicBooking(body: PublicBookingRequest): boolean {
  const today = DateTime.now().setZone(PUBLIC_BOOKING_TIMEZONE).toISODate();
  return body.rushType === 'Same-day (+30)' || body.appointmentDate === today;
}

function isPublicSameDayEnabled(): boolean {
  return config.PUBLIC_BOOKING_SAME_DAY_ENABLED.trim().toLowerCase() === 'true';
}

function validateSchedule(body: PublicBookingRequest): { error?: string; message?: string } {
  const appointmentDate = DateTime.fromISO(body.appointmentDate, {
    zone: PUBLIC_BOOKING_TIMEZONE,
  });
  if (!appointmentDate.isValid || appointmentDate.toISODate() !== body.appointmentDate) {
    return {
      error: 'INVALID_APPOINTMENT_DATE',
      message: 'appointmentDate must be a real calendar date in YYYY-MM-DD format.',
    };
  }

  const today = DateTime.now().setZone(PUBLIC_BOOKING_TIMEZONE).startOf('day');
  if (appointmentDate.startOf('day') < today) {
    return {
      error: 'PAST_APPOINTMENT_DATE',
      message: 'appointmentDate must not be in the past.',
    };
  }

  try {
    parseSchedule(body.appointmentDate, body.appointmentWindow, PUBLIC_BOOKING_TIMEZONE);
  } catch {
    return {
      error: 'SCHEDULE_PARSE_FAILED',
      message: 'appointmentDate and appointmentWindow could not be converted to a schedule.',
    };
  }

  return {};
}

function validateOptionalSchedule(
  body: Pick<PublicReviewRequest, 'appointmentDate' | 'appointmentWindow'>,
): { error?: string; message?: string } {
  if (!body.appointmentDate && !body.appointmentWindow) {
    return {};
  }

  if (body.appointmentWindow && !body.appointmentDate) {
    return {
      error: 'MISSING_APPOINTMENT_DATE',
      message: 'appointmentDate is required when appointmentWindow is provided.',
    };
  }

  if (!body.appointmentDate) {
    return {};
  }

  const appointmentDate = DateTime.fromISO(body.appointmentDate, {
    zone: PUBLIC_BOOKING_TIMEZONE,
  });
  if (!appointmentDate.isValid || appointmentDate.toISODate() !== body.appointmentDate) {
    return {
      error: 'INVALID_APPOINTMENT_DATE',
      message: 'appointmentDate must be a real calendar date in YYYY-MM-DD format.',
    };
  }

  const today = DateTime.now().setZone(PUBLIC_BOOKING_TIMEZONE).startOf('day');
  if (appointmentDate.startOf('day') < today) {
    return {
      error: 'PAST_APPOINTMENT_DATE',
      message: 'appointmentDate must not be in the past.',
    };
  }

  if (body.appointmentWindow) {
    try {
      parseSchedule(body.appointmentDate, body.appointmentWindow, PUBLIC_BOOKING_TIMEZONE);
    } catch {
      return {
        error: 'SCHEDULE_PARSE_FAILED',
        message: 'appointmentDate and appointmentWindow could not be converted to a schedule.',
      };
    }
  }

  return {};
}

function serviceUnits(serviceType: string | null | undefined): number {
  const unitsByService: Record<PublicFixedPriceServiceType, number> = {
    small: config.PUBLIC_BOOKING_SMALL_UNITS,
    medium: config.PUBLIC_BOOKING_MEDIUM_UNITS,
    large: config.PUBLIC_BOOKING_LARGE_UNITS,
    treadmill: config.PUBLIC_BOOKING_TREADMILL_UNITS,
  };

  if (serviceType && serviceType in unitsByService) {
    return unitsByService[serviceType as PublicFixedPriceServiceType];
  }

  return Math.max(...Object.values(unitsByService));
}

function reviewDetails(body: PublicReviewRequest): string {
  return `Review reason: ${body.reviewReason}\n${body.details}`;
}

function totalCapacityUnits(): number {
  return (
    config.PUBLIC_BOOKING_FALLBACK_CONTRACTOR_COUNT *
    config.PUBLIC_BOOKING_UNITS_PER_CONTRACTOR_WINDOW
  );
}

async function isSlotAvailable(body: PublicBookingRequest): Promise<boolean> {
  const rows = await query<CapacityJobRow>(
    `SELECT st.code AS service_type_code
       FROM jobs j
       LEFT JOIN service_types st ON st.id = j.service_type_id
      WHERE LOWER(j.city_detected) = LOWER($1)
        AND j.appointment_date = $2::date
        AND j.appointment_window = $3
        AND j.status = ANY($4::job_status[])`,
    [body.city, body.appointmentDate, body.appointmentWindow, [...CAPACITY_STATUSES]],
  );

  const usedUnits = rows.reduce((sum, row) => sum + serviceUnits(row.service_type_code), 0);
  const requestedUnits = serviceUnits(body.serviceType);
  return usedUnits + requestedUnits <= totalCapacityUnits();
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

function toReviewCanonicalIntake(
  body: PublicReviewRequest,
  externalSubmissionId: string,
  rawPayload: Record<string, unknown>,
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
      customJobDetails: reviewDetails(body),
    },
    appointment: {
      date: body.appointmentDate,
      window: body.appointmentWindow,
    },
    media: [],
    source: {
      formName: 'web-review-request',
      raw: rawPayload,
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
      const scheduleValidation = validateSchedule(parsed.data);
      if (scheduleValidation.error) {
        res.status(400).json({
          error: scheduleValidation.error,
          message: scheduleValidation.message,
          correlationId,
        });
        return;
      }

      if (!isPublicSameDayEnabled() && isSameDayPublicBooking(parsed.data)) {
        res.status(422).json({
          error: 'SAME_DAY_UNAVAILABLE',
          message: 'Same-day public booking is not available.',
          correlationId,
        });
        return;
      }

      const serviceArea = await classifyServiceArea(parsed.data.city, parsed.data.state);
      if (serviceArea.status !== 'in_area') {
        res.status(422).json({
          error: 'UNSUPPORTED_SERVICE_AREA',
          message: 'Public fixed-price booking is not available for this city.',
          correlationId,
        });
        return;
      }

      const slotAvailable = await isSlotAvailable(parsed.data);
      if (!slotAvailable) {
        res.status(409).json({
          error: 'APPOINTMENT_SLOT_UNAVAILABLE',
          recoverable: true,
          manualReviewAvailable: true,
          message: 'This window is full for instant booking. Please choose another window or request manual review.',
          correlationId,
        });
        return;
      }

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

publicBookingRouter.post(
  '/review-requests',
  publicBookingRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = req.correlationId || uuidv4();
    const parsed = publicReviewRequestSchema.safeParse(req.body);

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
      const scheduleValidation = validateOptionalSchedule(parsed.data);
      if (scheduleValidation.error) {
        res.status(400).json({
          error: scheduleValidation.error,
          message: scheduleValidation.message,
          correlationId,
        });
        return;
      }

      const externalSubmissionId = `web-review-${uuidv4()}`;
      const idempotencyKey = computeIdempotencyKey('web', externalSubmissionId);
      const rawPayload = {
        ...parsed.data,
        requestType: 'manual_review',
      };
      const intake = toReviewCanonicalIntake(parsed.data, externalSubmissionId, rawPayload);
      const submission = await createIntakeSubmission({
        source: 'web',
        externalSubmissionId,
        rawPayload,
        idempotencyKey,
        correlationId,
      });
      submissionId = submission.id;

      await markProcessing(submission.id);
      const result = await processIntake(submission.id, intake, correlationId, {
        sourceChannel: 'web',
        forceReviewOnly: true,
      });
      await markProcessed(submission.id, intake);

      res.status(201).json({
        requestId: result.jobKey,
        status: 'received',
        message: 'Your request was received for manual review.',
        correlationId,
      });
    } catch (err) {
      if (submissionId) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          await markFailed(submissionId, message);
        } catch (markErr) {
          logger.error({ err: markErr, submissionId, correlationId }, 'Failed to mark public review request failed');
        }
      }
      next(err);
    }
  },
);
