# Assembly Concierge Backend — State Snapshot
**Generated:** 2026-03-15  
**Purpose:** Safe session handoff / context restore document

---

## 1. Repository State

| Property | Value |
|---|---|
| Repository | `https://github.com/assemblyconcierge-ai/assembly-concierge-backend` |
| Branch | `main` |
| HEAD commit | `8b096ef` |
| Local uncommitted changes | None (working tree clean) |
| Untracked scripts (not committed, not harmful) | `scripts/dump-airtable-schema.mjs`, `scripts/fetch_airtable_options.mjs`, `scripts/test-pricing-v2.mjs`, `scripts/test-pricing.mjs` |

### Files Modified This Session (commits `628efe1` → `8b096ef`)

| Commit | Hash | Files Changed |
|---|---|---|
| fix: restore lifecycle status + Stripe ID population | `628efe1` | `src/modules/airtable-sync/airtableSync.queue.ts`, `src/modules/jobs/jobs.routes.ts` |
| fix: commit missing adapter — add 4th param | `8bda401` | `src/modules/airtable-sync/airtable.adapter.ts` |
| fix: correct Status field mapping | `8b096ef` | `src/modules/airtable-sync/airtable.adapter.ts` |

### Recent Git Log (last 10)

```
8b096ef  fix(airtable): correct Status field mapping to confirmed Airtable allowed values
8bda401  fix(airtable): commit missing adapter changes — add 4th param + lifecycle status field
628efe1  fix(airtable): restore lifecycle status + Stripe ID population for new records
25c505d  Remove: delete temporary /admin/airtable-schema endpoint
13d28cc  Temp: add GET /admin/airtable-schema proxy endpoint for schema audit
a7389e0  Fix: remove 'Status' field from Airtable sync payload
3fa1805  Fix: add app.set('trust proxy', 1) to resolve ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
d54c711  Feat: full financial split — all 9 fields written to Airtable on every job
e390cb6  Feat: full rush tier support — same-day vs next-day across entire pipeline
9fc0a72  Feat: extend Airtable sync with 11 new fields from expanded Jobs table
```

---

## 2. Deployment State

| Property | Value |
|---|---|
| Render service name | `assembly-concierge-api` |
| Render region | `oregon` |
| Render plan | `starter` |
| Health check path | `GET /health` |
| Readiness check path | `GET /ready` |
| Build command | `npm install && npm run build` |
| Start command | `npm start` |
| Current deployed commit | Unknown — check Render dashboard. Last successful push: `8b096ef` |

### Environment Variables Expected (names only, no values)

