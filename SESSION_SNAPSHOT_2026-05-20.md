# Session Snapshot — 2026-05-20

**Repo:** assembly-concierge-backend  
**Previous snapshot:** SESSION_SNAPSHOT_2026-04-13.md @ `d4b116e`  
**Current commit:** `c5c0fab` — fix(intake): align payment mode and Airtable mirror fields

---

## What Was Fixed

**Original issue (AC-2026-O2M4)**
- `paymentType` was `deposit`, but `jobs.payment_mode` was written as `full`
- `payments.payment_type` and `amount_due_cents` were correct (deposit / 2500)
- Airtable: Backend Job Status blank, Reconciliation Reason showed "Backend mirror not populated"

**Backend fixes**
- `src/modules/intake/intake.service.ts` — derives `checkoutType` once and uses it for `jobs.payment_mode` when `initialStatus` is `awaiting_payment`
- `src/modules/airtable-sync/airtable.adapter.ts` — writes Backend Job Status, Backend Updated At, Last Backend Sync At, and Backend Sync Error during initial Airtable record creation

**Airtable formula fix**
- Expected Backend Job Status formula updated to map `partial_or_in_progress` or `payment_pending` → `awaiting_payment`
- After update: Backend Status Match = Match, Needs Reconciliation blank, Reconciliation Reason blank

---

## Validation

### Local
- `npm run build` passed
- `npm test` passed — 155 tests

### Production
- Render deployed `c5c0fab`
- Health check: `status ok`, `version 2.0.0`, `production`

### API validation (AC-2026-ERHA)
| Check | Result |
|---|---|
| POST /public/bookings | `awaiting_payment`, `in_area`, `totalAmountCents` 10900, `checkoutRequired` true |
| GET /jobs/pay/:token | `paymentMode` deposit, `depositAmountCents` 2500, `remainderAmountCents` 8400, `checkoutUrl` returned |
| Stripe checkout | Not opened or completed |

### Database (AC-2026-ERHA)
| Field | Value |
|---|---|
| source_channel | web |
| status | awaiting_payment |
| service_area_status | in_area |
| payment_mode | deposit |
| total_amount_cents | 10900 |
| deposit_amount_cents | 2500 |
| payments.payment_type | deposit |
| payments.amount_due_cents | 2500 |
| payments.status | checkout_created |

### Airtable (AC-2026-ERHA)
| Field | Value |
|---|---|
| Backend Job Status | awaiting_payment |
| Backend Updated At | populated |
| Last Backend Sync At | populated |
| Backend Sync Error | blank |
| Status | pending_payment |
| Deposit Status | checkout_created |
| Dispatch Status | Pending Dispatch |
| Backend Job ID | populated |
| Manual Sync from Backend | worked |

---

## Flows Validated This Session

- POST /public/bookings
- GET /jobs/pay/:token
- Backend job creation
- Stripe checkout handoff
- Airtable parent record sync
- Airtable Payments child-table sync
- Manual Airtable Sync from Backend

---

## Current Adapter Status

- Backend-complete for fixed-price v1 intake
- Supported services: small, medium, large, treadmill
- **Not in v1 scope:** custom quote-only jobs, fitness_equipment quote-only flow, photo upload, frontend form, success/payment pages, completed Stripe lifecycle

---

## Test Records

| Record | Note |
|---|---|
| AC-2026-O2M4 | Original issue record |
| AC-2026-ERHA | Post-patch validation record |

**Do not dispatch either record.**

---

## Outstanding Before Launch

- Secret rotation: DATABASE_URL, ADMIN_JWT_SECRET, Stripe secret keys, Airtable API key, Render env values, full public payment tokens must not be exposed and rotation remains an open task
