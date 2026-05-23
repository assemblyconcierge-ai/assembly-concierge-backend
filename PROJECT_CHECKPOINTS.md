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

