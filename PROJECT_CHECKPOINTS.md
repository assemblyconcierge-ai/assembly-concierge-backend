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