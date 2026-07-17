# Assembly Concierge - Platform Case Study

## Overview

Assembly Concierge is a local service operations platform for furniture and
fitness equipment assembly. The system covers the full lifecycle from customer
booking and payment through contractor dispatch, completion review, remainder
billing, and operator monitoring.

The platform is in launch-hardening: the core workflows are implemented, while
deployment-specific automation and credential state require separate operational
verification. Operational configuration outside this repository must be verified
in Make and Render.

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

## Contractor Operations Lifecycle

### Screening and controlled backend creation

Contractor acquisition starts outside the dispatch system. Applicants move
through a screening workflow, and approved applicants are advanced to a controlled
backend creation step. New backend contractor records are inactive by default so
screening completion alone does not grant dispatch eligibility.

### Onboarding email flow

After a contractor record exists, an operator-triggered workflow sends a
contractor onboarding email. The email links the contractor to the onboarding
form through a contractor-specific prefilled onboarding link. The link contains
contractor-specific identifiers and should not be logged or broadly shared; it is
not described as cryptographically private or single-use. Sending the email does
not activate the contractor.

### Missing-docs email flow

If submitted onboarding materials are incomplete or need correction, the operator
can trigger a missing-docs email. The backend records the email event, supports
idempotent repeat handling, and allows an intentional resend when needed. This
keeps correction requests trackable without changing contractor activation state.

### Onboarding accepted email flow

Once onboarding materials are reviewed and accepted, the operator can send an
onboarding accepted email. This confirms document acceptance only; it is still
separate from final contractor activation and dispatch eligibility.

### Contractor activation flow

Activation is handled by a dedicated admin-protected backend flow. It verifies
readiness requirements before setting a contractor active. The guarded operational
workflow is `POST /contractors/:id/activate`. The admin maintenance route
`PATCH /contractors/:id` can directly update `isActive`, so normal operational
activation should use the guarded activation endpoint. Dispatch independently
rejects inactive contractors.

### Activated-contractor email flow

After activation, the operator can send an activated-contractor email. The backend
guards this flow so the email can only be sent to an active contractor with an
email address on file. The send is recorded through the email-event system, repeat
requests return an already-handled response, and an intentional force-resend path
is available for operator recovery.

## Contractor Onboarding Document Security

Contractor onboarding submissions arrive through Jotform. The backend stores the
signed agreement, W-9, photo ID, insurance document, and generated submission
summary in Google Drive. PostgreSQL tracks canonical onboarding and document
status, while Airtable mirrors document status for operator review. Newly created
contractors remain inactive by default and should advance through the guarded
activation workflow before becoming dispatch-eligible.

Jotform document downloads are restricted to the exact approved hosts
`jotform.com`, `www.jotform.com`, and `files.jotform.com`. Downloads must use HTTPS
on the default HTTPS port. Every redirect target is revalidated, and downloads are
limited to three redirects, a 15-second total timeout, and 10 MiB. Safe download
errors avoid exposing authenticated URLs or credential values.

Before Google Drive upload, the backend derives the filename extension from the
validated MIME type: PDF files use `.pdf`, PNG files use `.png`, and JPEG files use
`.jpg`. It also verifies the corresponding PDF, PNG, or JPEG magic bytes.
Unsupported MIME types and MIME/signature mismatches are rejected before any Drive
upload.

The onboarding webhook token was rotated without documenting its value, and the
Quo webhook uses request-signature verification. A production contractor
onboarding smoke test succeeded, and a separate negative SSRF test also succeeded.
No token values, personal data, file identifiers, folder identifiers, or signed
URLs are recorded here.

## Make, Airtable, and Backend Orchestration

The integration is designed around clear ownership:

- PostgreSQL owns canonical state.
- Airtable presents operator workflow fields and mirrors backend outcomes.
- Make routes Airtable-triggered decisions into backend calls and writes
  operator-visible success or failure results.
- The backend validates state transitions, writes audit events, sends messages,
  and queues Airtable syncs after successful transactions.

Backend capabilities intended for Make orchestration include:

- Contractor onboarding email trigger.
- Missing-docs email trigger.
- Onboarding accepted email trigger.
- Contractor activation request.
- Activated-contractor email trigger.
- Contractor availability precheck.
- Dispatch approval and dispatch routing.
- Cancel assignment and re-dispatch routing.
- Cancel job with double-confirmation.
- Completion approval and remainder-payment handling.
- Recovery or retry flows for failed integration work.

The intended Make-side variable name is `AC_ADMIN_JWT_SECRET`; the backend reads
its protected-admin credential from `ADMIN_JWT_SECRET`. This repository does not
verify deployed Make variable configuration, deployed Render credential state, or
credential-rotation status. Operational configuration outside this repository must
be verified in Make and Render. No credential values are stored in this
documentation.

## Admin-Protected Backend Capabilities

Admin-protected backend routes are described in portfolio-safe categories rather
than as secret-bearing operational instructions:

- Contractor management: create inactive contractors, update profile fields,
  activate contractors, and trigger contractor lifecycle emails.
