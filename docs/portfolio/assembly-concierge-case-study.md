# Assembly Concierge - Platform Case Study

## Overview

Assembly Concierge is a local service operations platform for furniture and
fitness equipment assembly. The system covers the full lifecycle from customer
booking and payment through contractor dispatch, completion review, remainder
billing, and operator monitoring.

The platform is in launch-hardening. Core workflows are implemented and the
backend is deployed on Render, while external operational configuration in Make,
Airtable, Jotform, and Stripe requires separate verification from repository code.
This case study distinguishes implemented code, automated-test evidence,
production smoke tests, deployed behavior, and remaining launch-validation work.

## Problem

The business needed more than a booking form. It needed a controlled operational
system that could:

- Accept customer requests online and route fixed-price versus manual-review jobs.
- Collect payment before dispatch eligibility.
- Keep Airtable useful for operators without making Airtable the source of truth.
- Coordinate contractors without requiring a contractor app.
- Prevent unvetted contractors from receiving dispatches.
- Provide auditable admin actions, retryable integrations, and visible failure
  states before launch.
- Prevent repeated operator actions from creating duplicate dispatch or assignment
  records.

## Architecture

**Frontend** - A public booking experience for customer intake, payment
redirects, and photo collection, with separate contractor-facing pages for
screening and completion-photo uploads.

**Backend** - Node.js, Express, TypeScript, and PostgreSQL deployed on Render.
PostgreSQL is the source of truth for jobs, payments, contractors, dispatches,
assignments, email events, audit events, and integration failures.

**Payments** - Stripe Checkout handles upfront payment and remainder-payment
links. Webhooks update payment and job state after successful checkout.

**Storage** - Private object storage is used for customer intake photos and
contractor completion photos through presigned upload flows.

**Operator interface** - Airtable is the operator dashboard and mirror of backend
state. Operators make high-level decisions in Airtable, but backend state
transitions remain authoritative.

**Automation layer** - Make orchestrates Airtable-triggered workflows. Make
scenarios fetch Airtable records, call admin-protected backend endpoints, update
operator-facing result fields, and route failures into visible recovery paths.

**Messaging** - Quo/OpenPhone-compatible SMS supports contractor dispatch
commands such as confirm, decline, on-the-way, and done. Email flows cover
contractor onboarding, document corrections, onboarding acceptance, and final
activation.

## Customer Booking and Interface Hardening

The booking interface received targeted launch-polish changes rather than a
redesign. Address examples were restyled so placeholder text no longer appeared
to be customer-entered data. Quote-selection cards were corrected so only the
currently selected option remains highlighted instead of leaving prior choices
visually active.

Customer photo collection is capped at 12 files. Related copy, selectors, and form
presentation were adjusted while preserving the existing booking, pricing,
validation, upload, payment, API, and submission behavior.

The backend also rejects passed same-day appointment windows so customers cannot
submit a booking for a time window that has already elapsed.

## Contractor Operations Lifecycle

### Screening and controlled backend creation

Contractor acquisition starts outside the dispatch system. Applicants move
through a controlled screening workflow before they can advance to onboarding or
backend contractor creation.

The production screening flow uses contractor-specific one-time links. Each link
contains a generated token with an expiration timestamp. The public screening
page remains hidden until a prefill request explicitly confirms that the token is
valid and available. Malformed, expired, consumed, or otherwise unavailable
links receive a controlled unavailable state rather than applicant data.

A successful screening submission updates the matching Airtable application,
records the completed timestamp and screening responses, then clears both the
token and its expiration value. Reopening the same link is rejected, which
prevents ordinary replay after completion. The deployed flow was smoke-tested in
production across valid prefill, invalid-link handling, successful submission,
token consumption, and replay rejection.

During launch hardening, a Make configuration conflict was found between
sequential processing and synchronous webhook responses. The submission scenario
was corrected to execute immediately without sequential mode so the browser can
receive the intended structured success response. The remaining narrow
architectural limitation is that Airtable and Make do not provide the same atomic
single-use guarantee as a database transaction for truly simultaneous requests.
Moving screening-token validation and atomic consumption into the backend is a
planned hardening improvement, not a current launch blocker.

Approved applicants are advanced to a controlled backend creation step. New
backend contractor records are inactive by default, so screening completion alone
does not grant dispatch eligibility.

### Onboarding email flow

After a contractor record exists, an operator-triggered workflow sends a
contractor onboarding email. The email links the contractor to the onboarding
form through a contractor-specific prefilled onboarding link. The link contains
contractor-specific identifiers and should not be logged or broadly shared; it is
not described as cryptographically private or single-use. Sending the email does
not activate the contractor.

### Resubmission and missing-documents recovery

Onboarding resubmissions preserve prior progress. The backend aggregates earlier
submission state before computing the current checklist, so a previously received
agreement, tax form, identification document, or insurance document is not reset
to missing merely because a later correction submission omits it.

