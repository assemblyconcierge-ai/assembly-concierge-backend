# Assembly Concierge — Full System Build Journal

> A real furniture assembly service business built into a fully automated operations platform — from manual Jotform + Make.com + Airtable workflows to a production-grade Node.js/TypeScript backend with Stripe payments, SMS dispatch, and end-to-end job lifecycle management.
>
> This document tells the complete story: where the system started, every problem encountered, every decision made, and how it evolved into what it is today.

---

## Table of Contents

1. [What This Is](#what-this-is)
2. [The Business](#the-business)
3. [Phase 0 — Before the Backend: Jotform + Make + Airtable](#phase-0)
4. [Phase 1 — The Backend is Born (February 2026)](#phase-1)
5. [Phase 2 — Airtable Sync and Payment Fixes (March 2026)](#phase-2)
6. [Phase 3 — Stability, Auto-Checkout, and Payments Table (April 2026)](#phase-3)
7. [Phase 4 — Dispatch Pipeline (April 2026)](#phase-4)
8. [Phase 5 — Completion and Remainder Billing (April 2026)](#phase-5)
9. [Current Architecture](#current-architecture)
10. [Job State Machine](#job-state-machine)
11. [SMS Command Protocol](#sms-command-protocol)
12. [API Reference](#api-reference)
13. [Airtable Operator Interface](#airtable-operator-interface)
14. [Key Engineering Decisions](#key-engineering-decisions)
15. [Deployment](#deployment)
16. [Environment Variables](#environment-variables)

---

## What This Is

Assembly Concierge is a real, operating furniture assembly service business in the Atlanta metro area. This repository is the backend that powers its entire operational stack — from the moment a customer submits a Jotform to the moment a contractor marks a job complete and a remainder invoice is sent.

**Tech Stack:** Node.js · TypeScript · PostgreSQL · Stripe · BullMQ · Airtable API · Quo SMS · Make.com · Render

**Built by:** Kenneth Thomas-Utsey with Claude (Anthropic) and Manus AI — 2026

---

## The Business

Assembly Concierge provides on-demand furniture assembly services in:

| City | State | Status |
|------|-------|--------|
| Hampton | GA | In-area (full service) |
| Stockbridge | GA | In-area (full service) |
| McDonough | GA | In-area (full service) |
| All others | — | Quote only |

**Service types:** Small Assembly · Medium Assembly · Large Assembly · Treadmill Assembly · Custom Job

**Payment model:** Customers choose deposit ($25 fixed) or pay in full at booking.

---

<a name="phase-0"></a>
## Phase 0 — Before the Backend: Jotform + Make + Airtable

### Where it started

Before any backend existed, Assembly Concierge ran entirely on no-code tools:

- **Jotform** — customer intake form. Customers filled out service details, appointment preferences, and payment info. Jotform processed the Stripe payment directly.
- **Make.com** — automation hub. Jotform submissions were sent to Make via webhook, which parsed the data and pushed records into Airtable.
- **Airtable** — operator dashboard and source of truth. Every job lived here. The operator (Kenneth) reviewed jobs, updated statuses, and managed contractors all manually within Airtable.

### The workflow

```
Customer fills Jotform
        ↓
Jotform processes Stripe payment directly
        ↓
Make.com webhook receives submission
        ↓
Make parses fields and creates Airtable record
        ↓
Operator reviews in Airtable
        ↓
Operator manually contacts contractor
        ↓
Operator manually updates Airtable status
```

### What worked

- Extremely fast to set up — no code required
- Airtable gave a clean visual dashboard for job management
- Make handled the Jotform → Airtable data pipeline reliably

### What broke down

As volume grew and requirements became more complex, the no-code stack hit its limits:

- **No real state machine** — job status was a free-text field that anyone could set to anything. There was no enforcement of valid transitions.
- **Payment state fragility** — Jotform processed Stripe payments, but there was no webhook to confirm actual payment. If Stripe failed after Jotform submitted, the job appeared as paid when it wasn't.
- **No audit trail** — who changed what and when was not tracked.
- **Dispatch was manual** — Kenneth had to personally text every contractor, wait for a response, then manually update Airtable.
- **No remainder billing automation** — for deposit jobs, sending the remainder invoice was a completely manual process.
- **Make scenarios were brittle** — any field name change in Jotform broke the entire pipeline. Debugging Make scenario failures was slow.
- **Airtable as source of truth was dangerous** — automations could write conflicting values. There was no single authority on job state.

### The decision to build a backend

The decision was made to build a proper backend to:
1. Own all business logic (state machine, pricing, payment flow)
2. Make Airtable a **mirror only**, not the source of truth
3. Automate contractor dispatch end-to-end via SMS
4. Create a complete audit trail of every action
5. Handle Stripe webhooks directly (not through Jotform)

---

<a name="phase-1"></a>
## Phase 1 — The Backend is Born (February–March 2026)

### Starting commit: MVP scaffold

Built from scratch — a full production-grade Node.js/TypeScript backend:

**Core infrastructure:**
- PostgreSQL schema: `jobs`, `payments`, `customers`, `addresses`, `contractors`, `dispatches`, `contractor_assignments`, `intake_submissions`, `audit_events`, `integration_failures`, `config_entries`
- BullMQ queue for Airtable sync (degrades gracefully to in-process if Redis is unavailable)
- Correlation IDs on every request, log entry, and audit event
- PII redaction in structured Pino logs
- Zod-validated environment config
- Graceful shutdown handling

**Job state machine:**
Every status change goes through `assertTransition()` — no direct DB writes bypass it. The machine defines every valid transition explicitly.

**Intake pipeline:**
- `POST /webhooks/jotform` receives Jotform submissions
- `jotformBodyParser` handles all Jotform content types (multipart, urlencoded, JSON, text/plain)
- Normalizer extracts `CanonicalIntake` from raw Jotform payload using `DEFAULT_JOTFORM_FIELD_MAPPING`
- `processIntake()` classifies service area, looks up pricing, creates job in PostgreSQL

**Payment pipeline:**
- `POST /webhooks/stripe` handles `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`
- Stripe webhooks are the only payment truth — never infer from frontend redirects
- Idempotency keys prevent double-processing

**Airtable sync:**
- Fully async — enqueued after DB transaction commits, never inside it
- Failures never roll back core transactions
- Retry queue in `integration_failures` table

**56 unit/integration tests written.**

---

<a name="phase-2"></a>
## Phase 2 — Airtable Sync and Payment Fixes (March 2026)

With the scaffold deployed, real Jotform submissions exposed several bugs:

### Bug: Airtable 422 INVALID_MULTIPLE_CHOICE_OPTIONS
**Root cause:** `JOB_STATUS_MAP` contained labels like `'Quoted — Outside Area'` and `'Closed — Paid'` that don't exist as options in Airtable's Status single-select field.

**Fix:** Replaced the entire map with confirmed allowed values: `pending_payment | paid | dispatch_ready | assigned | completed | cancelled`.

**Lesson:** Airtable's single-select fields are strict — values must match exactly, including case and spacing.

### Bug: `updateAirtableStatus` signature mismatch (Render build failure)
**Root cause:** `airtableSync.queue.ts` called `updateAirtableStatus()` with 4 arguments but the deployed version only declared 3 parameters. The local fix was never committed.

**Fix:** Committed the 4-parameter version of `airtable.adapter.ts`.

**Lesson:** Always commit and push before ending a session — local fixes don't deploy.

### Bug: Stripe Checkout Session ID not written to Airtable
**Root cause:** No Airtable sync was enqueued after checkout session creation. The session ID existed in PostgreSQL but never reached Airtable.

**Fix:** Added `setImmediate(() => enqueueAirtableSync(...))` after both `create-checkout-session` and `create-remainder-payment`.

### Bug: Stripe Payment Intent ID dropped silently
**Root cause:** `airtableSync.queue.ts` fetched `stripe_intent_id` from DB but only passed 3 args to `updateAirtableStatus()`, silently dropping the 4th.

**Fix:** Added `record.stripePaymentIntentId` as the explicit 4th argument.

### Features added this phase:
- Full financial split written to Airtable (base price, deposit, remainder, contractor payout, rush bonus, Stripe fee, job margin)
- Rush tier support (same-day vs. next-day) across entire pipeline
- 11 new Airtable fields synced

---

<a name="phase-3"></a>
## Phase 3 — Stability, Auto-Checkout, and Payments Table (April 2026)

### Bug: Circular dependency in `app.ts`
**Root cause:** `server.ts` imported `createApp` from `app.ts`. `app.ts` used a runtime `require('./server')` to read the `schemaReady` flag. Classic circular dependency.

**Fix:** Extracted schema readiness into `src/common/schemaState.ts` — a dependency-free shared module. `server.ts` calls `setSchemaReady(true)` after migrations complete. `app.ts` imports `{ schemaReady }` directly with no circular path.

### Feature: Auto-checkout after intake
**Problem:** Customers couldn't pay until an admin manually called `POST /jobs/:jobId/create-checkout-session`. This was a manual bottleneck on every single job.

**Fix:** `processIntake()` now fire-and-forget creates the Stripe Checkout Session immediately after a job reaches `awaiting_payment`. Customers receive a payment link automatically — no admin action required.

**Behavior:**
- `checkoutRequired === true` → auto-checkout triggered
- Admin `POST /jobs/:jobId/create-checkout-session` still works for manual retry/override
- `IntakeProcessResult` now returns `checkoutUrl` and `sessionId`

### Bug: Retry loop for Airtable payment linking
**Root cause:** Auto-checkout fires immediately after `processIntake()` returns. But the Airtable sync (which sets `jobs.airtable_record_id`) is async and may still be in flight. `createAirtablePaymentRow()` requires a non-null `airtable_record_id` to link the Payments child row to its parent Jobs record.

**Fix:** Added a 10-attempt polling retry loop with 3-second delays (30-second window) in `payment.service.ts`.

### Feature: Airtable Payments child table
A second Airtable table (`Payments`) now tracks every Stripe checkout session:
- Written at checkout creation (status: Pending)
- Updated when Stripe webhook confirms payment (status: Paid or Failed)
- `airtable.payments.adapter.ts` is a separate adapter — isolated from jobs sync

### Bug: Remainder payment state machine gap
**Root cause:** The `awaiting_remainder_payment → closed_paid` transition was missing a proper state machine guard. Remainder payments could skip states.

**Fix:** Added explicit transition guard for the remainder path.

### Feature: Owner alert on Airtable sync failure
When BullMQ exhausts all 5 retries on an Airtable sync job, the operator is alerted. Throttled to 1 alert per job per 15 minutes using an in-process Map — prevents alert storms during flapping.

### Feature: Recalculate guard
`POST /jobs/:jobId/recalculate` was unguarded — it would overwrite pricing on already-paid jobs. Added a check that blocks recalculation when `job.status` is in `{paid_in_full, deposit_paid, closed_paid}`.

### Feature: Test seeding endpoint
`POST /admin/test-jobs` seeds a test job + payment event for end-to-end lifecycle testing. Guarded by `ENABLE_TEST_ROUTES=true` env var and requires `sk_test_` Stripe key. Companion shell script `scripts/test-payment-lifecycle.sh` automates a full checkout → webhook → verify sequence.

---

<a name="phase-4"></a>
## Phase 4 — Dispatch Pipeline (April 2026)

This was the largest build phase — taking the system from "jobs get created and paid" to "contractors get dispatched and confirmed via SMS."

### The dispatch problem

Jobs were accumulating in `deposit_paid` / `paid_in_full` status with no automated path to send them to contractors. The operator had to manually:
1. Review the job in Airtable
2. Look up an available contractor
3. Text them manually
4. Wait for a response
5. Update Airtable manually

**Goal:** Operator checks one checkbox → contractor receives SMS → contractor replies → job advances automatically.

### Built: `POST /jobs/:jobId/approve-dispatch`

The state machine had `deposit_paid → ready_for_dispatch` as a valid transition but no endpoint to trigger it. Make.com was calling `POST /jobs/:jobId/dispatch` directly and getting `409 CONFLICT: "Job must be at ready_for_dispatch to dispatch (current: deposit_paid)"`.

**Fix:** Added an operator-controlled gate endpoint that advances the job to `ready_for_dispatch`. Uses `assertTransition()` as the sole guard — no manual status allowlist. Fires audit event + Airtable sync.

**Make.com scenario updated:** Approve dispatch → then dispatch (two sequential HTTP calls).

### Built: Full SMS webhook handler (`POST /webhooks/sms`)

Contractors interact entirely via SMS using Quo:

| Command | Keywords | Target Status |
|---------|----------|---------------|
| `CONFIRM` | confirm, confirmed, yes | `assigned` |
| `DECLINE` | decline, no, pass | `ready_for_dispatch` |
| `FINISH` | finish, job finished, work complete | `completion_reported` |
| `DONE` | done, all done, job done | `completion_reported` |

On `CONFIRM`:
1. Backend finds contractor by `phone_e164`
2. Finds active dispatch for that contractor
3. Updates `contractor_assignments` → `accepted`
4. Updates `dispatches` → `accepted`
5. Updates `jobs` → `assigned`
6. Fires Airtable sync

### Built: Airtable dispatch automation

Airtable's native action set can't send HTTP requests to dynamic URLs (it lacks OR logic in trigger conditions and no built-in webhook action). Built the solution using:
- **Trigger:** When `Dispatch Approved` checkbox is updated
- **Conditional guard:** Dispatch Sent ≠ checked, Assigned Contractor ID not empty, Backend Job ID not empty, `Dispatch Payment Eligible = 1`
- **Action 1:** Update record → `Status = ready for dispatch`
- **Action 2:** Run a script → `fetch(dispatchUrl, { method: "GET" })` using the Make webhook URL stored in the `Dispatch` field

Added `Dispatch Payment Eligible` as a formula field: `OR({Overall Payment Status} = "deposit_paid", {Overall Payment Status} = "paid_in_full")` to work around Airtable's automation OR limitation.

### Bugs found and fixed during dispatch build:

**Bug: Area classification — McDonough misclassified as `quote_only`**

Jobs from McDonough, GA were being incorrectly rejected as outside the service area even though McDonough is in-area.

**Root cause:** `intake.service.ts` was checking `areaTag` from the Jotform field but not applying the correct override logic for McDonough. The `effectiveAreaStatus` was defaulting to `quote_only` for certain tag combinations.

**Fix:** Added `effectiveAreaStatus` override: if `areaTag` starts with "inside" AND `typeCode` is standard (`small/medium/large/treadmill/fitness_equipment`) → treat as `in_area`.

---

**Bug: Full payment checkout hardcoded as deposit**

A customer selecting "Pay in Full" was being charged $25 (the deposit amount) instead of the full price.

**Evidence from Render logs (job AC-2026-KXGK):**
```
Normalized intake: paymentType = "full", totalAmount = "229"
Checkout session created: paymentType = "deposit", amountCents = 5500
```

**Root cause:** `intake.service.ts` line 209 hardcoded `'deposit'` in the auto-checkout call. `intake.financials.paymentType` was correctly normalized but never read when triggering checkout.

**Fix:**
```typescript
const rawPaymentType = (intake.financials?.paymentType ?? '').toLowerCase();
const checkoutType: 'full' | 'deposit' = rawPaymentType.includes('full') ? 'full' : 'deposit';
```

---

**Bug: Airtable deposit-style financial breakdown for full-payment jobs**

After fixing checkout, Stripe charged the correct amount — but Airtable still showed a deposit/remainder split for full-payment jobs.

**Root cause:** `airtableSync.queue.ts` always passed `row.deposit_amount_cents` and `row.remainder_amount_cents` directly — never checking whether the job was pay-in-full.

**Fix:**
```typescript
const isPayInFull = (rawPaymentType ?? '').toLowerCase().includes('full');
const effectiveDepositCents = isPayInFull ? row.total_amount_cents : row.deposit_amount_cents;
const effectiveRemainderCents = isPayInFull ? 0 : row.remainder_amount_cents;
```

---

**Bug: Rush fee missing from deposit amount**

Rush fee was calculated correctly in `total_amount_cents` but not included in `deposit_amount_cents`. Customers on deposit path were underpaying.

**Fix:** `depositCents = baseDepositCents + rushAmountCents` in `pricing.service.ts`.

---

**Bug: Backend Job ID not syncing to Airtable**

The `Backend Job ID` field in Airtable (used by Make to reference the correct backend record) was always empty for new jobs.

**Root cause:** `jobId` was not included in the `AirtableJobRecord` interface or the sync record builder.

**Fix:** Added `jobId: string` to interface and `'Backend Job ID': record.jobId` to field writes in `airtableSync.queue.ts`.

---

**Bug: Dispatch Status not written after contractor CONFIRM**

After a contractor texted CONFIRM, the backend correctly advanced the job to `assigned`. But the Airtable `Backend Status Match` formula kept showing "Mismatch."

**Root cause:** The formula `IF({Dispatch Status} = "Accepted", "assigned", ...)` never resolved because `updateAirtableStatus()` never wrote `Dispatch Status` to Airtable after confirmation. The field stayed as `Pending Dispatch` forever.

**Fix (`airtable.adapter.ts` commit `ac0c2d2`):**
```typescript
if (internalStatus === 'assigned') {
  fields['Dispatch Status'] = 'Accepted';
}
```

---

**Bug: Duplicate contractor record causing CONFIRM to be silently ignored**

Contractor texted CONFIRM. Render logs showed:
```json
{"contractorId":"4dc61fcb...","command":"CONFIRM","msg":"[SMS] No active job found for contractor — ignoring"}
```

**Root cause:** Two contractor records existed with the same phone number `+14044256394`, both `is_active = true`. The SMS webhook matched the wrong one first (by `assigned_at DESC`). The correct contractor had the active job; the stale duplicate did not.

**Fix:**
```sql
UPDATE contractors SET is_active = false WHERE id = '4dc61fcb-fe79-4080-8f90-6651f246e18d';
```

**Lesson:** Phone number uniqueness must be enforced at the contractor level. The SMS webhook lookup assumes one active contractor per phone.

---

**Bug: One-active-dispatch invariant not enforced**

If a contractor had multiple active jobs, the SMS webhook would match whichever job was most recently assigned — not necessarily the one the contractor was responding about. This creates an ambiguity that could confirm the wrong job.

**Fix (`dispatch.service.ts` commit `bda3573`):** Added a guard at dispatch time that rejects any dispatch if the target contractor already has a job in `dispatch_in_progress`, `assigned`, `scheduled`, or `completion_reported`. Returns `409 CONTRACTOR_ALREADY_ACTIVE` with the conflicting job key.

**Design decision:** Rather than add complexity to the SMS protocol (job tokens in replies), enforcing one-active-dispatch-per-contractor eliminates the ambiguity entirely.

---

<a name="phase-5"></a>
## Phase 5 — Completion and Remainder Billing (April 2026)

With dispatch working, the next gap was job completion and remainder invoicing.

### The problem

After a contractor completed a job:
- There was no SMS command to signal completion
- There was no operator review gate before billing
- There was no automated path from "job done" to "remainder invoice sent"
- `work_completed` existed as a state but had no clean path to remainder billing

### Design decisions made

**Should contractor `FINISH` immediately trigger billing?**
No. A contractor SMS is not strong enough authorization to charge a customer. `FINISH` moves the job to `completion_reported` — a human-reviewable state — before any billing action. This separates:
- Contractor says it's done
- Operator verifies the claim
- Customer is billed

**What about the existing `DONE` command?**
`DONE` was mapping to `work_completed` — a different pre-billing state. Rather than maintain two parallel completion commands with different semantics, both `DONE` and `FINISH` now map to `completion_reported`. `work_completed` is preserved internally but no longer reached via contractor SMS.

**Should `scheduled → completion_reported` be a valid transition?**
No. A contractor should only be able to report completion from `assigned` — not from any earlier state. `scheduled → completion_reported` was rejected from the initial Manus proposal.

### Built: `FINISH` SMS command

```typescript
const FINISH_KEYWORDS = [
  'finish', 'job finished', 'work finished', 'job complete', 'work complete',
  'job completed', 'work completed', 'all finished',
];
// FINISH is checked before DONE so 'finished' maps to FINISH, not DONE
```

### Built: `completion_reported` state

New state added to the job state machine:

| From | To |
|------|----|
| `assigned` | `completion_reported` |
| `work_completed` | `completion_reported` |
| `completion_reported` | `awaiting_remainder_payment` |
| `completion_reported` | `closed_paid` |

### Built: `POST /jobs/:jobId/approve-completion`

Operator-controlled gate that branches based on remaining balance:

```
if remaining_balance_cents > 0:
    → awaiting_remainder_payment
    → auto-creates remainder Stripe checkout session (fire-and-forget)
    → logs payment.checkout_failed audit event if checkout creation fails

if remaining_balance_cents = 0:
    → closed_paid
```

Rejects any source state other than `completion_reported`. Returns `409 CONFLICT` for invalid transitions.

### Existing Stripe webhook already handles the rest

`checkout.session.completed` on a remainder payment already handled `awaiting_remainder_payment → closed_paid` correctly. No changes needed.

---

## Current Architecture

```
Customer fills Jotform
        ↓
POST /webhooks/jotform
        ↓
Intake normalization → Job creation (PostgreSQL) → Airtable sync (async)
        ↓
Auto-checkout session created (Stripe)
        ↓
Customer pays → POST /webhooks/stripe
        ↓
Job advances → deposit_paid / paid_in_full → Airtable sync (async)
        ↓
Operator reviews job in Airtable
        ↓
Operator checks "Dispatch Approved"
        ↓
Airtable automation validates guards → sets Status = ready for dispatch
        ↓
Airtable script calls Make webhook (URL stored in Dispatch field)
        ↓
Make calls POST /jobs/:id/approve-dispatch → ready_for_dispatch
        ↓
Make calls POST /jobs/:id/dispatch → dispatch_in_progress + SMS sent (Quo)
        ↓
Contractor replies CONFIRM via SMS
        ↓
POST /webhooks/sms → assigned → Airtable sync (async)
        ↓
Contractor replies FINISH when job complete
        ↓
POST /webhooks/sms → completion_reported → Airtable sync (async)
        ↓
Operator approves completion in Airtable
        ↓
POST /jobs/:id/approve-completion
        ↓
If balance > 0 → awaiting_remainder_payment + remainder checkout created
If balance = 0 → closed_paid
        ↓
Stripe webhook → closed_paid
```

---

## Job State Machine

```
awaiting_payment
    ↓ (payment received)
deposit_paid / paid_in_full
    ↓ (operator approves dispatch)
ready_for_dispatch
    ↓ (dispatch SMS sent)
dispatch_in_progress
    ↓ (contractor texts CONFIRM)
assigned
    ↓ (contractor texts FINISH or DONE)
completion_reported
    ↓ (operator approves completion)
awaiting_remainder_payment  →  (Stripe webhook)  →  closed_paid
        ↓ (no remainder balance)
     closed_paid
```

**Side exits from any state:** `error_review`, `cancelled`

**Other states:** `intake_received`, `intake_validated`, `quoted_outside_area`, `scheduled`, `work_completed` (legacy)

---

## SMS Command Protocol

| Command | Keywords | New Status | Notes |
|---------|----------|-----------|-------|
| `CONFIRM` | confirm, confirmed, yes | `assigned` | Must have active `dispatch_in_progress` job |
| `DECLINE` | decline, no, pass | `ready_for_dispatch` | Returns job to dispatch queue |
| `FINISH` | finish, job finished, work finished, etc. | `completion_reported` | Requires `assigned` source state |
| `DONE` | done, all done, job done | `completion_reported` | Legacy alias for FINISH |

---

## API Reference

### Webhooks
| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/jotform` | Customer intake |
| POST | `/webhooks/stripe` | Payment events |
| POST | `/webhooks/sms` | Contractor SMS replies |

### Jobs (Admin)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/jobs` | List/search jobs |
| GET | `/jobs/:jobId` | Get job + payments + audit |
| POST | `/jobs/:jobId/approve-dispatch` | Gate: advance to ready_for_dispatch |
| POST | `/jobs/:jobId/dispatch` | Send dispatch SMS to contractor |
| POST | `/jobs/:jobId/approve-completion` | Gate: branch to remainder or closed_paid |
| POST | `/jobs/:jobId/create-checkout-session` | Manual checkout creation |
| POST | `/jobs/:jobId/create-remainder-payment` | Generate remainder checkout |
| POST | `/jobs/:jobId/recalculate` | Recalculate pricing (blocked on paid jobs) |
| POST | `/jobs/:jobId/mark-complete` | Internal admin completion |
| POST | `/jobs/:jobId/retry-failed-actions` | Retry Airtable sync |

### Config (Admin)
| Method | Path | Description |
|--------|------|-------------|
| GET/PUT | `/config/pricing` | Pricing rules |
| GET/PUT | `/config/service-areas` | Service area classification |
| GET/POST | `/contractors` | Contractor management |
| GET | `/payments/:paymentId` | Get payment |
| POST | `/payments/:paymentId/refund` | Issue refund |
| GET | `/integration-failures` | View failed Airtable syncs |

---

## Airtable Operator Interface

Airtable is the operator's UI — not the source of truth. Every field is either input-only or a mirror of backend state.

| Field | Owned By | Purpose |
|-------|----------|---------|
| `Dispatch Approved` | Operator input | Human approval to initiate dispatch |
| `Completion Approved` | Operator input | Human approval to close job |
| `Backend Job ID` | Backend mirror | UUID for Make.com to reference |
| `Backend Job Status` | Backend mirror | Actual DB status value |
| `Dispatch Status` | Backend mirror | Dispatch outcome (Accepted, etc.) |
| `Dispatch Sent` | Backend mirror | Whether SMS was sent |
| `Status` | Airtable/mirror | Operational field used in Make filters |
| `Dispatch Payment Eligible` | Formula | `OR(deposit_paid, paid_in_full)` helper for automation trigger |
| `Expected Backend Job Status` | Formula | Computed expected status |
| `Backend Status Match` | Formula | Flags mismatches for reconciliation |

### Automation Flow (when operator checks Dispatch Approved)

1. Airtable trigger fires (field updated)
2. Guard conditions checked: Dispatch Sent ≠ checked, Assigned Contractor ID not empty, Backend Job ID not empty, Dispatch Payment Eligible = 1
3. Airtable sets `Status = ready for dispatch`
4. Airtable script calls Make webhook URL stored in `Dispatch` field
5. Make calls `POST /jobs/:id/approve-dispatch` → `ready_for_dispatch`
6. Make calls `POST /jobs/:id/dispatch` → SMS sent to contractor
7. Results mirror back to Airtable via backend sync

---

## Key Engineering Decisions

**Why move from Jotform/Make/Airtable-native to a backend?**
The no-code stack worked for low volume but couldn't enforce state transitions, had no reliable payment confirmation, required manual contractor dispatch, and had no audit trail. At scale, Airtable as a source of truth is a liability.

**Why is Airtable a mirror, not a source of truth?**
Airtable's automation system has no atomic transactions, no state machine enforcement, and weak OR logic in triggers. Making it authoritative creates drift — Airtable says one thing, PostgreSQL says another. PostgreSQL is always authoritative. Airtable shows what happened.

**Why one active dispatch per contractor?**
The SMS webhook matches jobs by phone number. If a contractor has two active jobs, `CONFIRM` is ambiguous. Rather than change the SMS protocol (adding job tokens to replies), we block dispatching a second job to an already-active contractor. Simpler system, same safety.

**Why not bill immediately on `FINISH`?**
A contractor SMS is not auditable authorization to charge a customer. Moving to `completion_reported` first gives the operator a review gate. This prevents billing disputes and accidental charges.

**Why fire-and-forget Airtable sync?**
Airtable API failures should not roll back a DB transaction. A job being paid is critical; the Airtable mirror reflecting that payment is important but recoverable. The queue ensures durability without coupling core operations to a third-party API.

**Why keep Make.com in the dispatch flow?**
Make provides the routing logic, guard checks, and error handling for the dispatch scenario. The backend owns state — Make orchestrates the sequence of backend calls. This separation keeps the backend stateless from Make's perspective (just endpoints) and keeps Make from owning business logic.

---

## Deployment

Hosted on **Render** (Oregon region).

- **Build:** `npm install && npm run build`
- **Start:** `npm start`
- **Migrations:** Run automatically on startup (embedded in `src/db/embeddedMigrations.ts`)
- **Health check:** `GET /health`
- **Readiness check:** `GET /ready` (returns 503 until migrations verified)

### Database Migrations

| # | File | Summary |
|---|------|---------|
| 001 | `001_initial_schema.sql` | All core tables, enums, indexes |
| 002 | `002_seed_data.sql` | Service types, pricing rules, service areas |
| 003 | `003_fix_pricing.sql` | Small payout, treadmill base, fixed $25 deposits |
| 004 | `004_rush_tier.sql` | Rush pricing tiers, contractor rush bonuses |
| 005 | `005_job_financial_split.sql` | 7 financial split columns on jobs table |
| 006 | `006_fitness_equipment_service_type.sql` | Fitness equipment as distinct service type |

---

## Environment Variables

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | Yes | postgres:// connection string |
| `STRIPE_SECRET_KEY` | Yes | sk_live_... or sk_test_... |
| `STRIPE_WEBHOOK_SECRET` | Yes | whsec_... from Stripe Dashboard |
| `ADMIN_JWT_SECRET` | Yes | Random 64-char hex string |
| `APP_BASE_URL` | Yes | Render service URL |
| `FRONTEND_BASE_URL` | Yes | For Stripe checkout redirect URLs |
| `AIRTABLE_API_KEY` | Yes | pat... personal access token |
| `AIRTABLE_BASE_ID` | Yes | app... base ID |
| `QUO_API_KEY` | Yes | Quo SMS API key |
| `QUO_PHONE_NUMBER_ID` | Yes | Quo sending number ID |
| `REDIS_URL` | No | BullMQ degrades to in-process if absent |
| `ENABLE_TEST_ROUTES` | No | Set true only in staging |

---

## Commit History — Key Milestones

| Commit | Description |
|--------|-------------|
| Initial scaffold | Full MVP: schema, intake, payments, Airtable sync, 56 tests |
| `feat: rush tier support` | Same-day vs next-day across entire pipeline |
| `feat: full financial split` | 9 financial fields written to Airtable |
| `fix: airtable status field mapping` | Correct single-select values confirmed from live Airtable |
| `fix: circular dependency in app.ts` | Extracted schemaState.ts |
| `feat: auto-trigger checkout` | Customers pay immediately — no manual admin step |
| `feat: airtable payments child table` | Payment tracking in second Airtable table |
| `fix: area classification bug` | McDonough correctly classified as in-area |
| `feat: add approve-dispatch endpoint` (`df0dc2f`) | Operator gate before dispatch SMS |
| `fix: full payment checkout hardcoded as deposit` | Checkout type derived from intake data |
| `fix: airtable deposit breakdown for full-pay jobs` | Correct financial mirror for pay-in-full |
| `fix: rush fee not in deposit` | Rush amount included in deposit calculation |
| `fix: backend job ID not syncing to airtable` | Make can reference correct job |
| `fix: write Dispatch Status = Accepted after CONFIRM` (`ac0c2d2`) | Formula reconciliation working end-to-end |
| `feat: FINISH SMS command + completion_reported state` | Completion flow with operator review gate |
| `feat: approve-completion endpoint` | Branches to remainder billing or closed_paid |
| `feat(dispatch): guard against dispatching to contractor with active job` (`bda3573`) | Prevents SMS ambiguity |

---

*This document is updated continuously as the system evolves. Last updated: April 2026.*
*Built by Kenneth Thomas-Utsey with Claude (Anthropic) and Manus AI.*