| Variable | Source | Notes |
|---|---|---|
| `NODE_ENV` | Render env | Set to `production` |
| `PORT` | Render env | Set to `10000` |
| `DATABASE_URL` | Render database | Auto-injected from `assembly-concierge-db` |
| `REDIS_URL` | Manual | Optional — queues degrade gracefully without it |
| `STRIPE_SECRET_KEY` | Manual | `sk_live_...` or `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | Manual | `whsec_...` from Stripe Dashboard |
| `AIRTABLE_API_KEY` | Manual | `pat...` personal access token |
| `AIRTABLE_BASE_ID` | Manual | `app...` base ID |
| `AIRTABLE_TABLE_JOBS` | Render env | Defaults to `Jobs` if not set |
| `APP_BASE_URL` | Manual | Set after first deploy |
| `ADMIN_JWT_SECRET` | Auto-generated | Render generates value |
| `JOTFORM_WEBHOOK_SECRET` | Manual | Optional HMAC verification |
| `MAKE_WEBHOOK_SECRET` | Manual | Optional |
| `EMAIL_PROVIDER_API_KEY` | Manual | Optional |
| `EMAIL_FROM` | Manual | Defaults to `noreply@assemblyconcierge.com` |
| `SMS_PROVIDER_API_KEY` | Manual | Optional |
| `SMS_FROM` | Manual | Optional |
| `STORAGE_BUCKET` | Manual | Optional |
| `STORAGE_ACCESS_KEY` | Manual | Optional |
| `STORAGE_SECRET_KEY` | Manual | Optional |
| `STORAGE_ENDPOINT` | Manual | Optional |

---

## 3. Database State

### Migrations Applied (in order)

| # | File | Summary |
|---|---|---|
| 001 | `001_initial_schema.sql` | All core tables, enums, indexes |
| 002 | `002_seed_data.sql` | Service types, service areas (Hampton/Stockbridge/McDonough GA), pricing rules, config entries |
| 003 | `003_fix_pricing.sql` | Corrects small payout ($55), treadmill base ($189), all deposits to fixed $25 |
| 004 | `004_rush_tier.sql` | Adds `rush_type TEXT` to `jobs`; adds `next_day_rush_price_cents` and `contractor_rush_bonus_cents` to `pricing_rules` |
| 005 | `005_job_financial_split.sql` | Adds 7 financial split columns to `jobs`: `base_price_cents`, `flat_payout_cents`, `contractor_rush_bonus_cents`, `contractor_total_payout_cents`, `rush_platform_share_cents`, `stripe_fee_cents`, `job_margin_cents` |

Migrations 003–005 are embedded in `src/db/embeddedMigrations.ts` and run automatically on server start via `src/db/migrate.ts`.

### Core Tables (intake pipeline)

| Table | Purpose |
|---|---|
| `customers` | Upserted on every intake; keyed by email |
| `addresses` | One per job; city defaults to `GA` state if not provided |
| `intake_submissions` | Raw Jotform payload stored immediately on receipt; idempotency key prevents duplicates |
| `service_types` | Lookup table: small / medium / large / treadmill / custom |
| `service_areas` | In-area cities: Hampton, Stockbridge, McDonough (GA). All others → `quote_only` |
| `pricing_rules` | Base price, rush fees, deposit, contractor payout per service type |
| `jobs` | Core job record; holds all financial fields, status, Airtable record ID |
| `payments` | One per Stripe checkout session; holds `provider_session_id` and `provider_payment_intent_id` |
| `payment_events` | Idempotent Stripe webhook event log |
| `integration_failures` | Retry queue for failed Airtable syncs |
| `audit_events` | Append-only event log for all state transitions |

### Schema Assumptions

- `jobs.airtable_record_id` is `NULL` until first successful Airtable sync; the sync worker checks this to decide create vs update.
- `jobs.status` uses the `job_status` Postgres enum (16 values — see Section 6).
- `jobs.service_area_status` uses the `service_area_status` enum: `in_area | quote_only | blocked`.
- `payments` table uses a `LATERAL` join in the Airtable sync query to get the most recent payment record per job.
- `intake_submissions.raw_payload_json` stores the original Jotform payload; photo URLs and payment type labels are extracted from it at sync time.

### Confirmed Pricing Rules (post-migration-003)

| Service Type | Base Price | Deposit | Contractor Payout | Same-Day Rush | Next-Day Rush |
|---|---|---|---|---|---|
| small | $109.00 | $25.00 | $55.00 | +$30 | +$20 |
| medium | $149.00 | $25.00 | $80.00 | +$30 | +$20 |
| large | $199.00 | $25.00 | $110.00 | +$30 | +$20 |
| treadmill | $189.00 | $25.00 | $130.00 | +$30 | +$20 |
| custom | $0 | $0 | $0 | — | — |

Contractor rush bonus: $20 same-day, $14 next-day (calculated as `next_day_rush_price_cents - 6`).  
Stripe fee estimate: `(totalCents × 2.9%) + $0.30`.  
Job margin: `total - stripeFee - contractorTotalPayout`.

---

## 4. Webhook / Intake Pipeline

### Endpoint

```
POST /webhooks/jotform
```

Registered in `src/modules/intake/intake.routes.ts`. The `jotformBodyParser` middleware (mounted only on this path in `app.ts`) handles all Jotform content types before Express routing.

### Normalization Flow

```
Raw POST body
  ↓
jotformBodyParser (src/common/middleware/jotformBodyParser.ts)
  Handles: multipart/form-data, application/x-www-form-urlencoded,
           application/json, text/plain, no content-type
  If body already parsed by express.json/urlencoded → passes through
  ↓
intake.routes.ts handler
  If body has 'rawRequest' key → JSON.parse(body.rawRequest) (Jotform envelope format)
  Otherwise → use body directly (direct JSON / Make.com)
  ↓
normalizeJotformPayload(rawPayload)  (src/modules/intake/jotform.normalizer.ts)
  Uses DEFAULT_JOTFORM_FIELD_MAPPING to extract fields via get() resolver
  get() supports: exact flat key, bracket-notation literal, nested object, dot-notation
  Returns CanonicalIntake object
  ↓
