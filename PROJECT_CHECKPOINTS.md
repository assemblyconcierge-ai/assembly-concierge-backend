\## 2026-05-23 — Public Booking Hardening Deployed



Commit: d6db9e6  

Message: fix(public-booking): harden scheduled fixed-price intake  

Deploy: Live on Render  

Health check: /health returned status ok, version 2.0.0, production



Completed:

\- Public fixed-price booking is now scheduler-first.

\- appointmentDate is required.

\- Invalid, impossible, and past dates are rejected before persistence.

\- Same-day public booking is disabled by default.

\- Capacity is now unit-based instead of flat booking count.

\- Default capacity = 2 fallback contractors × 2 units = 4 units per city/date/window.

\- Service units:

&#x20; - small = 1

&#x20; - medium = 1

&#x20; - large = 2

&#x20; - treadmill = 2

\- Full/overbooked slots return recoverable/manualReviewAvailable instead of dead-ending the frontend.

\- fitness\_equipment is protected from zero-dollar checkout by routing through review-only behavior in core intake.

\- GET /jobs/pay/:token remains safe when checkoutUrl is temporarily null.



Validation:

\- Targeted tests passed: 3 files, 20 tests.

\- TypeScript build passed.

\- Render deployed d6db9e6 successfully.

\- Production /health check returned ok.



Important remaining issue:

\- Full-slot manual review is only signaled to the frontend right now.

\- No review request is persisted yet when the customer chooses “request this window anyway.”



Next backend task:

\- Build POST /public/review-requests for:

&#x20; - custom jobs

&#x20; - fitness\_equipment

&#x20; - full-slot manual review requests

&#x20; - uncertain/out-of-category requests

\- It should create a visible review record, sync to Airtable/backend ops, create no Stripe checkout, and create no dispatch eligibility.



Do not start frontend contract until the review-request path is designed.



## 2026-05-23 - Manual Review Request Endpoint Deployed

Commit: 8a277a7

Message: feat(public-booking): add manual review request endpoint

Deploy: Live on Render

Completed:
- Added POST /public/review-requests.
- Reused jobs + intake_submissions.
- Used processIntake(..., { sourceChannel: 'web', forceReviewOnly: true }).
- Kept sourceChannel as web.
- Set source.formName to web-review-request.
- Added no new table, migration, or job status.
- Supported review reasons: custom_job, fitness_equipment, slot_full_manual_review, other_uncertain.
- Returned only requestId, status, message, and correlationId.
- Did not return publicPayToken, checkoutUrl, paymentToken, jobId, pricing fields, or Stripe fields.
- forceReviewOnly skips calculatePricing before pricing logic and prevents checkout creation.
- service_type_id is preserved before the pricing skip.
- In-area review jobs become intake_validated, custom_review, and zero-dollar.
- Outside-area behavior preserves existing quoted_outside_area behavior.

Production validation:
- Render deployed 8a277a7.
- POST /public/review-requests returned HTTP 201.
- Test job: AC-2026-BFYE.
- Response contained no forbidden payment/internal fields.
- Airtable received the record.
- Airtable record showed review reason in customer notes.
- Airtable expected-status formula was updated so intake_validated zero-dollar manual review jobs match instead of showing reconciliation mismatch.

Tests/build:
- npm.cmd test -- tests/modules/public-booking/publicBooking.routes.test.ts tests/unit/intakeQuoteOnly.test.ts
- Result: 2 files passed, 27 tests passed.
- npm.cmd run build passed.

Remaining notes:
- DB/payment-row absence was not directly verified from Codex environment.
- Airtable mirror and zero-dollar/non-dispatch-eligible behavior were verified through the record.
- Public booking frontend contract still needs to handle checkoutUrl null polling for fixed-price bookings.
- No frontend work started yet.

## 2026-05-28 — Frontend Scheduler Deployed

Commits: 4231720 (backend), d5283b4 (backend), c1dc86f (frontend)

Frontend repo: https://github.com/assemblyconcierge-ai/assembly-concierge-frontend

Completed:
- Next.js 16 frontend built and deployed to Vercel.
- /book: 4-step scheduler stepper (service → contact/address → scheduling → review/submit).
- /book/waiting: polls GET /jobs/pay/:publicPayToken until checkoutUrl is ready, then redirects to Stripe.
- Fixed-price path (Small/Medium/Large/Treadmill) reaches Stripe Checkout.
- Quote/manual-review path (Fitness Equipment/Custom) shows inline confirmation card after POST /public/review-requests.
- CORS fix: CORS_ALLOWED_ORIGINS env var added to backend; frontend preflight requests unblocked.
- Airtable fix: intake_validated maps to manual_review (was pending_payment) for quote/review records.
- Quote details validation: blank submit focuses textarea and shows inline error message; does not reach API.

