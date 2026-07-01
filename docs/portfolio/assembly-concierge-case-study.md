# Assembly Concierge — Platform Case Study

## Overview

Assembly Concierge is a local service booking platform for furniture and fitness
equipment assembly in Hampton, McDonough, and Stockbridge, GA. The platform covers
the full customer journey: online booking, secure Stripe payment, photo intake, and
operator job tracking — built and validated incrementally with TypeScript, Vitest,
and production smoke tests at each milestone.
The platform is currently in pre-launch testing.

## Problem

The business needed a structured way to accept booking requests online, collect
payments before confirming jobs, gate contractor dispatch on payment and manual
review, and give operators a consolidated view of intake, payment, and photo status
— without exposing internal system details to customers.

## Architecture

**Frontend** — Next.js 16, React 19, Tailwind CSS v4, deployed on Vercel with a custom domain. Netlify DNS retained; A/CNAME records updated to Vercel; MX, TXT, and DKIM records preserved during migration.

**Backend** — Node.js, Express, TypeScript, PostgreSQL on Render. Stripe Checkout for payments. Cloudflare R2 private bucket for photo storage with presigned upload URLs. Airtable for operator job tracking.

**Booking flow** — 4-step stepper: service selection, contact and address, scheduling, and review/submit. Each step validates before advancing, with inline field-level error messages and scroll-to-focus behavior. The service selector covers flat-rate paths (Small, Medium, Large, Treadmill) and manual-review paths (Fitness Equipment, Custom). Phone normalization and fictional placeholder data prevent accidental real-number exposure during development.

**Contractor dispatch** — Outbound SMS via Quo (OpenPhone-compatible). Contractors receive and respond to jobs through SMS commands (CONFIRM, DECLINE, OTW, DONE) with no app required.

## Recent Work

**Operator photo review — CSP fix** — The operator photo review page
(`GET /public/photos/review/:operatorPhotoToken`) was generating valid R2 presigned
URLs but thumbnails rendered blank. Root cause: global `helmet()` sets
`img-src 'self'`, which blocks cross-origin R2 presigned URLs. An initial fix
scoped the override to the base R2 endpoint origin; a follow-up (commit `0ba353f`)
extended the allowlist to include the bucket-prefixed subdomain origin
(`<bucket>.<base-r2-endpoint>`), which is the form AWS SDK-generated presigned URLs
actually use. Both origins are now permitted in the scoped `img-src` override on the
review route, with `default-src 'none'` for everything else. Global Helmet policy is
unchanged. Validated: build and 212 Vitest tests pass; live CSP verified on
production; operator preview visually confirmed working. Future: a contractor-facing
photo link should reuse this same CSP pattern with a separate contractor-scoped
token — not the operator token.

**Frontend final-state polish** — Payment success and photo upload completion screens
were functional but did not clearly signal "done." Added "You're all set." subtitle,
"What happens next" detail block, and explicit "you can close this page" copy to
both screens. Removed a duplicate pair of identical `/book` CTAs on the photo
completion screen, replacing them with a single understated "Start a new booking"
link.

**Quote flow photo copy** — Updated the booking form's submit CTA for quote-type
jobs to "Submit Quote Request & Add Photos" and added a contextual hint below the
button explaining that photos help price custom jobs. Non-quote paths are unchanged.

**Contractor screening pipeline — end-to-end** — Built a token-based contractor acquisition and screening pipeline using Airtable automation, Make, Gmail, and Netlify. Unique screening tokens are generated per applicant and stored in Airtable. A Make scenario constructs a private prefilled screening link and delivers it via Gmail. The screening page (`join.assemblyconcierge.com/screening.html`) captures screening responses, flat-payout acceptance, and phone-screen readiness, then updates Airtable with screening status, notes, and queue flags on submission. Applicant lifecycle stages — screening sent, submitted, under review, phone-screen queue, onboarding, ready for backend — were validated end-to-end via smoke test. Contractor backend creation (PostgreSQL record, dispatch eligibility) is intentionally deferred from screening v1: screening collects readiness data only, and approved contractors advance to a Ready for Backend stage for controlled onboarding. Contractor photo upload is also excluded from screening v1 and remains a later onboarding/backend/R2 feature.

**Branding polish** — Favicon and app-icon assets added across both web surfaces: the contractor Netlify site (`join.assemblyconcierge.com`) and the customer Vercel frontend (commit `40de859`). The Vercel frontend metadata now covers 16×16, 32×32, apple-touch (180×180), and shortcut icons alongside a `site.webmanifest` with Assembly Concierge branding.