processIntake(submissionId, normalized, correlationId)  (src/modules/intake/intake.service.ts)
```

### Job Creation Flow (inside `processIntake`)

```
1. classifyServiceArea(city, state)
   → in_area | quote_only | blocked
   → blocked cities → initialStatus = 'cancelled'
   → quote_only → initialStatus = 'quoted_outside_area'

2. lookupPricing(serviceTypeCode, rushTier)
   → PricingResult with all financial split fields

3. Determine paymentMode
   → 'full' | 'deposit' | 'quote_only' | 'custom_review'

4. Determine initialStatus
   → blocked          → 'cancelled'
   → quote_only       → 'quoted_outside_area'
   → custom_review    → 'intake_validated'
   → no pricing found → 'error_review'
   → otherwise        → 'awaiting_payment'

5. DB transaction:
   - upsertCustomer (by email)
   - createAddress
   - createJob (with all financial fields)
   - recordAuditEvent

6. enqueueAirtableSync (non-blocking, after transaction)
```

### Airtable Sync Trigger Points

| Trigger | Location | Notes |
|---|---|---|
| Job created (intake) | `intake.service.ts` line 178 | After DB transaction commits |
| Checkout session created | `jobs.routes.ts` line 71 | `setImmediate` after Stripe session created; writes Checkout Session ID |
| Remainder payment session created | `jobs.routes.ts` line 186 | Same pattern |
| Payment confirmed (webhook) | `stripe.webhook.ts` line 196 | After `checkout.session.completed` updates DB; writes Payment Intent ID |
| Payment intent succeeded (secondary) | `stripe.webhook.ts` | Secondary guard; writes Payment Intent ID if not already set |

---

## 5. Airtable Integration

### Table

Default table name: `Jobs` (overridden by `AIRTABLE_TABLE_JOBS` env var).

### Fields Written by the Backend

| Airtable Field | Type | Source |
|---|---|---|
| `Job Key` | Text | Generated (`AC-XXXXXX`) |
| `Customer Name` | Text | `customers.full_name` |
| `Customer Email` | Text | `customers.email` |
| `Customer Phone` | Text | `customers.phone_e164` |
| `City` | Text | `jobs.city_detected` |
| `Service Type` | Single Select | `mapServiceType(service_type_code)` |
| `Rush Requested` | Checkbox | `jobs.rush_requested` |
| `Total Amount` | Currency | `jobs.total_amount_cents / 100` |
| `Deposit Amount` | Currency | `jobs.deposit_amount_cents / 100` |
| `Status` | Single Select | `mapJobStatus(jobs.status)` — see mapping below |
| `Area Status` | Single Select | `mapAreaStatus(jobs.service_area_status)` — see mapping below |
| `Created At` | DateTime | `jobs.created_at` |
| `Appointment Date` | Date | `jobs.appointment_date` |
| `Appointment Window` | Text | `jobs.appointment_window` |
| `Address Line 1` | Text | `addresses.line1` |
| `State` | Text | `addresses.state` |
| `Postal Code` | Text | `addresses.postal_code` |
| `Customer Notes` | Long Text | `jobs.custom_job_details` |
| `Job Photos` | Attachment | Extracted from `intake_submissions.raw_payload_json` |
| `Remaining Balance` | Currency | `jobs.remainder_amount_cents / 100` |
| `Payment Type` | Text | Extracted from raw payload `q83_paymentType` |
| `Stripe Checkout Session ID` | Text | `payments.provider_session_id` |
| `Stripe Payment Intent ID` | Text | `payments.provider_payment_intent_id` |
| `Service Type Code` | Text | Raw code (e.g. `small`) |
| `Rush Type` | Text | `jobs.rush_type` (e.g. `Same-day (+30)`) |
| `Dispatch Status` | Single Select | Always `Pending Dispatch` at intake |
| `Base Price` | Currency | `jobs.base_price_cents / 100` |
| `Rush Fee Amount` | Currency | `(total - base) / 100` |
| `Contractor Flat Payout` | Currency | `jobs.flat_payout_cents / 100` |
| `Contractor Rush Bonus` | Currency | `jobs.contractor_rush_bonus_cents / 100` |
| `Contractor Total Payout` | Currency | `jobs.contractor_total_payout_cents / 100` |
| `Stripe Fee` | Currency | `jobs.stripe_fee_cents / 100` |
| `Rush Platform Share` | Currency | `jobs.rush_platform_share_cents / 100` |
| `Job Margin` | Currency | `jobs.job_margin_cents / 100` |

### Lifecycle Status Mapping (`Status` field — confirmed Airtable allowed values)

| Internal `job_status` | Airtable `Status` |
|---|---|
| `intake_received` | `pending_payment` |
| `intake_validated` | `pending_payment` |
| `quoted_outside_area` | `pending_payment` |
| `awaiting_payment` | `pending_payment` |
| `deposit_paid` | `paid` |
| `paid_in_full` | `paid` |
| `awaiting_remainder_payment` | `paid` |
| `ready_for_dispatch` | `dispatch_ready` |
| `dispatch_in_progress` | `dispatch_ready` |
| `assigned` | `assigned` |
| `scheduled` | `assigned` |
| `work_completed` | `completed` |
| `closed_paid` | `completed` |
| `cancelled` | `cancelled` |
| `error_review` | `pending_payment` |
| *(unrecognised — fallback)* | `pending_payment` |

### Area Classification Mapping (`Area Status` field — confirmed Airtable allowed values)

| Internal `service_area_status` | Airtable `Area Status` |
|---|---|
| `in_area` | `Inside Service Area` |
| `quote_only` | `Quote Only` |
| `blocked` | `Outside Service Area` |
| `inside_area` *(legacy)* | `Inside Service Area` |
| `outside_area` *(legacy)* | `Outside Service Area` |
| `unknown` *(legacy)* | `Quote Only` |
| *(unrecognised — fallback)* | `Quote Only` |

### Service Type Mapping (`Service Type` field)

| Internal code | Airtable `Service Type` |
|---|---|
| `small` | `Small Assembly` |
| `medium` | `Medium Assembly` |
| `large` | `Large Assembly` |
| `treadmill` | `Treadmill Assembly` |
| `custom` | `Custom Job` |
| *(unrecognised — fallback)* | `Custom Job` |

---

## 6. Internal Job Status Lifecycle

The `job_status` Postgres enum (16 values):

```
intake_received → intake_validated → awaiting_payment
                                   → quoted_outside_area  (quote_only area)
                                   → cancelled            (blocked area)
                                   → error_review         (pricing not found)
                                   → intake_validated     (custom job)