Validation:
- Backend: npm run build passed. npm test passed — 14 files, 183 tests.
- Frontend: npm run build passed.
- CORS OPTIONS preflight to both /public/review-requests and /public/bookings returned 204 with correct Access-Control-Allow-Origin header.

---

## 2026-05-29 — Phase 18: Customer Photo Upload and Frontend Booking Polish

Backend photo intake:
- Added public photo upload endpoints:
  - POST /public/photos/presign
  - POST /public/photos/confirm
- Presign flow issues scoped upload URLs for private Cloudflare R2 storage.
- Confirm flow records uploaded media confirmation state in the backend.
- Cloudflare R2 bucket remains private.
- R2 CORS configured for the Vercel frontend origin.
- Migration 013 added confirmed_at support for uploaded_media through the embedded migration path.
- Production smoke test passed: review request → public token → presign → R2 PUT → confirm → confirmedAt returned.

Frontend booking/photo intake:
- Added /book/photos?token=... customer photo upload page.
- Added post-submission photo upload CTA.
- Added customer-facing reference/job key display in booking and photo flows.
- Improved photo upload completion messaging.
- Added field-level inline validation errors across the booking form.
- Added scroll/focus behavior for invalid backend validation fields.
- Replaced raw schema/backend validation copy with customer-friendly messages.
- Added phone normalization.
- Replaced realistic phone placeholder with fictional placeholder: (555) 010-1234.
- Added per-step frontend validation before customers can advance.
- Required service, contact/address fields, preferred date/window, state, and ZIP before advancing.
- Added valid/future date validation for preferred appointment date.
- Made step indicator actionable for current/prior steps only.

Production validation:
- Frontend changes passed build and lint before merge.
- PR #6 merged: step-level validation and actionable step navigation.
- PR #7 merged: required State and ZIP validation.
- Vercel production deploy completed and was smoke-tested.
- Merged feature branches were deleted after merge.

Not yet complete:
- Airtable photo visibility / photo review fields
- Operator photo review links
- Backend-triggered customer/operator/contractor emails
- Secure contractor job packet/photo access
- Public business launch claims should remain avoided until launch is confirmed
- Smoke test records: AC-2026-THI0, AC-2026-UOQC (manual_review / intake_validated ✓), AC-2026-UDF8 (awaiting_payment / checkout reached ✓).

Known remaining:
- Root "/" shows default Next.js starter page; /book is the scheduler entry point.
- No custom domain connected yet.
- Stripe payment was not completed in smoke test (intentional).
- Older manual-review records may show pending_payment until their next Airtable sync event.

## 2026-05-29 — Phase 18: Customer Photo Upload and Frontend Booking Polish

Backend photo intake:
- Added public photo upload endpoints:
  - POST /public/photos/presign
  - POST /public/photos/confirm
- Presign flow issues scoped upload URLs for private Cloudflare R2 storage.
- Confirm flow records uploaded media confirmation state in the backend.
- Cloudflare R2 bucket remains private.
- R2 CORS configured for the Vercel frontend origin.
- Migration 013 added confirmed_at support for uploaded_media through the embedded migration path.
- Production smoke test passed: review request → public token → presign → R2 PUT → confirm → confirmedAt returned.

Frontend booking/photo intake:
- Added /book/photos?token=... customer photo upload page.
- Added post-submission photo upload CTA.
- Added customer-facing reference/job key display in booking and photo flows.
- Improved photo upload completion messaging.
- Added field-level inline validation errors across the booking form.
- Added scroll/focus behavior for invalid backend validation fields.
- Replaced raw schema/backend validation copy with customer-friendly messages.
- Added phone normalization.
- Replaced realistic phone placeholder with fictional placeholder: (555) 010-1234.
- Added per-step frontend validation before customers can advance.
- Required service, contact/address fields, preferred date/window, state, and ZIP before advancing.
- Added valid/future date validation for preferred appointment date.
- Made step indicator actionable for current/prior steps only.

Production validation:
- Frontend changes passed build and lint before merge.
- PR #6 merged: step-level validation and actionable step navigation.
- PR #7 merged: required State and ZIP validation.
- Vercel production deploy completed and was smoke-tested.
- Merged feature branches were deleted after merge.

Not yet complete:
- Airtable photo visibility / photo review fields
- Operator photo review links
- Backend-triggered customer/operator/contractor emails
- Secure contractor job packet/photo access
- Public business launch claims should remain avoided until launch is confirmed
