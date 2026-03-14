import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { correlationIdMiddleware } from './common/middleware/correlationId';
import { jotformBodyParser } from './common/middleware/jotformBodyParser';
import { globalErrorHandler } from './common/errors/errorHandler';
import { stripeWebhookRouter } from './modules/payments/stripe.webhook';
import { intakeRouter } from './modules/intake/intake.routes';
import { jobsRouter } from './modules/jobs/jobs.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { schemaResetRouter } from './modules/admin/schemaReset.routes';
import { config } from './common/config';

// ---------------------------------------------------------------------------
// Schema readiness guard middleware
// Rejects webhook and data-write requests when the schema is not ready.
// Imported lazily to avoid circular dependency with server.ts.
// ---------------------------------------------------------------------------
function schemaGuard(_req: Request, res: Response, next: NextFunction): void {
  // Dynamic import avoids circular dep; falls back to allowing if module
  // hasn't exported yet (e.g. during tests where server.ts is not loaded).
  let ready = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const srv = require('./server') as { schemaReady?: boolean };
    if (typeof srv.schemaReady === 'boolean') ready = srv.schemaReady;
  } catch {
    // server.ts not loaded (test environment) — allow through
  }
  if (!ready) {
    res.status(503).json({
      error: 'SCHEMA_NOT_READY',
      message: 'Database schema is not ready. Check server logs for migration errors.',
    });
    return;
  }
  next();
}

export function createApp(): express.Application {
  const app = express();

  // ─── Proxy trust (Render sits behind a load balancer) ───────────────────
  // Must be set before any IP-based middleware (express-rate-limit, etc.)
  // "1" = trust exactly one hop (the Render proxy) — prevents ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
  app.set('trust proxy', 1);

  // ─── Security headers ───────────────────────────────────────────────────
  app.use(helmet());
  app.use(cors({ origin: config.APP_BASE_URL || '*', credentials: true }));

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

  // ─── Health (always responds — no DB dependency) ─────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: '2.0.0',
      environment: config.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  });

  // ─── Readiness (requires DB + schema) ────────────────────────────────────
  app.get('/ready', async (_req: Request, res: Response) => {
    // Check schemaReady flag first
    let ready = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const srv = require('./server') as { schemaReady?: boolean };
      if (typeof srv.schemaReady === 'boolean') ready = srv.schemaReady;
    } catch {
      ready = false;
    }

    if (!ready) {
      res.status(503).json({
        status: 'not_ready',
        reason: 'schema_not_verified',
        message: 'Database schema verification failed or is still pending. Check server logs.',
      });
      return;
    }

    // Also verify live DB connectivity
    try {
      const { getPool } = await import('./db/pool');
      await getPool().query('SELECT 1');
      res.json({ status: 'ready', db: 'connected', schema: 'verified' });
    } catch {
      res.status(503).json({ status: 'not_ready', db: 'disconnected' });
    }
  });

  // ─── Schema reset (one-time recovery — no schema guard, requires ALLOW_SCHEMA_RESET=true) ──
  app.use('/admin', schemaResetRouter);

  // ─── Jotform body parser ─────────────────────────────────────────────
  // Handles multipart/form-data, text/plain, and any content-type Jotform sends.
  // Also emits a debug log with content-type, content-length, user-agent, and body keys.
  // Runs after express.json/urlencoded so already-parsed bodies pass straight through.
  app.use('/webhooks/jotform', jotformBodyParser);

  // ─── Intake webhooks (schema guard applied) ───────────────────────────────
  app.use('/', schemaGuard, intakeRouter);

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
