# Assembly Concierge Backend — Session Snapshot
**Generated:** 2026-04-04  
**Purpose:** Safe session handoff / context restore document  
**Previous snapshot:** `BACKEND_STATE_SNAPSHOT_2026-03-15.md` (HEAD at `8b096ef`)

---

## 1. Repository State

| Property | Value |
|---|---|
| Repository | `https://github.com/assemblyconcierge-ai/assembly-concierge-backend` |
| Branch | `main` |
| HEAD commit | `893e2d3` |
| Local uncommitted changes | None (working tree clean) |

### Commits Since Last Snapshot (`8b096ef` → `893e2d3`)

| Hash | Commit Message |
|---|---|
| `893e2d3` | fix: resolve circular dependency in app.ts and add state guard to recalculate endpoint |
| `1afc47b` | fix: retry loop for airtable_record_id in checkout Payments row creation |
| `7b98cad` | feat: auto-trigger checkout creation after successful intake processing |
| `2e8fe59` | feat(validation): harden test-jobs endpoint with ENABLE_TEST_ROUTES guard, sk_test_ check, and payment-events verification route |
| `d1b674e` | feat(validation): add POST /admin/test-jobs seed endpoint and test-payment-lifecycle.sh script |
| `7be7eb9` | fix: step through awaiting_remainder_payment on remainder checkout completion; add Airtable backend mirror fields |
| `c115a14` | fix: correct Airtable Payments field name and status option labels |
| `4f5165b` | feat: write Airtable Payments child rows on checkout creation and webhook completion |
| `5160bb9` | fix: use FRONTEND_BASE_URL for Stripe checkout redirect URLs |
| `420fabb` | fix: correct stripe webhook router path duplication (/ not /webhooks/stripe) |
| `092715b` | fix: fitness_equipment as distinct service type, not treadmill alias |
| `431cd5f` | feat(alert): throttle owner alerts to 1 per job per 15 minutes |
| `ca242b4` | feat(p0): owner alert on final Airtable sync failure + public pay route |
| `e423840` | fix(airtable): mapAppointmentWindow warns and skips on unknown values |
| `5832936` | fix(airtable): map Appointment Window to exact allowed values (no space before parenthesis) |

---

## 2. What Was Fixed/Built This Session (2026-04-04)

### Fix 1 — Circular Dependency in `app.ts` (`893e2d3`)
**Problem:** `app.ts` used a runtime `require('./server')` inside both `schemaGuard` middleware and the `/ready` handler to read the `schemaReady` flag. This is a circular dependency: `server.ts` imports `createApp` from `app.ts`, and `app.ts` imported back from `server.ts`.

**Fix:** Extracted the flag into `src/common/schemaState.ts` — a dependency-free shared module:
- `schemaState.ts` exports `schemaReady: boolean` and `setSchemaReady(value: boolean): void`
- `server.ts` now calls `setSchemaReady(true/false)` after migrations complete instead of mutating its own exported variable
- `app.ts` imports `{ schemaReady }` directly from `./common/schemaState` — no dynamic require, no circular dep

**Files changed:** `src/common/schemaState.ts` (new), `src/server.ts`, `src/app.ts`

---

### Fix 2 — State Guard on `/jobs/:jobId/recalculate` (`893e2d3`)
**Problem:** The recalculate endpoint had no guard — it would overwrite pricing amounts on jobs that were already paid, which could corrupt financial records.

**Fix:** Added a check at the top of the handler that blocks recalculation when `job.status` is in `{ paid_in_full, deposit_paid, closed_paid }`. Returns `409 RECALCULATE_NOT_ALLOWED` with a clear message.

**File changed:** `src/modules/jobs/jobs.routes.ts`

---

### Fix 3 — Retry Loop for `airtable_record_id` on Auto-Checkout (`1afc47b`)
**Problem:** When `processIntake()` auto-triggers checkout session creation, the parent Airtable sync that sets `jobs.airtable_record_id` may still be in flight. `createAirtablePaymentRow()` requires a non-null `airtable_record_id` to link the Payments child row to its parent Jobs record. If the record ID is null, the write fails silently.

**Fix:** Added a polling retry loop in `payment.service.ts` — polls `getJobById()` up to 10 times with 3-second delays (30-second total window) before calling `createAirtablePaymentRow()`. Logs clearly on final failure.

**File changed:** `src/modules/payments/payment.service.ts`

---

### Feature — Auto-Trigger Checkout After Intake (`7b98cad`)
**What:** `processIntake()` in `intake.service.ts` now fire-and-forget creates a Stripe Checkout Session immediately after a job reaches `awaiting_payment`, without waiting for an admin to call `POST /jobs/:jobId/create-checkout-session` manually.

