# Assembly Concierge Session Snapshot - April 13 2026
**Generated:** 2026-05-18
**Purpose:** Safe session handoff / context restore document
**Previous snapshot:** `SESSION_SNAPSHOT_2026-04-04.md` (HEAD at `893e2d3`)

---

## 1. Repository State

| Property | Value |
|---|---|
| Repository | `https://github.com/assemblyconcierge-ai/assembly-concierge-backend` |
| Branch | `main` |
| HEAD commit | `d4b116e` |
| Local uncommitted changes | None (working tree clean) |

### Commits Since Last Snapshot (`893e2d3` → `d4b116e`)

| Hash | Commit Message |
|---|---|
| `95929ef` | docs(api): add admin endpoint reference |
| `1a8276b` | docs(portfolio): note deferred airtable reconciliation design |
| `2d96ffb` | test(dispatch): cover contractor schedule conflicts |
| `f08d8a7` | fix(tests): resolve TS2345/TS2339 errors in dispatchConflict test |
| `d4b116e` | feat(public-booking): add public booking adapter |

---

## 2. Backend Hardening: Contractor Schedule Conflict Tests (`2d96ffb` + `f08d8a7`)

### What was verified (read-only audit)

The conflict logic in `src/modules/dispatch/dispatchConflict.ts` was correct and production-safe but had zero unit test coverage. The core function `checkScheduleConflict()` uses two modes:

- **Mode A** — timestamp overlap: uses parsed `scheduledStart`/`scheduledEnd` UTC timestamps from the job's schedule fields
- **Mode B** — exact date+window string match fallback: used when timestamps are absent; matches on raw `appointment_date` and `appointment_window` strings

Blocking assignment statuses: `pending`, `accepted`
Blocking job statuses: `ready_for_dispatch`, `dispatch_in_progress`, `assigned`, `scheduled`, `dispatch_ready`, `completion_reported`

### What was added

`tests/unit/dispatchConflict.test.ts` — 27 tests covering 15 required cases:

- Mode A conflict (overlapping timestamps)
- Mode A no-conflict (adjacent, non-overlapping)
- Mode B conflict (same date + same window)
- Mode B no-conflict (same date + different window)
- Missing schedule fields (short-circuit, no query)
- Params correctness: `$3`/`$4` are parsed UTC timestamps; `$5`/`$6` are raw appointment fields passed through for Mode B

### Mock isolation fix

`vi.clearAllMocks()` in `beforeEach` clears call history but does **not** drain the `mockResolvedValueOnce` queue. Tests that exit early (e.g. Missing Schedule path) leave unconsumed mocks which bleed into subsequent tests. Fix: call `mockQuery.mockReset()` as the first line of the `setup()` helper to drain the queue before each test arranges its own responses. `vi.resetAllMocks()` was rejected because it wipes `vi.fn()` implementations, breaking the logger `child()` factory.

### TypeScript fix (`f08d8a7`)

`tsconfig.json` includes `tests/**/*`, so Render's `npm run build` runs `tsc` across test files. The `makeClient()` helper returned `{ query: vi.fn() }`, which is not assignable to `PoolClient` (missing ~25 required properties). Fix:

- Added `import type { PoolClient } from 'pg'`
- Cast return: `return { query: vi.fn()... } as unknown as PoolClient`
- Cast assertion site: `(client.query as any).mock.calls[0][1]` — needed because after the `PoolClient` cast, `client.query` is typed as pg's query method, not `Mock`

Outcome: 27/27 tests passing locally; `f08d8a7` unblocked Render deploy.

---

## 3. Public Booking Adapter: Custom Website Intake Path (`d4b116e`)

### Overview

Added `POST /public/bookings` as the intake path for the planned custom Next.js/Vercel frontend booking form. The existing Jotform webhook route is preserved as a parallel fallback intake path — no changes were made to that flow.

### Route behavior

- Strict Zod validation maps the public booking JSON body to `CanonicalIntake`; unknown fields are rejected
- `sourceChannel` is now a parameter to `processIntake`: web bookings set `sourceChannel = 'web'`; the Jotform path continues to set `sourceChannel = 'jotform'`
- `processIntake` now returns `publicPayToken` so the adapter can hand it back to the frontend
- The adapter does **not** call `createJobCheckoutSession` directly; checkout creation fires via `setImmediate` inside `processIntake` (fire-and-forget, unchanged)
- Route-level rate limiting added
- CORS updated: accepts configured frontend origins and non-production Vercel preview origins; no longer a single-origin blanket

