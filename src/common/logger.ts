import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : 'info',
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      '*.email',
      '*.phone',
      '*.phone_e164',
    ],
    censor: '[REDACTED]',
  },
  base: { service: 'assembly-concierge-api', env: config.NODE_ENV },
});

export type Logger = typeof logger;