**Why:** Removes the manual step that previously meant customers couldn't pay until an admin triggered checkout. Payment ownership remains fully in the backend + Stripe — not Jotform or Make.com.

**Behavior:**
- Triggered only when `checkoutRequired === true` (job status is `awaiting_payment`)
- Admin `POST /jobs/:jobId/create-checkout-session` still works for manual retry/override
- `IntakeProcessResult` now includes optional `checkoutUrl` and `sessionId` fields

---

### Feature — Airtable Payments Child Table (`4f5165b`, `c115a14`, `7be7eb9`)
**What:** A second Airtable table (`Payments`) is now written alongside the `Jobs` table, creating one child row per Stripe Checkout Session. Written at two points:
1. When a checkout session is created (status: `Pending`)
2. When Stripe webhook confirms payment (status: `Paid` or `Failed`)

**Key implementation detail:** `airtable.payments.adapter.ts` is a separate adapter from `airtable.adapter.ts`. It handles both create (`POST`) and update (`PATCH`) of payment rows, with the Airtable record ID stored on the `payments` table row.

**Also fixed:** Remainder checkout completion now steps through `awaiting_remainder_payment` correctly before transitioning to `closed_paid`. Previously the state machine check was missing for this path.

---

### Feature — Owner Alert on Final Airtable Failure (`ca242b4`, `431cd5f`)
**What:** When BullMQ exhausts all 5 retries on an Airtable sync job, an owner alert fires (currently logs at WARN level; plumbed for email/SMS). Throttled to 1 alert per job per 15 minutes using an in-process Map — prevents alert storms if the service is flapping.

---

### Feature — Test Jobs Seeding Endpoint (`d1b674e`, `2e8fe59`)
**What:** `POST /admin/test-jobs` seeds a test job + payment event directly in the DB for end-to-end lifecycle testing. Guarded by `ENABLE_TEST_ROUTES=true` env var and requires a `sk_test_` Stripe key. Companion shell script `scripts/test-payment-lifecycle.sh` automates a full checkout → webhook → verify sequence.

---

### Other Fixes (since `8b096ef`)
- **`5160bb9`** — Stripe checkout success/cancel redirect URLs now use `FRONTEND_BASE_URL`, not `APP_BASE_URL`
- **`420fabb`** — Stripe webhook router was mounted at `/` inside a router already prefixed at `/webhooks/stripe`, causing double-path (`/webhooks/stripe/webhooks/stripe`). Fixed to `/`
- **`092715b`** — `fitness_equipment` is now a distinct service type (not an alias for `treadmill`); mapped to its own Airtable Single Select label
- **`e423840` / `5832936`** — Airtable `Appointment Window` field values corrected to match exact allowed options (no trailing space, correct parenthesis format)

---

## 3. What Is Working (Confirmed)

| Area | Status |
|---|---|
| Jotform intake webhook — receive, normalize, deduplicate | Confirmed working |
| Job creation in PostgreSQL with full financial split | Confirmed working |
| Airtable `Jobs` table sync — create on intake, update on payment | Confirmed working |
| Airtable `Payments` child table sync — create on checkout, update on webhook | Confirmed working |
| Stripe Checkout Session auto-creation after intake | Confirmed working |
| Stripe Checkout Session manual creation (admin endpoint) | Confirmed working |
| Stripe webhook handler — `checkout.session.completed` | Confirmed working |
| Stripe webhook handler — `payment_intent.succeeded`, `payment_intent.payment_failed` | Confirmed working |
| Deposit flow (`deposit_paid` → `awaiting_remainder_payment` → `closed_paid`) | Confirmed working |
| Full payment flow (`paid_in_full` → `ready_for_dispatch`) | Confirmed working |
| Job state machine with transition guards | Confirmed working |
| `/ready` endpoint — returns 503 until schema verified | Confirmed working |
| Schema circular dependency — resolved | Confirmed fixed |
| Recalculate guard — blocks on paid/deposit_paid/closed_paid | Confirmed fixed |
| Rate limiting, correlation IDs, PII redaction in logs | Confirmed working |
| BullMQ queue with Redis fallback (in-process degraded mode) | Confirmed working |
| Owner alert on final Airtable sync failure (throttled) | Implemented, not live-tested in prod |
| Admin config endpoints (pricing, service areas, contractors) | Implemented, not production-hardened |

---

## 4. What Is Still Open / Known Gaps

### High Priority