### Route safety count (verified in `d4b116e`)

| Call | Count |
|---|---|
| `markProcessing(` | 1 |
| `processIntake(` | 1 |
| `markProcessed(` | 1 |
| `createJobCheckoutSession` | 0 |

### Payment handoff

`GET /jobs/pay/:token` now returns `checkoutUrl` (or `null` while checkout creation is still pending). Previously this field was absent from the response — the frontend had no way to redirect to Stripe after booking.

### Fixed-price v1 service types

Only the following types are accepted by the public booking route:

| Type | Price | Deposit | Contractor Payout |
|---|---|---|---|
| `small` | $109 | $25 | $55 |
| `medium` | $149 | $25 | $80 |
| `large` | $199 | $25 | $110 |
| `treadmill` | $189 | $25 | $130 |

`custom` and `fitness_equipment` are excluded — they require custom quoting and are not supported by fixed-price v1.

### Validation results

| Check | Result |
|---|---|
| `npm run build` | Passed |
| `npm test` (full suite) | 155/155 passing |
| Public booking route tests | 5/5 passing |

---

## 4. Architecture Decision: Frontend Platform

**Selected:** Next.js + Vercel

**Rationale:** City landing pages (Hampton GA, McDonough GA, Stockbridge GA, etc.) require server-side static generation (SSG) for local SEO. A Vite SPA cannot generate pre-rendered HTML per city — search crawlers would see a blank shell. Next.js SSG produces fully-rendered HTML per route at build time. Vercel preview URLs enable branch-based QA without a separate staging environment.

**Multi-step booking form:** Hosted in the same Next.js app. Submits to `POST /public/bookings`. On success, frontend receives `publicPayToken` and redirects to the Stripe checkout URL returned by `GET /jobs/pay/:token`.

**Jotform:** Retained as a parallel fallback intake path. No changes to the Jotform webhook or its processing flow. If the custom frontend is delayed or fails, Jotform handles intake without degradation.

---

## 5. Phase 1 Backend Verification: Findings and Resolution

A 10-area read-only audit was completed before implementation. All blocking gaps were addressed by `d4b116e`.

### A. Findings resolved by `d4b116e`

| Finding | Resolution |
|---|---|
| `sourceChannel` hardcoded as `'jotform'` in `processIntake` | Parameterized; web route passes `'web'`, Jotform route passes `'jotform'` |
| `publicPayToken` not returned by `processIntake` | Added to `IntakeProcessResult`; returned to adapter and forwarded to frontend |
| `checkoutUrl` absent from `GET /jobs/pay/:token` response | Route now returns `checkoutUrl` or `null` while pending |
| CORS configured for single origin only | Updated to accept multiple configured origins and Vercel preview pattern |
| Service areas (live DB verified) | Hampton GA = `in_area`, McDonough GA = `in_area`, Stockbridge GA = `in_area` |
| Pricing rules (live DB verified) | small $109, medium $149, large $199, treadmill $189 — all with $25 deposit |

### B. Known deferred follow-up items

| Item | Status |
|---|---|
| `createJobCheckoutSession` is not idempotent — multiple calls create multiple payment rows | Deferred. The public adapter does not call it directly, so duplicate-session risk is avoided for this route. Risk remains if the function is called elsewhere. |
| `intake_submission_id` is nullable by schema | Deferred by design. The public adapter creates a real `intake_submissions` row for auditability, so the FK is populated — but the nullable column is not being tightened at the DB level. |
| Photo/media upload support | Deferred. Current route sets `media = []`. A future iteration will add pre-signed S3 upload support before or after booking submission. |
| `custom` and `fitness_equipment` quote-only flow | Deferred. These types are excluded from fixed-price v1. A quote request path (separate route or Jotform) is the intended fallback. |

---

## 6. Deployment State

| Property | Value |
|---|---|
| Render service name | `assembly-concierge-api` |
| Render region | `oregon` |
| Render plan | `starter` |
| Health check path | `GET /health` |
| Readiness check path | `GET /ready` |
| Build command | `npm install && npm run build` |
| Start command | `npm start` |
| Current deployed commit | `d4b116e` |