After a successful Airtable update, the prior missing-documents email reservation
is cleared so another standard follow-up can be sent if the revised submission is
still incomplete. The current implementation accepts loss of the deleted email
reservation as a launch tradeoff; a future history redesign can preserve multiple
correction cycles without reusing the same reservation record.

### Onboarding accepted and contractor activation

Once onboarding materials are reviewed and accepted, the operator can send an
onboarding accepted email. This confirms document acceptance only; it is separate
from final contractor activation and dispatch eligibility.

Activation is handled by a dedicated admin-protected backend flow. It verifies
readiness requirements before setting a contractor active. Normal operational
activation uses the guarded activation endpoint, and dispatch independently
rejects inactive contractors.

After activation, the operator can send an activated-contractor email. The backend
guards this flow so the email can only be sent to an active contractor with an
email address on file. The send is recorded through the email-event system, repeat
requests return an already-handled response, and an intentional force-resend path
is available for operator recovery.

## Contractor Onboarding Document Security

Contractor onboarding submissions arrive through Jotform. The backend stores the
signed agreement, W-9, photo ID, insurance document, and generated submission
summary in Google Drive. PostgreSQL tracks canonical onboarding and document
status, while Airtable mirrors document status for operator review.

Jotform document downloads are restricted to the exact approved Jotform hosts.
Downloads must use HTTPS on the default HTTPS port. Every redirect target is
revalidated, and downloads are limited by redirect count, total timeout, and file
size. Safe download errors avoid exposing authenticated URLs or credential values.

Before Google Drive upload, the backend derives the filename extension from the
validated MIME type and verifies matching PDF, PNG, or JPEG magic bytes.
Unsupported MIME types and MIME/signature mismatches are rejected before any Drive
upload. Submission summaries were also expanded to retain relevant onboarding
responses in the generated Drive record.

The onboarding webhook token was rotated without documenting its value, and the
Quo webhook uses request-signature verification. A production contractor
onboarding smoke test succeeded, and a separate negative SSRF test also succeeded.
No token values, personal data, file identifiers, folder identifiers, or signed
URLs are recorded here.

A dormant Jotform intake route that was not part of the active production flow was
disabled in production to reduce unnecessary attack surface.

## Make, Airtable, and Backend Orchestration

The integration is designed around clear ownership:

- PostgreSQL owns canonical state.
- Airtable presents operator workflow fields and mirrors backend outcomes.
- Make routes Airtable-triggered decisions into backend calls and writes
  operator-visible success or failure results.
- The backend validates state transitions, writes audit events, sends messages,
  and queues Airtable syncs after successful transactions.

Backend capabilities intended for Make orchestration include contractor lifecycle
emails, guarded activation, availability prechecks, dispatch approval, dispatch,
cancel assignment, cancel job, completion approval, payment recovery, and
integration retry flows.

Recent Make hardening corrected six operator scenarios:

- Completion Approval: corrected override-field mappings and module routing.
- Manual Sync: added an explicit visible failure route.
- Cancel Job: distinguishes the exact committed-pending checkout-expiry marker
  from generic errors.
- Dispatch Trigger: supports legitimate redispatch after inactive history, clears
  stale fields, and suppresses only the exact duplicate-dispatch marker.
- Owner Alert: includes the event type in the alert body while retaining customer
  email; broader alert expansion remains parked.
- Cancel Assignment: removed an incorrect backend-sync timestamp write.

These Make changes were structurally reviewed and saved. They are not represented
as fully production smoke-tested unless a separate run was documented.

Airtable operator work also included current-assignment mirroring, isolated V2
assignment sync behavior, availability result fields, completion override fields,
scheduled start and end timestamps, cancellation and re-dispatch reset behavior,
and operator-focused dashboard pages. Historical completed and cancelled views are
treated as read-only, while payment closeout remains intentionally controlled.

The protected Make credential and Render credential are managed separately from
this repository. No credential values are stored in this documentation.

## Dispatch Flow and Duplicate Protection

Dispatch begins only after payment and operator approval gates are satisfied. The
operator selects a contractor in Airtable, Make checks backend readiness and
availability, and the backend performs the state transition that creates the
dispatch and assignment records.

Contractors respond through SMS. A confirm response assigns the job. A decline
returns the job to a dispatchable state for re-routing. An on-the-way response
records an en-route timestamp and can notify the customer. A done or finish
response marks completion as reported and opens the contractor completion-photo
path.

Launch hardening added transactional duplicate-dispatch protection. The backend
locks the job row before evaluating dispatch eligibility, checks for an active
dispatch or active assignment while holding that lock, and uses a consistent lock
order across the job, contractor, and child records. A committed winner causes a
second attempt to return a marker-specific HTTP 409 response without creating a
second dispatch or assignment. Generic conflicts remain distinguishable from a
true duplicate.

