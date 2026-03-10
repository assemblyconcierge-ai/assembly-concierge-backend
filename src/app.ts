import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { correlationIdMiddleware } from './common/middleware/correlationId';
import { globalErrorHandler } from './common/errors/errorHandler';
import { stripeWebhookRouter } from './modules/payments/stripe.webhook';
import { intakeRouter } from './modules/intake/intake.routes';
import { jobsRouter } from './modules/jobs/jobs.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { config } from './common/config';

export function createApp(): express.Application {
  const app = express();

  // ─── Security headers ───────────────────────────────────────────────────
  app.use(helmet());
  app.use(cors({ origin: config.APP_BASE_URL, credentials: true }));

  // ─── Rate limiting ───────────────────────────────────────────────────────
  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 200,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // ─── Correlation ID ──────────────────────────────────────────────────────
  app.use(correlationIdMiddleware);

  // ─── Stripe webhook MUST receive raw body — register BEFORE json() ───────
  app.use(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    stripeWebhookRouter,
  );

  // ─── JSON body parser for all other routes ───────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // ─── Health / readiness ──────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: '2.0.0',
      environment: config.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      const { getPool } = await import('./db/pool');
      await getPool().query('SELECT 1');
      res.json({ status: 'ready', db: 'connected' });
    } catch {
      res.status(503).json({ status: 'not_ready', db: 'disconnected' });
    }
  });

  // ─── Intake webhooks ─────────────────────────────────────────────────────
  app.use('/', intakeRouter);

  // ─── Jobs API ────────────────────────────────────────────────────────────
  app.use('/jobs', jobsRouter);

  // ─── Admin / config API ──────────────────────────────────────────────────
  app.use('/', adminRouter);

  // ─── 404 handler ────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found' });
  });

  // ─── Global error handler ────────────────────────────────────────────────
  app.use(globalErrorHandler);

  return app;
}