**Contractor screening — full-flow smoke test** — Validated the end-to-end contractor
application and screening pipeline against production data. Contractor application
records flow from Airtable through Make; a screening email scenario constructs a
tokenized screening link and delivers it via Gmail. A prefill scenario validates the
screening token and returns applicant data to the Netlify screening page
(`join.assemblyconcierge.com/screening.html`). A submission scenario writes screening
completion fields and review status back to Airtable on form submit. During smoke
testing, an initial repeated-token failure was traced to dirty, reused test data from
a previously completed screening record, not a backend regression. A fresh screening
record completed successfully and advanced through all lifecycle stages as expected.

**Contractor creation hardening — phone normalization and inactive-by-default** —
Hardened `POST /contractors` in two sequential commits. Commit `da56e53` (Manus)
introduced a `strictNormalizePhone` utility that accepts raw US phone strings in any
common format and rejects malformed input; the route now accepts `phoneE164`, `phone`,
or `phoneNumber` for Make/Airtable compatibility, returns `400 INVALID_PHONE` for
malformed numbers, and returns `409 PHONE_IN_USE` on duplicate detection. A
`CREATE UNIQUE INDEX` on `contractors(phone_e164)` (migration 016, embedded) enforces
uniqueness at the DB level. A fire-and-forget `contractor.created` audit event is
recorded on each successful creation. Commit `4ed35fc` applied the inactive-by-default
policy: `POST /contractors` now inserts `is_active = FALSE`; `GET /contractors` remains
active-only by default; `GET /contractors?includeInactive=true` returns both active and
inactive contractors. Migration `017_contractor_default_inactive` changes the
`contractors.is_active` column default from `TRUE` to `FALSE` at the DB level and is
embedded in the runtime migration array so it applies automatically on Render startup.
Render logs confirmed migration 017 applied on deploy. Production smoke tests confirmed
new contractors were created with `is_active = false` in Postgres; older contractors
remained active. The Airtable Contractors table mirrored the inactive state with
"Contractor Active" unchecked. Intended lifecycle: application submitted → screening
sent → screening completed → contractor created inactive → onboarding docs sent →
onboarding completed → owner/admin approval → contractor activated. Next: design
onboarding fields and the activation workflow.

**Contractor activation hardening** — Added `POST /contractors/:id/activate`, a
dedicated backend activation endpoint that validates onboarding and readiness
requirements before setting a contractor active. `PATCH /contractors/:id` remains
the raw admin maintenance path for field updates only — it does not run activation
logic. Contractors remain inactive until the activation endpoint succeeds. Dispatch
(`POST /jobs/:jobId/dispatch`) remains blocked for any contractor with
`is_active = false`, ensuring no unvetted contractor can receive a job dispatch.

**DONE/FINISH SMS acknowledgement** — Contractor `DONE` and `FINISH` commands now
trigger a safe acknowledgement reply confirming receipt of the completion signal.
The message contains no payout promise and no implication of automatic job closeout.
Operator review via `approve-completion` is still required before the job advances.

**Completion photo upload and approval guard** — Added migration 018 introducing
`uploaded_media.photo_type` (`intake` / `completion`) to separate customer intake
photos from contractor completion evidence at the database level. Added
`contractor_assignments.contractor_completion_token`, a single-use upload credential
generated at `DONE`/`FINISH` time. Added a contractor-facing completion upload page
(`GET /public/contractor/completion/:completionToken`) and supporting presign and
confirm routes (`POST /public/contractor/completion/:completionToken/presign`,
`POST /public/contractor/completion/:completionToken/confirm`). When a contractor
texts `DONE` or `FINISH`, the backend generates the token and texts the upload link;
the contractor uploads photos through the browser with no app required.
`POST /jobs/:jobId/approve-completion` now requires at least one confirmed completion
photo before advancing the job; requests without photos receive error code
`COMPLETION_PHOTOS_REQUIRED`. Operators can supply an `adminOverrideReason` to
advance without photos for exceptional cases such as practice jobs or legacy records.
Patch 2B production verification confirmed: (1) `approve-completion` without photos
returned `COMPLETION_PHOTOS_REQUIRED`; (2) `approve-completion` with
`adminOverrideReason` succeeded; (3) practice job AC-2026-97ND advanced to
`awaiting_remainder_payment`.

**Security note / future hardening** — Admin credential rotation is pending after
Patch 2B testing. The current `requireAdmin` middleware compares the incoming
`Authorization: Bearer` or `X-Admin-Token` value directly against
`ADMIN_JWT_SECRET` — a raw shared secret, not real JWT verification despite the
variable name. Future hardening opportunities: replace the shared secret with signed
JWTs or scoped per-scenario API keys; add `x-admin-token` to the pino logger redact
list (`req.headers.authorization` is currently redacted but `x-admin-token` is not).

**Validation** — TypeScript: `tsc --noEmit` clean. Backend: 320 automated tests
across 20 Vitest test files (unit + integration), all passing. Frontend: Next.js
production build and ESLint clean at each merge.