| # | Issue | Notes |
|---|---|---|
| H1 | **Admin auth is string comparison, not real JWT** | `requireAdmin` checks `token !== config.ADMIN_JWT_SECRET` — no expiration, no revocation, no roles. Acceptable MVP guard but must be replaced with proper JWT (HS256 + exp claim) before broader access. |
| H2 | **`/jobs/:jobId/recalculate` guard uses status, not a payment check** | Guard blocks on `paid_in_full \| deposit_paid \| closed_paid`. This is correct but relies on status staying in sync with payment reality. If a payment webhook fails to advance status, a paid job could still be recalculated. Monitoring needed. |
| H3 | **No email/SMS delivery implemented** | Owner alert, customer confirmation, dispatch notifications are all plumbed (notification table exists, log calls present) but no actual email/SMS provider is wired up. |
| H4 | **Dispatch flow is a stub** | `POST /webhooks/dispatch-response` is registered but does nothing. Phase 6 (contractor dispatch) has not been started. |

### Medium Priority

| # | Issue | Notes |
|---|---|---|
| M1 | **Intake processing uses `setImmediate()` with no concurrency cap** | High submission volume could queue unbounded in-process callbacks. Fix: move intake processing to BullMQ (Phase 4, already planned). |
| M2 | **Jotform field mapping is hardcoded** | `DEFAULT_JOTFORM_FIELD_MAPPING` in `jotform.normalizer.ts` — any Jotform form redesign requires a backend deploy. Should move to DB-driven config. |
| M3 | **Owner alert throttle is in-process memory** | The `alertSentAt` Map resets on every server restart. Could fire duplicate alerts if service crashes within the 15-minute window. Low impact but worth moving to `config_entries` if reliability is needed. |
| M4 | **`fitness_equipment` service type exists in code but may not be seeded** | `092715b` added the service type code; confirm it has a row in `service_types` and a `pricing_rules` row in production DB. |
| M5 | **No rate limiting per-route on Jotform webhook** | Global rate limiter is 200 req/min across all routes. Jotform retry storms could interfere with admin traffic. Per-path rate limiting recommended. |

### Low Priority / By Design

| # | Issue | Notes |
|---|---|---|
| L1 | **Phone normalization assumes US numbers** | International numbers may fail E.164 conversion. Acceptable if Jotform enforces US-only. |
| L2 | **No timezone captured with appointment dates** | Appointment dates stored without timezone context. Matters if scheduling logic is added later. |
| L3 | **`schemaReady` is a live ES module binding** | The TypeScript/CommonJS interop means `schemaReady` reads live from the module exports object. This is correct behavior but worth noting if the project migrates to ESM. |

---

## 5. Next Priority Items (Recommended Order)

### Priority 1 — Admin Auth Hardening
Replace the current string-comparison admin guard with real JWT validation.
- Issue symmetric HS256 JWTs with `exp` claim (e.g. 8-hour sessions)
- Add a `POST /admin/auth` endpoint that accepts the secret and returns a signed token
- `requireAdmin` validates JWT signature + expiration, not raw string equality
- This unblocks inviting other operators without sharing the master secret

### Priority 2 — Email/SMS Delivery
Wire a real provider (Resend, SendGrid, or Twilio) into the notification path.
- Customer confirmation email on intake (job key, appointment details, payment link)
- Owner alert email on final Airtable sync failure (currently only logs)
- Customer deposit receipt on payment confirmation
- The `notifications` table schema and log call sites already exist — just needs a provider adapter

### Priority 3 — Dispatch Flow (Phase 6)
Implement contractor dispatch from `ready_for_dispatch`.
- `POST /jobs/:jobId/dispatch` — select a contractor, create a `dispatches` row, send dispatch notification (SMS/email)
- `POST /webhooks/dispatch-response` — contractor accept/decline handler (currently stub)
- Transition: `dispatch_in_progress` → `assigned` on accept; back to `ready_for_dispatch` on decline

### Priority 4 — Intake Queue (BullMQ)
Move `processIntake()` out of `setImmediate()` and into BullMQ.
- Eliminates unbounded in-process concurrency on high submission volume
- Enables retries on transient DB failures during intake
- Consistent with how Airtable sync already works
- Low risk: queue infrastructure already present, just needs a new worker

### Priority 5 — Jotform Field Mapping to DB
Move `DEFAULT_JOTFORM_FIELD_MAPPING` from hardcoded constant to a `config_entries` table row.
- Admin can update field keys via `PUT /config/jotform-mapping` without a deploy
- Requires a JSON blob validator to prevent bad mappings from breaking intake

---

## 6. Deployment State

| Property | Value |
|---|---|
| Render service name | `assembly-concierge-api` |
| Render region | `oregon` |
| Health check | `GET /health` |
| Readiness check | `GET /ready` |
| Build command | `npm install && npm run build` |
| Start command | `npm start` |
| Last pushed commit | `893e2d3` |

