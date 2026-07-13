import pino from 'pino';
import { config } from './config';

export const LOGGER_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers["x-admin-token"]',
  'req.headers["x-reset-token"]',
  'req.query.token',
  'token',
  '*.token',
  'webhookToken',
  '*.webhookToken',
  'email',
  '*.email',
  'phone',
  '*.phone',
  'phone_e164',
  '*.phone_e164',
  'phoneE164',
  '*.phoneE164',
  'customerEmail',
  '*.customerEmail',
  'customerPhone',
  '*.customerPhone',
  'customerName',
  '*.customerName',
  'contractorPhone',
  '*.contractorPhone',
  'messageBody',
  '*.messageBody',
  'to',
  '*.to',
  'normalizedIntake.customerName',
  'normalizedIntake.customerEmail',
  'normalizedIntake.customerPhone',
] as const;

export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : 'info',
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
  redact: {
    paths: [...LOGGER_REDACT_PATHS],
    censor: '[REDACTED]',
  },
  base: { service: 'assembly-concierge-api', env: config.NODE_ENV },
});

export type Logger = typeof logger;