Legitimate redispatch remains allowed when only cancelled or otherwise inactive
historical assignments exist. SMS delivery remains outside the database
transaction and occurs only after the dispatch state commits.

This patch passed the TypeScript build, 24 focused dispatch tests, and the full
748-test backend suite. It was merged into `main` and deployed on Render. Real
PostgreSQL concurrency execution remains a separate launch-validation gate.

## Completion Photos, Approval, and Remainder Payment

Contractor completion-photo uploads were hardened with upload-count and validation
limits before operator approval. Completion is not automatic when a contractor
texts that the job is done. The operator reviews the completion signal and photos.
An authorized admin may proceed without the normal photo requirement only by
supplying an override reason.

Completion approval now persists audit metadata for whether an override was used,
the reason, the approving operator, and the approval timestamp. Airtable mirrors
those fields for operator review.

After approval, the backend chooses the correct financial path:

- If the job is fully paid, it closes the job as paid and complete.
- If a remainder is owed, it moves the job into a remainder-payment state and
  initiates Stripe remainder-checkout creation asynchronously.
- When the remainder payment succeeds, the Stripe webhook closes the job as paid.

Remainder-checkout failures are logged for recovery or manual retry. Because link
creation is asynchronous, the job can temporarily be awaiting remainder payment
before a payment link exists. This keeps contractor completion, operator approval,
customer billing, and final job closure as separate, auditable steps.

## Security Hardening

Recent backend hardening includes:

- stricter webhook and admin-route protections;
- Quo request-signature verification;
- disabled dormant production intake routes;
- passed same-day booking-window rejection;
- exact-host, HTTPS, redirect, timeout, and size controls for contractor files;
- MIME-derived filenames and magic-byte validation;
- inactive-by-default contractor creation and guarded activation;
- private object storage with scoped presigned upload and review flows;
- transaction-bound duplicate-dispatch prevention;
- safer distinction between committed duplicate outcomes and unrelated conflicts;
- observable audit, email, integration-failure, and retry records.

## Alerting and Failure Monitoring

The backend contains recoverable side-effect patterns for Airtable syncs, selected
email and SMS sends, and payment-link creation. These paths log or record failures
so canonical state changes are not silently discarded.

Failure-monitoring patterns include:

- `integration_failures` records for failed asynchronous work;
- retry paths for recoverable Airtable or backend-side failures;
- operator-visible success and error summaries written through Make;
- a confirmed webhook alert path for final Airtable synchronization failure after
  retries are exhausted;
- audit events for important admin actions such as contractor activation,
  lifecycle-email sends, dispatch decisions, cancellation, and completion
  approval.

Broader alert coverage, durable payment-webhook processing, and some downstream
recovery paths remain launch-hardening concerns rather than completed claims.

## Validation Status

The project uses TypeScript checks, Vitest unit and integration tests, focused
backend reviews, production smoke tests, and external Make/Airtable inspection.

Current evidence:

- 748 automated backend tests passed.
- TypeScript build passed for the latest dispatch hardening patch.
- Contractor screening passed a production smoke test covering valid prefill,
  successful submission, token consumption, and replay rejection.
- Contractor onboarding passed a production smoke test, including document
  handling, and a separate negative SSRF test.
- The transactional duplicate-dispatch patch was merged and deployed live.
- Six Make operator scenarios were corrected and structurally reviewed; full
  scenario execution is not claimed here without separate run evidence.

Still pending or separately tracked:

- real PostgreSQL concurrency execution for the duplicate-dispatch race;
- narrow production smoke testing of duplicate-dispatch behavior after deployment;
- durable recovery for selected payment and downstream synchronization failures;
- broader owner-alert coverage;
- final validation of all external Make, Airtable, Stripe, and Render settings;
- completion-override persistence and audit behavior under production use;
- contractor cancellation compensation and expanded-scope payment workflows.

## Engineering Takeaways

- Airtable is effective as an operator interface, but PostgreSQL must own
  canonical lifecycle state.
- Make is useful for orchestration and operator-friendly routing, but backend
  endpoints must own validation, idempotency, and side effects.
- Contractor screening links should expire, become unusable after submission,
  and fail closed when validation is unavailable.
- Synchronous webhook responses and queueing settings must be evaluated together.
- Contractor activation needs a dedicated lifecycle, not a profile-edit shortcut.
- Email, SMS, payment creation, and Airtable sync should be observable and
  recoverable side effects rather than hidden dependencies inside primary
  transactions.
- Concurrency protections should be enforced where canonical state is written,
  not inferred from operator-interface state.
- Launch readiness is a workflow discipline: rotate credentials, smoke-test the
  complete operator path, verify monitoring, and avoid documenting secrets.
