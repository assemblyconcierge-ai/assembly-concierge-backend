# Assembly Concierge Backend v2

TypeScript/Node.js backend service for Assembly Concierge.
PostgreSQL is the source of truth. Stripe webhooks are payment truth. Airtable is a mirror only.

---

## Architecture

```
Jotform → POST /webhooks/jotform → Intake normalization → Job creation → Airtable sync (async)
                                                       ↓
                                          POST /jobs/:id/create-checkout-session
                                                       ↓
                                          Stripe Checkout → POST /webhooks/stripe
                                                       ↓
                                          Payment state update → Airtable sync (async)
```

## Module structure

```
src/
  app.ts                      Express app factory
  server.ts                   Entry point + graceful shutdown
  common/
    config.ts                 Environment variable schema (Zod)
    logger.ts                 Pino structured logger
    middleware/
      correlationId.ts        Correlation ID injection
      auth.ts                 Admin token auth
    errors/
      errorHandler.ts         Global error handler + AppError classes
    utils/
      index.ts                Phone normalization, job key generation, etc.
  db/
    pool.ts                   pg Pool wrapper (query, queryOne, withTransaction)
    migrate.ts                Migration runner
    migrations/
      001_initial_schema.sql  All tables, enums, indexes
      002_seed_data.sql       Service types, service areas, pricing rules
  modules/
    intake/                   Jotform webhook, normalization, idempotency
    jobs/                     Job repository, state machine, routes
    payments/                 Stripe adapter, checkout, webhook handler
    pricing/                  Pricing rules engine
    service-areas/            Service area classification
    customers/                Customer + address upsert
    audit/                    Audit event writes
    airtable-sync/            Airtable mirror adapter + BullMQ queue
    admin/                    Config endpoints, contractor management
```

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /health | None | Liveness check |
| GET | /ready | None | Readiness check (DB ping) |
| POST | /webhooks/jotform | None | Jotform submission intake |
| POST | /webhooks/stripe | Stripe sig | Stripe payment events |
| POST | /webhooks/dispatch-response | None | Contractor response (stub) |
| GET | /jobs | Admin | List/search jobs |
| GET | /jobs/:jobId | Admin | Get job + payments + audit |
| POST | /jobs/:jobId/create-checkout-session | Admin | Create Stripe checkout |
| POST | /jobs/:jobId/recalculate | Admin | Recalculate pricing |
| POST | /jobs/:jobId/mark-complete | Admin | Mark job complete |
| POST | /jobs/:jobId/create-remainder-payment | Admin | Generate remainder checkout |
| POST | /jobs/:jobId/retry-failed-actions | Admin | Retry Airtable sync |
| GET | /config/pricing | Admin | Get pricing rules |
| PUT | /config/pricing | Admin | Update pricing rule |
| GET | /config/service-areas | Admin | Get service areas |
| PUT | /config/service-areas | Admin | Update service area |
| GET | /contractors | Admin | List contractors |
| POST | /contractors | Admin | Add contractor |
| GET | /payments/:paymentId | Admin | Get payment |
| POST | /payments/:paymentId/refund | Admin | Issue refund |
| GET | /integration-failures | Admin | View failed Airtable syncs |

**Admin auth:** Pass `Authorization: Bearer <ADMIN_JWT_SECRET>` or `X-Admin-Token: <ADMIN_JWT_SECRET>`.

## Service area rules

- Hampton, GA → `in_area`
- Stockbridge, GA → `in_area`
- McDonough, GA → `in_area`
- All other cities → `quote_only` (configurable via `PUT /config/service-areas`)

## Pricing seed data (cents)

| Service | Base | Rush | Deposit |
|---|---|---|---|
| Small | $109.00 | $30.00 | $54.50 |
| Medium | $149.00 | $30.00 | $74.50 |
| Large | $199.00 | $30.00 | $99.50 |
| Treadmill | $149.00 | $30.00 | $74.50 |
| Custom | $0 | $0 | $0 |

Update via `PUT /config/pricing` before cutover.

## Quick start (local)

```bash
cp .env.example .env
# Edit .env with your DATABASE_URL and other secrets

npm install
npm run migrate:dev   # Apply migrations
npm run seed:dev      # Seed service types, areas, pricing
npm run dev           # Start with hot reload
```

## Deploy to Render

1. Create a PostgreSQL database on Render first
2. Create a Web Service pointing to this repo
3. Build command: `npm install && npm run build`
4. Start command: `npm start`
5. Set env vars: `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_JWT_SECRET`, `APP_BASE_URL`
6. After first deploy, run migrations: `npm run migrate` (or use Render Shell)
7. Add Stripe webhook endpoint: `https://your-service.onrender.com/webhooks/stripe`
   - Events: `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`
   - Copy `whsec_...` → set as `STRIPE_WEBHOOK_SECRET`

## Tests

```bash
npm test          # Run all 56 tests
npm run test:watch  # Watch mode
```

## Required environment variables

See `.env.example` for the full list. Minimum required for production:

- `DATABASE_URL` — postgres:// connection string
- `STRIPE_SECRET_KEY` — sk_live_... or sk_test_...
- `STRIPE_WEBHOOK_SECRET` — whsec_... from Stripe Dashboard
- `ADMIN_JWT_SECRET` — random 64-char hex string
- `APP_BASE_URL` — your Render service URL (for Stripe redirect URLs)
- `AIRTABLE_API_KEY` + `AIRTABLE_BASE_ID` — for Airtable mirror sync

## Guardrails (from Build Spec)

- Business-critical logic lives only in this backend — not in Jotform, Make, or Airtable
- PostgreSQL is the source of truth for all job and payment state
- Stripe webhooks are the only payment truth — never infer from front-end redirects
- Airtable sync failures never roll back core transactions
- All state transitions go through the job state machine with explicit guards
- Idempotency keys prevent duplicate processing of webhooks
- Correlation IDs trace every request across intake, payment, and sync events