awaiting_payment → deposit_paid → awaiting_remainder_payment → paid_in_full
                → paid_in_full

paid_in_full / deposit_paid → ready_for_dispatch → dispatch_in_progress
                                                 → assigned → scheduled
                                                            → work_completed → closed_paid

Any state → cancelled
```

---

## 7. Jotform Field Mapping (`DEFAULT_JOTFORM_FIELD_MAPPING`)

Live mapping derived from real webhook payload (confirmed 2026-03-13):

| Canonical Field | Jotform Key | Notes |
|---|---|---|
| `firstName` | `q3_fullName.first` | Nested object; dot-notation |
| `lastName` | `q3_fullName.last` | Nested object; dot-notation |
| `email` | `q4_email` | Flat key |
| `phone` | `q79_phoneNumber79.full` | Nested; dot-notation |
| `phoneFallback` | `q5_phoneNumber.full` | Nested; dot-notation |
| `addressLine1` | `q6_streetNumberstreet.addr_line1` | Nested; dot-notation |
| `city` | `q26_typeA26` | **Flat key** — NOT `q18_city` |
| `state` | `q38_addresshttps...Fiel.state` | Long prepopulated address key |
| `postalCode` | `q38_addresshttps...Fiel.postal` | Long prepopulated address key |
| `serviceType` | `q7_serviceNeeded` | Flat key |
| `rushRequested` | `q48_typeA48` | Flat key |
| `appointmentDate` | `q9_preferredDate` | Flat key |
| `appointmentWindow` | `q11_preferredTime` | Flat key |
| `customDetails` | `q13_notesFor` | Flat key |
| `totalAmount` | `q58_totalamount` | Jotform-calculated |
| `amountChargedToday` | `q59_amountchargedtoday` | Jotform-calculated |
| `remainingBalance` | `q60_remainingbalance` | Jotform-calculated |
| `paymentType` | `q83_paymentType` | Flat key |
| `paymentMethodLabel` | `q43_typeA43` | Flat key |
| `stripeKey` | `q87_stripekey` | Flat key |
| `uniqueId` | `q20_uniqueId` | Flat key |
| `areaTag` | `q52_areaTag` | Flat key |

**Critical:** The `city` field key is `q26_typeA26` — not `q18_city`. Direct JSON test payloads must use `q26_typeA26` for city to be recognized.

**Critical:** Name fields (`q3_fullName`) must be sent as nested objects `{ first: "Jane", last: "Smith" }` — not as a flat string — for `customerName` to populate correctly.

---

## 8. Known Issues and Recent Fixes

### Fixed This Session

**Issue 1: Airtable 422 `INVALID_MULTIPLE_CHOICE_OPTIONS`**
- **Root cause:** `JOB_STATUS_MAP` contained compound labels (`'Quoted — Outside Area'`, `'Intake Received'`, `'Closed — Paid'`, etc.) that do not exist as options in the Airtable `Status` Single Select field. The confirmed Airtable `Status` allowed values are: `pending_payment | paid | dispatch_ready | assigned | in_progress | completed | cancelled`.
- **Fix:** Replaced entire `JOB_STATUS_MAP` with confirmed allowed values. Multiple internal lifecycle states now collapse to the correct coarser Airtable label.
- **Commit:** `8b096ef`

**Issue 2: `updateAirtableStatus` signature mismatch (Render build failure)**
- **Root cause:** `airtableSync.queue.ts` was calling `updateAirtableStatus()` with 4 arguments, but the version of `airtable.adapter.ts` on `origin/main` only declared 3 parameters. The local working copy had the 4-parameter signature but it was never committed.
- **Fix:** Committed the updated `airtable.adapter.ts` with the 4th optional parameter `stripePaymentIntentId?: string`.
- **Commit:** `8bda401`

**Issue 3: Stripe Checkout Session ID not written to Airtable**
- **Root cause:** No Airtable sync was enqueued after checkout session creation — the session ID existed in the DB but was never pushed to Airtable.
- **Fix:** Added `setImmediate(() => enqueueAirtableSync(...))` after both `create-checkout-session` and `create-remainder-payment` succeed in `jobs.routes.ts`.
- **Commit:** `628efe1`

**Issue 4: Stripe Payment Intent ID dropped on update path**
- **Root cause:** `airtableSync.queue.ts` fetched `stripe_intent_id` from the DB but passed only 3 arguments to `updateAirtableStatus()`, silently dropping the Payment Intent ID.
- **Fix:** Added `record.stripePaymentIntentId` as the 4th argument to `updateAirtableStatus()`.
- **Commit:** `628efe1`

### Open / Not Yet Fixed

**Blank `customerName` in direct JSON test payloads**
- **Root cause:** The normalizer expects `q3_fullName` as a nested object `{ first: "Jane", last: "Smith" }`. Sending `"q3_fullName": "Jane Smith"` as a flat string produces empty name fields.
- **Recommendation:** Use the correct nested shape in test payloads. No backend change needed — this is a test payload issue, not a production bug.

**Blank `city` in direct JSON test payloads**
- **Root cause:** The city mapping key is `q26_typeA26`, not `q18_city`. Sending `"q18_city": "Atlanta"` is ignored.
- **Recommendation:** Use `"q26_typeA26": "Atlanta"` in test payloads.

---

## 9. Backend Architecture Assumptions

| Assumption | Detail |
|---|---|
| PostgreSQL is source of truth | Airtable is a mirror only; sync failures never roll back DB transactions |
| Airtable sync is non-blocking | Failures are logged to `integration_failures` table and retried; they do not affect the intake 202 response |
| Stripe webhooks are idempotent | `payment_events.idempotency_key` enforces deduplication |
| Jotform sends `rawRequest` envelope | The intake handler unwraps `body.rawRequest` if present; otherwise uses body directly |
| City defaults to `quote_only` | Any city not in `service_areas` table returns `quote_only` (not `blocked`); only explicitly `blocked` cities return `blocked` |
| State defaults to `GA` | If address state is not provided, `GA` is assumed |
| Deposit is fixed $25 | Migration 003 set all non-custom deposits to $25 (not 50% of base) |
| Rush tiers: same-day (+$30) and next-day (+$20) | Contractor bonus: same-day +$20, next-day +$14 |
| Stripe fee is estimated at intake | `(total × 2.9%) + $0.30`; updated to actual after webhook |
| `jobs.airtable_record_id` drives create vs update | NULL → `syncJobToAirtable` (POST); non-null → `updateAirtableStatus` (PATCH) |
| `Job Status (Canonical Lifecycle)` field is NOT written | This Airtable field exists but the backend now writes only to `Status` (confirmed allowed values) |

---

*End of snapshot. To resume work in a new session, share this document and the repository URL.*