- Job workflow control: approve dispatch, dispatch to a contractor, cancel an
  assignment, cancel a job, and approve completion.
- Payment recovery: create or recover payment links for eligible jobs.
- Integration recovery: inspect failed integration work and retry safe recovery
  actions.
- Configuration and operator support: read or update operational settings needed
  for pricing, service areas, or launch validation.

These routes are intended for Make scenarios and operator/admin use only. They
are not customer-facing APIs.

## Dispatch Flow

Dispatch begins only after payment and operator approval gates are satisfied. The
operator selects a contractor in Airtable, Make checks backend readiness and
availability, and the backend performs the state transition that creates the
dispatch and assignment records.

Contractors respond through SMS. A confirm response assigns the job. A decline
returns the job to a dispatchable state for re-routing. An on-the-way response
records an en-route timestamp and can notify the customer. A done or finish
response marks completion as reported and opens the contractor completion-photo
path.

The backend enforces important launch guards: inactive contractors cannot receive
dispatches, schedule conflicts are checked before dispatch, and state transitions
are validated in the backend rather than trusted from Airtable fields alone.

## Completion Approval and Remainder Payment

Completion is not automatic when a contractor texts that the job is done. The
operator reviews the job and completion signal. Completion photos are normally
required before approval, but an authorized admin may proceed without them by
supplying an `adminOverrideReason`.

After approval, the backend chooses the correct financial path:

- If the job is fully paid, it closes the job as paid and complete.
- If a remainder is owed, it moves the job into a remainder-payment state and
  initiates Stripe remainder-checkout creation asynchronously.
- When the remainder payment succeeds, the Stripe webhook closes the job as paid.

Remainder-checkout failures are logged for recovery or manual retry. Because link
creation is asynchronous, the job can temporarily be in
`awaiting_remainder_payment` before a payment link exists. This keeps contractor
completion, operator approval, customer billing, and final job closure as separate,
auditable steps while making the temporary state/link divergence explicit.

## Alerting and Failure Monitoring

The backend contains recoverable side-effect patterns for Airtable syncs, selected
email and SMS sends, and payment-link creation. These paths log or record failures
so canonical state changes are not silently discarded. Make-operated follow-up
behavior remains part of the external configuration that must be verified in Make.

Failure-monitoring patterns include:

- `integration_failures` records for failed asynchronous work.
- Retry paths for recoverable Airtable or backend-side integration failures.
- Deployed Make scenarios are expected to write result and error summaries back to
  Airtable without exposing private credentials; that behavior must be verified in
  Make.
- A confirmed webhook alert path for final Airtable synchronization failure after
  retries are exhausted. Broader webhook alert coverage is not claimed here.
- Audit events for important admin actions such as contractor activation,
  activation-email sends, dispatch decisions, cancellation, and completion
  approval.

## Launch Hardening and Smoke-Test Process

Launch hardening focuses on proving the system with real operational sequencing
while keeping sensitive details out of documentation:

1. Verify protected admin credentials separately in Make and Render, and rotate
   them when required without exposing their values.
2. Redeploy or restart services as needed so backend credential changes are live.
3. Verify protected Make-to-backend calls succeed with the rotated credential and
   stale credentials are no longer accepted.
4. Smoke-test contractor onboarding: create inactive contractor, send onboarding
   email, handle missing-docs path, send onboarding accepted email, activate, and
   send activated-contractor email.
5. Smoke-test dispatch: operator approval, availability check, dispatch, SMS
   confirm, on-the-way, done/finish, completion photo upload, and Airtable mirror.
6. Smoke-test completion and billing: approve completion, verify either closed
   paid or remainder-payment path, and confirm webhook-driven closure after
   remainder payment.
7. Review logs, audit events, email events, integration failure records, and
   Airtable result fields after each smoke path.

This smoke-test process is designed to validate behavior and observability without
publishing webhook URLs, private record IDs, tokens, customer data, contractor
data, phone numbers, or email addresses.

## Validation Approach

The project uses TypeScript checks, Vitest unit and integration tests, focused
backend launch-hardening reviews, and production smoke tests. The current verified
result is 616 automated backend tests passed, and the TypeScript build passed.

## Future Scope-Review Roadmap

A customer-selected job-size mismatch correction workflow is future work and is
not implemented. The design should keep PostgreSQL as the system of record and
preserve the original and corrected service, price, correction reason, approval,
payment adjustment, and audit history. Airtable should mirror operational status,
while Stripe remains authoritative for money actually collected or refunded.

## Engineering Takeaways

- Airtable is effective as an operator interface, but PostgreSQL must own
  canonical lifecycle state.
- Make is useful for orchestration and operator-friendly routing, but backend
  endpoints must own validation, idempotency, and side effects.
- Contractor activation needs a dedicated lifecycle, not a profile-edit shortcut.
- Email, SMS, and Airtable sync should be observable and retryable side effects,
  not hidden dependencies inside the primary transaction.
- Launch readiness is a workflow discipline: rotate credentials, smoke-test the
  complete operator path, verify monitoring, and avoid documenting secrets.