### Environment Variables

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | Yes | `production` |
| `PORT` | Yes | `10000` |
| `DATABASE_URL` | Yes | Auto-injected from Render DB |
| `STRIPE_SECRET_KEY` | Yes | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Yes | `whsec_...` from Stripe Dashboard |
| `ADMIN_JWT_SECRET` | Yes | Random 64-char hex string |
| `APP_BASE_URL` | Yes | Render service URL |
| `FRONTEND_BASE_URL` | Yes | Used for Stripe checkout redirect URLs |
| `AIRTABLE_API_KEY` | Yes | `pat...` personal access token |
| `AIRTABLE_BASE_ID` | Yes | `app...` base ID |
| `AIRTABLE_TABLE_JOBS` | No | Defaults to `Jobs` |
| `AIRTABLE_TABLE_PAYMENTS` | No | Defaults to `Payments` |
| `REDIS_URL` | No | BullMQ degrades to in-process if absent |
| `ENABLE_TEST_ROUTES` | No | Set `true` only in staging; enables `/admin/test-jobs` |
| `EMAIL_PROVIDER_API_KEY` | No | Not yet wired |
| `SMS_PROVIDER_API_KEY` | No | Not yet wired |

---

## 7. Database State

### Migrations (5 applied, run automatically on startup)

| # | File | Summary |
|---|---|---|
| 001 | `001_initial_schema.sql` | All core tables, enums, indexes |
| 002 | `002_seed_data.sql` | Service types (Hampton/Stockbridge/McDonough GA), pricing rules, config entries |
| 003 | `003_fix_pricing.sql` | Corrects small payout ($55), treadmill base ($189), all deposits to fixed $25 |
| 004 | `004_rush_tier.sql` | Adds `rush_type` to `jobs`; adds `next_day_rush_price_cents` and `contractor_rush_bonus_cents` to `pricing_rules` |
| 005 | `005_job_financial_split.sql` | Adds 7 financial split columns to `jobs` |

### Confirmed Pricing Rules

| Service Type | Base | Deposit | Contractor Payout | Same-Day Rush | Next-Day Rush |
|---|---|---|---|---|---|
| small | $109.00 | $25.00 | $55.00 | +$30 | +$20 |
| medium | $149.00 | $25.00 | $80.00 | +$30 | +$20 |
| large | $199.00 | $25.00 | $110.00 | +$30 | +$20 |
| treadmill | $189.00 | $25.00 | $130.00 | +$30 | +$20 |
| custom | $0 | $0 | $0 | — | — |

### Service Areas

| City | State | Status |
|---|---|---|
| Hampton | GA | `in_area` |
| Stockbridge | GA | `in_area` |
| McDonough | GA | `in_area` |
| All others | — | `quote_only` (default) |

---

## 8. Architecture Invariants (Do Not Break)

- **PostgreSQL is the source of truth** — Airtable is a mirror only; sync failures never rollback DB transactions
- **Stripe webhooks govern payment state** — never infer payment completion from frontend redirects
- **All job state transitions go through `assertTransition()`** — no direct status writes that bypass the state machine
- **Airtable sync is always fire-and-forget** — enqueued after the DB transaction commits, never inside it
- **`schemaReady` must be false until migrations AND `verifySchema()` both pass** — `setSchemaReady(true)` is called only in the success branch of `start()` in `server.ts`
- **All financial amounts are integer cents** — no floating-point math in pricing or payment logic
- **Correlation IDs thread through all logs, audit events, and queue jobs** — always pass `correlationId` from request context

---

## 9. Key File Locations

| Concern | File |
|---|---|
| Schema readiness flag | `src/common/schemaState.ts` |
| App factory | `src/app.ts` |
| Server entry + migrations | `src/server.ts` |
| Job state machine | `src/modules/jobs/job.stateMachine.ts` |
| Job routes (recalculate guard here) | `src/modules/jobs/jobs.routes.ts` |
| Intake normalization | `src/modules/intake/jotform.normalizer.ts` |
| Intake service (auto-checkout here) | `src/modules/intake/intake.service.ts` |
| Stripe webhook handler | `src/modules/payments/stripe.webhook.ts` |
| Payment service (Airtable retry loop here) | `src/modules/payments/payment.service.ts` |
| Airtable Jobs adapter | `src/modules/airtable-sync/airtable.adapter.ts` |
| Airtable Payments adapter | `src/modules/airtable-sync/airtable.payments.adapter.ts` |
| Airtable sync queue | `src/modules/airtable-sync/airtableSync.queue.ts` |
| Pricing rules engine | `src/modules/pricing/pricing.service.ts` |
| Admin auth middleware | `src/common/middleware/auth.ts` |
| Embedded migrations | `src/db/embeddedMigrations.ts` |

---

*End of snapshot. To resume work in a new session, share this document and the repository URL.*
