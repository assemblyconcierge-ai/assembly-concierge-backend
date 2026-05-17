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
9. [Phase 6 — Dispatch Hardening: Schedule-Aware Overlap Detection (April 2026)](#phase-6)
10. [Phase 7 — Cancel Assignment / Re-dispatch Path (April–May 2026)](#phase-7)
11. [Phase 8 — Airtable + Make: Cancel Assignment Automation (May 2026)](#phase-8)
12. [Phase 9 — Re-dispatch Edge Case and Make Scenario Routing (May 2026)](#phase-9)
13. [Phase 10 — Dispatch Precheck: Read-Only Contractor Availability Check (May 2026)](#phase-10)
14. [Phase 11 — Contractor Availability + Dispatch Lifecycle Automation (May 2026)](#phase-11)
15. [Phase 12 — OTW Tracking, Completion Timestamps, and Billing Fixes (May 2026)](#phase-12)
16. [Production SMS Command Routing and Lifecycle Hardening](#phase-13)
17. [Phase 14 — SMS Lifecycle Hardening: OTW Guard and Customer Confirmation (May 2026)](#phase-14)
18. [Phase 15 — Cancel Job Endpoint and Airtable Operator Workflow (May 2026)](#phase-15)
19. [Current Architecture](#current-architecture)
20. [Job State Machine](#job-state-machine)
21. [SMS Command Protocol](#sms-command-protocol)
22. [API Reference](#api-reference)
23. [Airtable Operator Interface](#airtable-operator-interface)
24. [Key Engineering Decisions](#key-engineering-decisions)
25. [Deployment](#deployment)
26. [Environment Variables](#environment-variables)
27. [Commit History](#commit-history--key-milestones)

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

**Evidence from Render logs (job AC-2026-EXAMPLE1):**
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
{"contractorId":"contractor_uuid_redacted","command":"CONFIRM","msg":"[SMS] No active job found for contractor — ignoring"}
```

**Root cause:** Two contractor records existed with the same phone number `+1XXXXXXXXXX`, both `is_active = true`. The SMS webhook matched the wrong one first (by `assigned_at DESC`). The correct contractor had the active job; the stale duplicate did not.

**Fix:**
```sql
UPDATE contractors SET is_active = false WHERE id = 'contractor_uuid_redacted';
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

<a name="phase-6"></a>
## Phase 6 — Dispatch Hardening: Schedule-Aware Overlap Detection (April 2026)

The original dispatch conflict guard blocked contractors from any job if they had any active job — regardless of schedule overlap. Replaced with actual window-based overlap detection.

Fix (fc7beda): Conflict check now uses `existing.scheduled_start_at < target.scheduled_end_at AND existing.scheduled_end_at > target.scheduled_start_at`. Fallback for unscheduled rows uses appointment_date + appointment_window.

Validated: Same contractor + overlapping window → 409 CONFLICT. Same contractor + non-overlapping window → 201 allowed.

---

<a name="phase-7"></a>
## Phase 7 — Cancel Assignment / Re-dispatch Path (April–May 2026)

No operator path existed to release a contractor without ending the job. Every bad dispatch left dirty state requiring manual SQL.

Built POST /jobs/:jobId/cancel-assignment (cd96851 + ab380d7):
- Cancels active assignment (pending or accepted)
- Sets contractor_assignments.status = cancelled
- Sets dispatches.status = expired (cancelled enum does not exist)
- Sets jobs.status = ready_for_dispatch
- No SMS, no Airtable update, no payment/customer/schedule changes
- Returns { success, jobId, cancelledAssignmentId, previousContractorId, jobStatus }

State machine: added assigned → ready_for_dispatch as valid transition.

Transaction hardened: SELECT ... FOR UPDATE inside transaction. Assignment UPDATE guarded by id + job_id + status IN ('pending','accepted') with rowCount validation.

Production bug found (ab380d7): contractor_assignments has no updated_at column — removed from UPDATE. dispatches and jobs both have updated_at and were unchanged.

Tests: 29/29 passing. TypeScript clean.

Live test AC-2026-EXAMPLE2 PASSED: HTTP 200, job reset to ready_for_dispatch, assignment cancelled, dispatch expired, schedule/payment fields unchanged, no SMS.

---

<a name="phase-8"></a>
## Phase 8 — Airtable + Make: Cancel Assignment Automation (May 2026)

New Airtable field: Cancel Assignment (checkbox).

New Airtable automation: Cancel Assignment - Trigger Make (OFF by default).
- Trigger: Cancel Assignment checked AND Backend Job ID not empty AND Assignment ID not empty
- Action: Run script → sends { "recordId": "<Airtable record ID>" } to Make webhook

New Make scenario: Cancel Assignment - Airtable Record.
- Module 1: Custom webhook (receives recordId)
- Module 2: Airtable Get a Record (Backend Intake Sandbox V2)
- Module 3: Filter guard
- Module 4: HTTP POST /jobs/:jobId/cancel-assignment with { "assignmentId": "..." }
- Module 5: Success — clears dispatch fields, sets Last Dispatch Result = cancelled, Backend Job Status = ready_for_dispatch
- Module 6: Failure — unchecks Cancel Assignment, writes error, does not clear dispatch fields
- Module 7: Gmail alert on failure

Success uses Make erase for linked/lookup fields. Fields cleared: Cancel Assignment, Dispatch Approved, Dispatch Sent, Dispatch Status (→ Pending Dispatch), Assigned Contractor, Assignment ID, Dispatch ID, Last Dispatch Error.

End-to-end tested AC-2026-EXAMPLE3 — full success path validated. Backend and Airtable mirror confirmed correct.

---

<a name="phase-9"></a>
## Phase 9 — Re-dispatch Edge Case and Make Scenario Routing (May 2026)

After cancel-assignment resets a job to ready_for_dispatch, re-checking Dispatch Approved caused Make to call approve-dispatch again. Backend correctly rejected: "Invalid job state transition: ready_for_dispatch → ready_for_dispatch".

Fix: Two router paths in the Make dispatch scenario.

Route 1 — First-time dispatch (needs approval):
Filter: Backend Job Status = deposit_paid or paid_in_full (plus standard guards).
Flow: Approve Dispatch → Dispatch HTTP → Success Update.

Route 2 — Re-dispatch after cancellation (skip approval):
Filter: Backend Job Status = ready_for_dispatch AND Dispatch Status = Pending Dispatch (plus standard guards).
Flow: Dispatch HTTP (cloned) → Success Update (cloned). Approve Dispatch skipped.

Validated: First dispatch, cancel, re-dispatch to new contractor, multiple cycles, busy contractor blocking — all working.

Airtable Expected Backend Job Status formula updated twice. Final logic:
1. Dispatch Accepted → assigned
2. Dispatch Sent → dispatch_in_progress
3. Dispatch Approved → ready_for_dispatch
4. Pending Dispatch AND Last Dispatch Result = cancelled → ready_for_dispatch
5. Payment Status paid_in_full → paid_in_full
6. Payment Status deposit_paid → deposit_paid

Correctly distinguishes post-cancel re-dispatch from first-time pre-dispatch.

<a name="phase-10"></a>
## Phase 10 — Dispatch Precheck: Read-Only Contractor Availability Check (May 2026)

No way existed to check contractor availability before committing a dispatch. Conflict detection only fired inside the dispatch transaction — producing a `409` after the operator had already chosen a contractor and submitted. This forced retry loops with no early signal.

Built `POST /jobs/:jobId/precheck-contractor` (`73050b9`):
- Read-only — no SMS, no state transition, no Airtable sync, no assignment or dispatch rows created
- Shared conflict logic extracted into `src/modules/dispatch/dispatchConflict.ts`, consumed by both `dispatch.service.ts` and the precheck handler
- Same overlap rules as dispatch: `scheduled_start_at < currentEnd AND scheduled_end_at > currentStart`. Fallback for unresolved rows uses `appointment_date + appointment_window`
- Returns a structured result rather than throwing: `{ status, available, note, conflictingJobKey?, conflictWindow? }`
- Requires admin auth. Response statuses: `Available` | `Conflict` | `Missing Contractor` | `Missing Schedule` | `Error`

Live smoke test (`73050b9`): `POST /jobs/job_uuid_redacted/precheck-contractor` → HTTP 200, `status: Conflict`, `available: false`, `conflictingJobKey: AC-2026-EXAMPLE4`, `conflictWindow: 2026-05-02 Afternoon(12pm-4pm)`. Job fields confirmed unchanged before and after: status remained `ready_for_dispatch`, `scheduled_start_at`, `scheduled_end_at`, `appointment_date`, and `appointment_window` all identical.

---

<a name="phase-11"></a>
## Phase 11 — Contractor Availability + Dispatch Lifecycle Automation (May 2026)

Completed and validated the contractor availability and dispatch lifecycle automation, tying together Airtable, Make, and backend dispatch state into a coherent operational workflow.

**Contractor availability automation.** Added an Airtable automation that fires when the operator selects an Assigned Contractor, sending the Airtable recordId to the Make availability scenario. The existing manual Check Contractor Availability checkbox was retained as a backup and recheck trigger — both paths send the same recordId to the same Make webhook, keeping the scenario single-entry.

**Make availability scenario.** Make receives the Airtable recordId, fetches the full job record, and calls `POST /jobs/:jobId/precheck-contractor`. The availability result (`Available` or `Conflict`) and supporting detail fields are written back to Airtable. Conflict detail fields clear correctly when the operator selects a new available contractor.

**Dispatch router hardening.** The Blocked Guard route was converted to a Make fallback route, eliminating double-execution when a valid dispatch path matched first. First-time dispatch (Backend Job Status = `deposit_paid` or `paid_in_full`) and re-dispatch after cancellation (Last Dispatch Result = `cancelled`) were separated into distinct route filters with independent HTTP and Success Update modules. Cancel → re-dispatch was tested successfully through multiple cycles.

**Backend Airtable sync fix.** Corrected a status mapping bug in `JOB_STATUS_MAP` (`airtable.adapter.ts`): `dispatch_in_progress` was mapped to `dispatch_ready` instead of `in_progress`. After Make set Status = `in_progress` on dispatch, the next backend sync overwrote it back to `dispatch_ready`. Fixed in commit `7a9e53a`. After the fix, all lifecycle fields align correctly post-dispatch:

| Airtable Field | Value After Dispatch |
|----------------|---------------------|
| Status | `in_progress` |
| Backend Job Status | `dispatch_in_progress` |
| Expected Backend Job Status | `dispatch_in_progress` |
| Backend Status Match | Match |
| Dispatch Sent | checked |
| Dispatch Status | Dispatch Sent |
| Assignment ID | populated |
| Dispatch ID | populated |

---

<a name="phase-12"></a>
## Phase 12 — OTW Tracking, Completion Timestamps, and Billing Fixes (May 2026)

### 12.1 Bug: Full-payment `approve-completion` left `remainder_amount_cents` non-zero

**Problem:** `jobs.remainder_amount_cents` is set at intake as a static pricing-split field. For full-payment jobs the configured pricing-split remainder is recorded even though the customer pays in full. When Stripe's `checkout.session.completed` fired for a full-payment job, the `UPDATE jobs` query in `handleCheckoutCompleted` did not include `remainder_amount_cents = 0`. The field stayed at the intake value in both PostgreSQL and Airtable.

When a contractor later texted `FINISH` and the operator hit `approve-completion`, the endpoint evaluated `remaining_balance_cents > 0` and incorrectly routed the job to `awaiting_remainder_payment` instead of `closed_paid` — attempting to generate a remainder invoice on an already fully-paid job.

**Fix (`5f80aec`):**
- `stripe.webhook.ts` (`handleCheckoutCompleted`): Extended the full-payment `UPDATE jobs` query to include `remainder_amount_cents = 0`.
- `jobs.routes.ts` (`approve-completion`): Added a defensive payment-record lookup. If the job's payments table contains a `paid_in_full` record, `remaining_balance_cents` resolves to `0` regardless of what `remainder_amount_cents` stores in the jobs row, routing correctly to `closed_paid`.

---

### 12.2 Bug: OTW command advanced job to `scheduled`

**Problem:** `COMMAND_TARGET_STATUS` mapped `OTW → 'scheduled'`. A contractor who texted `OTW` advanced the job to `scheduled`. From `scheduled` there is no valid state machine path to `completion_reported`, so a subsequent `FINISH` would silently skip the job status update while still marking the assignment completed — leaving the job stuck at `scheduled` with no path to billing.

**Fix (`252ca15`):** Changed `OTW: 'scheduled'` to `OTW: 'assigned'` in `COMMAND_TARGET_STATUS`. OTW is an operational signal only — the job stays at `assigned`. The `assertTransition(assigned, assigned)` call is caught by the existing no-op catch block.

---

### 12.3 Bug: `dispatch_status` missing from Airtable sync SELECT projection

**Problem:** `airtableSync.queue.ts` added a LATERAL join to fetch the latest dispatch status but omitted `d.dispatch_status` from the SELECT list. `row.dispatch_status` was `undefined` at runtime; Airtable received `undefined` and silently dropped the field update.

**Fix (`6cfc4eb`):** Added `d.dispatch_status` to the SELECT projection.

---

### 12.4 Bug: `DONE`/`FINISH` accepted before contractor assignment confirmed

**Problem:** A contractor with a `dispatch_in_progress` job (assignment status `pending`) could text `FINISH`. The state machine correctly blocked `dispatch_in_progress → completion_reported`, so the job status update was skipped. But the assignment side effect still ran: `contractor_assignments.status` was set to `completed` on a `pending` assignment — corrupted state.

**Fix (`53b9f1c`):** Added an early-exit guard before the transaction: if `command === 'DONE' || command === 'FINISH'` and `activeJob.assignment_status !== 'accepted'`, log a warning and return. The transaction does not run at all when the assignment has not been accepted.

---

### 12.5 Feature: `contractor_en_route_at` timestamp

Added `contractor_en_route_at TIMESTAMPTZ` to the `jobs` table (migration 010). When a contractor texts `OTW`, the transaction sets:

```sql
UPDATE jobs
   SET contractor_en_route_at = COALESCE(contractor_en_route_at, NOW()),
       updated_at = NOW()
 WHERE id = $1
```

`COALESCE` ensures the first OTW wins — repeated OTW texts do not overwrite the original timestamp.

---

### 12.6 Feature: Customer OTW SMS notification

When a contractor texts `OTW`, the backend sends a one-time SMS to the customer notifying them the contractor is en route.

**Implementation details:**
- Runs inline after the DB transaction, before `enqueueAirtableSync` — no `setImmediate`
- DB re-check on `customer_otw_text_sent_at` (not the pre-fetched value) to prevent duplicates under concurrent OTW texts
- Uses contractor first name when available: *"Your Assembly Concierge contractor, [First Name], is on the way for your appointment. Please keep your phone nearby in case they need to reach you."*
- Falls back to a generic message if name parsing fails
- Inner `try/catch` on `sendSms` only — failure sets `customer_otw_text_status = 'failed'` without throwing
- Outer `try/catch` ensures OTW notification errors never propagate out of `processSmsWebhook`
- If `customer_phone` is missing: sets `customer_otw_text_status = 'skipped'`, leaves `customer_otw_text_sent_at = null` so future OTW texts can retry

---

### 12.7 Feature: `completion_reported_at` timestamp

Added `completion_reported_at TIMESTAMPTZ` to `jobs` (migration 009). When a contractor texts `FINISH` or `DONE` and the job transitions to `completion_reported`, the UPDATE includes `completion_reported_at = NOW()`. Propagated to Airtable on every sync.

---

### 12.8 Feature: `completed_at` timestamp

Added `completed_at TIMESTAMPTZ` to `jobs` (migration 010). Written in three places:

| Trigger | Write Site |
|---------|-----------|
| `approve-completion` Path B — no remainder balance | `jobs.routes.ts` inline query |
| Stripe `checkout.session.completed` — two-step remainder (`deposit_paid → closed_paid`) | `stripe.webhook.ts` if-branch |
| Stripe `checkout.session.completed` — normal remainder (`awaiting_remainder_payment → closed_paid`) | `stripe.webhook.ts` else-branch |

Full-payment jobs that go to `closed_paid` via `approve-completion` Path B get `completed_at` at operator approval. Deposit jobs get `completed_at` when Stripe confirms the final payment.

---

### 12.9 Feature: `customer_otw_text_sent_at` / `customer_otw_text_status`

Added two columns (migration 010):
- `customer_otw_text_sent_at TIMESTAMPTZ` — populated only on successful send
- `customer_otw_text_status TEXT` — `'sent'` | `'failed'` | `'skipped'`

`customer_otw_text_status` is an Airtable Single Select with exact lowercase values — mapped via `CUSTOMER_OTW_TEXT_STATUS_MAP` in `airtable.adapter.ts` to prevent 422 errors from capitalization mismatches.

---

### 12.10 Migration 010: four new job columns

```sql
-- 010_add_otw_and_completion_fields.sql
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS completed_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contractor_en_route_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_otw_text_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_otw_text_status  TEXT;
```

Runs automatically on startup via `embeddedMigrations.ts`. All columns nullable — no backfill required.

---

### 12.11 Airtable sync: four new fields propagated

`airtable.adapter.ts` and `airtableSync.queue.ts` extended to propagate all four new columns. `updateAirtableStatus` signature extended to 13 parameters. Fields written conditionally (nulls not sent):

| Airtable Field | Source Column | Type |
|---------------|--------------|------|
| `Completed At` | `jobs.completed_at` | Date/time |
| `Contractor En Route At` | `jobs.contractor_en_route_at` | Date/time |
| `Customer OTW Text Sent At` | `jobs.customer_otw_text_sent_at` | Date/time |
| `Customer OTW Text Status` | `jobs.customer_otw_text_status` | Single Select (mapped) |

---

### 12.12 Contractor Decline and Re-Dispatch Flow

When a contractor texts `DECLINE`:
1. Backend moves job to `ready_for_dispatch`; `contractor_assignments.status = declined`; `dispatches.status = declined`, `assigned_contractor_id = NULL`
2. Airtable sync runs and mirrors `Dispatch Status = Declined`
3. Airtable/Make cleanup fires — cleared fields: `Dispatch Approved`, `Dispatch Sent`, `Assigned Contractor`, `Assignment ID`, `Dispatch ID`, `Last Dispatch Error`, `Contractor Availability Status`, `Contractor Availability Note`
4. `Last Dispatch Result = declined` is preserved so the operator knows why the job returned to queue
5. Operator selects a new contractor and re-dispatches using the standard dispatch flow

The decline cleanup uses the same field-erase pattern as the cancel-assignment automation (Phase 8), keeping a single consistent reset surface regardless of why a contractor was released.

---

### 12.13 Make Re-Dispatch Filter Hardening

The Make dispatch scenario Route 2 (re-dispatch after contractor release) was extended to handle declined jobs alongside cancelled ones:

**Route 2 gate conditions:**
- Backend Job Status: `ready_for_dispatch`
- Dispatch Status: `Pending Dispatch` OR `Declined`
- Last Dispatch Result: `declined`, `cancelled`, or `blocked`

**States that remain blocked from re-dispatch:**
`Dispatch Sent`, `Accepted`, `assigned`, `completion_reported`, `awaiting_remainder_payment`, `closed_paid`

This prevents the re-dispatch route from firing on active jobs and limits it to jobs that are genuinely back in queue after a contractor release.

---

### 12.14 Ownership Boundaries

**Backend-owned (PostgreSQL authoritative, Airtable is read-only mirror):**
- `job.status` — job lifecycle state machine
- `payment_type`, `payment_status`, `remainder_amount_cents` — payment state
- `completion_reported_at` — when contractor reported completion
- `completed_at` — when job reached `closed_paid`
- `contractor_en_route_at` — when contractor first texted OTW
- `customer_otw_text_sent_at` — when customer OTW SMS was delivered
- `customer_otw_text_status` — SMS delivery outcome
- Remaining balance (computed from payment records)
- Dispatch status mirror (from `dispatches` table)

**Airtable/Make-owned (not written by backend):**
- `Dispatch Approved` — operator input checkbox
- `Dispatch Sent` — set by Make after dispatch SMS sent
- `Assigned Contractor`, `Assignment ID`, `Dispatch ID` — dashboard reference fields, set and cleared by Make
- `Last Dispatch Result`, `Last Dispatch Error` — Make-written outcome fields
- `Completion Approved` — operator input checkbox
- `Completion Approved At`, `Last Completion Result`, `Last Completion Error` — Make-written completion fields
- Cleanup/reset fields — managed by Make automation scripts

---

### 12.15 Validated End-to-End Flows

| Flow | Status Path |
|------|------------|
| Deposit path | `awaiting_payment → deposit_paid → dispatch_in_progress → assigned → completion_reported → awaiting_remainder_payment → closed_paid` |
| Full-payment path | `awaiting_payment → paid_in_full → dispatch_in_progress → assigned → completion_reported → closed_paid` |
| Decline / re-dispatch | `dispatch_in_progress` or `assigned` → `ready_for_dispatch` (DECLINE) → dashboard cleanup → new dispatch → `dispatch_in_progress → assigned` |
| OTW customer notification | `assigned` + OTW SMS → `contractor_en_route_at` set → customer notified → `customer_otw_text_status = sent` |

---

### 12.16 State after Phase 12

| Airtable Field | Populated When |
|---------------|---------------|
| `Contractor En Route At` | Contractor texts OTW |
| `Customer OTW Text Status` | OTW processed (`sent` / `failed` / `skipped`) |
| `Customer OTW Text Sent At` | Customer SMS delivered successfully |
| `Completion Reported At` | Contractor texts FINISH or DONE |
| `Completed At` | Job reaches `closed_paid` |

TypeScript: clean via `npx tsc --noEmit`.

---

<a name="phase-13"></a>
## Production SMS Command Routing and Lifecycle Hardening

Phase 13 hardened contractor SMS from a best-effort command parser into a guarded production workflow. The work focused on backend reliability: commands now route to the intended job, reject unsafe lifecycle timing, and avoid side effects when contractor replies are ambiguous or out of sequence.

**Reliability improvements:**
- SMS lifecycle hardening blocks `OTW`, `DONE`, and `FINISH` before contractor confirmation, preventing pending assignments from being advanced or completed.
- Job-key routing supports contractor replies such as `CONFIRM AC-2026-XXXX`, `OTW AC2026XXXX`, and `DONE AC-2026-XXXX`, so commands target the correct active job.
- Multiple-active-job ambiguity protection rejects unkeyed commands when a contractor has more than one active job instead of guessing by most recent assignment.
- Contractor helper messages now list the contractor's active job codes and provide clear retry formats for ambiguous, unknown-code, or confirm-first cases.
- Rejected commands do not send customer SMS, enqueue Airtable sync, or change job state, keeping invalid replies from creating partial production side effects.

**Production validation:** Render logs confirmed the hardened paths in production, including rejected pre-confirmation `OTW` / `DONE` commands with no customer SMS, Airtable sync, or job state change. The full workflow was then validated end to end: dispatch → `CONFIRM` → `OTW` → `DONE` → Airtable sync → remainder checkout/payment.

**Commits:** `fc33ffe fix(sms): harden contractor command state checks`; `369dccd fix(sms): route contractor commands by job key`; `6002479 fix(sms): improve contractor command helper messages`.

---

<a name="phase-14"></a>
## SMS lifecycle hardening update

Commit: `697eee7 fix(sms): improve contractor and customer confirmation messaging`

Completed:
- Fixed early `OTW` before `CONFIRM` for contractors with exactly one pending/unconfirmed job.
- Contractor now receives a confirm-first helper instead of the message being silently ignored.
- Added customer confirmation SMS after contractor `CONFIRM`.
- Added duplicate guard fields:
  - `customer_confirm_text_sent_at`
  - `customer_confirm_text_status`
- Added embedded migration `011_add_customer_confirm_text_fields.sql`.
- Updated SMS unit tests.

Validation:
- `npx vitest run tests/unit/smsService.test.ts`
- Result: 26/26 tests passed.

Deployment:
- Pushed to `origin/main`.
- Render deployment/production validation pending.

Notes:
- No job status changes occur on early `OTW`.
- Customer confirmation SMS only sends after successful `CONFIRM`.
- Existing OTW customer SMS behavior remains unchanged.

---

<a name="phase-15"></a>
## Phase 15 — Cancel Job Endpoint and Airtable Operator Workflow (May 2026)

Commit: `8bc2ec2 feat(jobs): add admin cancel job endpoint`

### 15.1 Backend endpoint

`POST /jobs/:jobId/cancel`

- **Auth:** `requireAdmin` — accepts `X-Admin-Token` header or Bearer token.
- **Body:** `{ "reason": "optional cancellation reason" }`

**Behavior:**

- Locks the job row with `SELECT … FOR UPDATE` and transitions any cancellable job to `cancelled`.
- Cancels all active contractor assignments for the job.
- Expires all linked dispatches.
- Writes a `job.cancelled` audit event containing: cancellation reason, previous job status, cancelled assignment count, and expired dispatch count.
- Queues an Airtable sync after the transaction commits.
- Does **not** send SMS to the contractor.
- Does **not** modify payment records.

### 15.2 Airtable / Make operator workflow

**Airtable fields added:**

| Field | Type | Purpose |
|---|---|---|
| `Cancel Job Requested` | Checkbox | Operator intent signal — first gate |
| `Cancel Job Confirmed` | Checkbox | Operator confirmation — second gate |
| `Cancel Job Reason` | Text | Operator-entered reason; forwarded to backend audit payload |
| `Last Cancel Job At` | Date/time | Timestamp of most recent cancel attempt |
| `Last Cancel Job Result` | Text | `Success` or `Failed` |
| `Last Cancel Job Error` | Text | Error detail on failure |

**Double-confirmation safety gate:**

Both `Cancel Job Requested` and `Cancel Job Confirmed` must be checked before the Airtable automation fires. This prevents accidental cancellations from a single checkbox click.

**Workflow sequence:**

1. Operator checks `Cancel Job Requested` and `Cancel Job Confirmed`, and optionally fills `Cancel Job Reason`.
2. Airtable automation sends `recordId`, Backend Job ID, Job Key, and reason to Make.
3. Make scenario calls `POST /jobs/:jobId/cancel` on the backend.
4. On success, Make clears both checkboxes and writes success metadata to `Last Cancel Job At`, `Last Cancel Job Result`.
5. Backend Airtable sync (triggered by the cancel transaction) owns backend status, dispatch status, assignment fields, and payment fields — Make does not manually update these.

### 15.3 Validation

- `npm run build` passed.
- Targeted unit tests passed: **49/49**.
- Render deployed commit `8bc2ec2`.
- Direct backend test passed for `ready_for_dispatch → cancelled`.
- Make-triggered active cleanup validated on job `AC-2026-IA3V`:
  - `previousJobStatus`: `assigned`
  - `status`: `cancelled`
  - `cancelledAssignmentCount`: `1`
  - `expiredDispatchCount`: `1`
- Make HTTP module returned HTTP 200; backend response confirmed `Job cancelled`.
- Make failure route validated using an already-cancelled job: failure route sets `Last Cancel Job Result = Failed`, populates `Last Cancel Job Error`, and clears `Cancel Job Requested` / `Cancel Job Confirmed`.

### 15.4 Notes

- Active assignment and dispatch cleanup are validated end-to-end.
- Payment records are intentionally untouched by the cancel endpoint.
- `Cancel Job Reason` is operator-entered in Airtable and forwarded to the backend audit payload.
- Backend-owned Airtable fields (status, dispatch status, assignment fields, payment fields) are not manually updated by Make.

### 15.5 Next steps

- Add final operator-use documentation for the cancel workflow.
- Continue backend hardening roadmap after Cancel Job workflow.

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
Contractor replies OTW when en route
        ↓
POST /webhooks/sms → contractor_en_route_at set → customer SMS sent → Airtable sync (async)
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
| `OTW` | otw, on my way, omw, heading over, leaving now, headed there | `assigned` (no-op) | Sets `contractor_en_route_at`; sends customer OTW SMS; job status unchanged |
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
| POST | `/jobs/:jobId/cancel-assignment` | Cancel active contractor assignment, return job to ready_for_dispatch. Body: `{ "assignmentId": "optional-uuid" }` |
| POST | `/jobs/:jobId/precheck-contractor` | Read-only contractor availability check. Body: `{ "contractorId": "uuid" }` |

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
| `Completed At` | Backend mirror | Timestamp when job reached `closed_paid` (`completed_at`) |
| `Contractor En Route At` | Backend mirror | Timestamp when contractor first texted OTW (`contractor_en_route_at`) |
| `Customer OTW Text Sent At` | Backend mirror | Timestamp when customer OTW SMS was delivered |
| `Customer OTW Text Status` | Backend mirror | SMS delivery outcome: `sent` / `failed` / `skipped` |
| `Minutes OTW to Completion` | Formula | Minutes between `Contractor En Route At` and `Completion Reported At` |

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
| 007 | `007_add_missing_job_status_values.sql` | Add `dispatch_ready` and `completion_reported` to `job_status` enum |
| 008 | `008_add_schedule_fields.sql` | `scheduled_start_at`, `scheduled_end_at`, `timezone` on jobs |
| 009 | `009_add_completion_reported_at.sql` | `completion_reported_at` timestamp on jobs |
| 010 | `010_add_otw_and_completion_fields.sql` | `completed_at`, `contractor_en_route_at`, `customer_otw_text_sent_at`, `customer_otw_text_status` on jobs |

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
| `fix(dispatch): schedule-aware overlap detection` (`fc7beda`) | Window-based conflict check replaces blanket active-job block |
| `feat(dispatch): add cancel assignment endpoint` (`cd96851`) | POST /jobs/:jobId/cancel-assignment — releases contractor, returns job to ready_for_dispatch |
| `fix(dispatch): remove invalid assignment updated_at update` (`ab380d7`) | contractor_assignments has no updated_at column — removed from UPDATE |
| `feat(dispatch): add contractor precheck endpoint` (`73050b9`) | POST /jobs/:jobId/precheck-contractor — read-only availability check; shared conflict helper in dispatchConflict.ts |
| `fix(airtable): map dispatch_in_progress to in_progress` (`7a9e53a`) | Correct Airtable Status field mapping — dispatch_in_progress now mirrors to in_progress instead of dispatch_ready |
| `docs(portfolio): add contractor availability lifecycle milestone` (`d957a12`) | Phase 11 documentation — contractor availability automation, Make dispatch routing, dispatch status mapping |
| `fix(airtable): map completion reported to in progress` (`284936e`) | `completion_reported` Airtable status maps to `in_progress`; prior mapping was missing |
| `fix(sms): block completion before contractor acceptance` (`53b9f1c`) | DONE/FINISH guard — rejects completion SMS if assignment is still pending, prevents corrupted assignment state |
| `feat(completion): sync completion reported timestamp` (`116833f`) | `completion_reported_at` timestamp propagated to Airtable on every sync |
| `test: stabilize current baseline fixtures` (`fd181b9`) | Test suite baseline fixtures updated after schema additions |
| `fix(sms): keep OTW from changing job lifecycle state` (`252ca15`) | OTW maps to `assigned` (no-op transition) instead of `scheduled`; OTW is an operational signal only |
| `fix(airtable): update remaining balance on sync` (`8ea4aef`) | Remaining balance field propagated on every Airtable sync |
| `fix(airtable): sync latest dispatch status` (`935f5fd`) | Latest dispatch status fetched and mirrored on every sync |
| `fix(airtable): include dispatch status in sync query` (`6cfc4eb`) | `dispatch_status` added to SELECT projection — previously undefined at runtime |
| `fix(payments): zero remainder_amount_cents on full payment and guard approve-completion` (`5f80aec`) | Full payment webhook zeroes `remainder_amount_cents`; approve-completion checks actual payment records defensively |
| `feat(tracking): add OTW and completion lifecycle timestamps` (`5f7d7ab`) | Migration 010; `completed_at`, `contractor_en_route_at`, `customer_otw_text_sent_at/status`; customer OTW SMS; Airtable sync for all 4 fields |
| `fix(sms): harden contractor command state checks` (`fc33ffe`) | Explicit SMS command rules enforce job + assignment state before transactions; adds unit coverage for invalid sequencing |
| `fix(sms): route contractor commands by job key` (`369dccd`) | Optional job-key routing, ambiguity prompts, post-`CONFIRM` address instructions, and command tests |
| `fix(sms): improve contractor command helper messages` (`6002479`) | Ambiguity SMS lists active job codes; confirm-first helpers guide out-of-order OTW/DONE/FINISH replies |
| `fix(sms): improve contractor and customer confirmation messaging` (`697eee7`) | Migration 011; `customer_confirm_text_sent_at/status`; customer confirmation SMS after CONFIRM; confirm-first helper for plain OTW before CONFIRM on single pending job |
| `feat(jobs): add admin cancel job endpoint` (`8bc2ec2`) | `POST /jobs/:jobId/cancel` — locks job row, transitions to `cancelled`, cancels active assignments, expires dispatches, writes `job.cancelled` audit event; Airtable double-confirmation safety gate via Make |

---

## Portfolio Highlights

- **End-to-end job lifecycle system** — designed and built a production Node.js/TypeScript/PostgreSQL backend for a real operating business, handling customer intake, Stripe payment processing, contractor dispatch via SMS, operator approval gates, and remainder billing with a fully enforced 16-status state machine.
- **Real-time contractor coordination via SMS** — built an inbound SMS webhook handler that fuzzy-matches natural-language contractor replies (`confirm`, `on my way`, `finish`), routes ambiguous replies by job key, enforces command/state guards, and drives atomic job state transitions, customer OTW notifications, and Airtable sync.
- **Full-stack Airtable + Make.com automation** — designed multi-route Make.com dispatch scenarios covering first dispatch, decline/re-dispatch, cancel/re-dispatch, and contractor availability checks, with Airtable as an operator mirror and PostgreSQL as the single source of truth.
- **Fault-tolerant payment pipeline** — integrated Stripe Checkout with idempotent webhook processing, deposit/remainder split billing, full-payment edge-case handling, and automatic remainder invoice generation after operator-approved job completion.

---

*This document is updated continuously as the system evolves. Last updated: May 2026.*
*Built by Kenneth Thomas-Utsey with Claude (Anthropic) and Manus AI.*
