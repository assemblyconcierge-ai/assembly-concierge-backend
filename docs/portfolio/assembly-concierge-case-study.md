# Assembly Concierge - Platform Case Study

## Overview

Assembly Concierge is a local service operations platform for furniture and
fitness-equipment assembly. The system covers the lifecycle from customer booking
and payment through contractor screening, onboarding, dispatch, completion review,
remainder billing, and operator monitoring.

The platform is in launch hardening. Core workflows are implemented and the backend
is deployed on Render, while external operational configuration in Make, Airtable,
Jotform, Stripe, and related services requires separate verification from repository
code. This case study distinguishes implemented code, automated-test evidence,
production smoke tests, deployed behavior, structurally verified automation, and
remaining launch-validation work.

## Problem

The business needed more than a booking form. It needed a controlled operational
system that could:

- accept customer requests and route fixed-price versus manual-review jobs;
- collect payment before dispatch eligibility;
- keep Airtable useful for operators without making it the source of truth;
- coordinate contractors without requiring a contractor app;
- prevent unvetted contractors from receiving dispatches;
- provide auditable admin actions, retryable integrations, and visible failure
  states; and
- prevent repeated or concurrent operator actions from creating duplicate dispatch
  or assignment records.

## Architecture

**Frontend** - A public booking experience for intake, payment redirects, and photo
collection, with separate contractor-facing pages for screening and completion-photo
uploads.

**Backend** - Node.js, Express, TypeScript, and PostgreSQL deployed on Render.
PostgreSQL is the source of truth for jobs, payments, contractors, dispatches,
assignments, email events, audit events, and integration failures.

**Payments** - Stripe Checkout handles upfront and remainder payments. Webhooks
update payment and job state after successful checkout.

**Storage** - Private object storage supports customer intake photos and contractor
completion photos through presigned upload flows. Google Drive stores contractor
onboarding documents and generated submission summaries.

**Operator interface** - Airtable is the operator dashboard and backend-state mirror.
Operators make high-level decisions in Airtable, while backend state transitions
remain authoritative.

**Automation layer** - Make connects Airtable operator actions to admin-protected
backend endpoints, writes operator-visible results, and routes failures into visible
recovery paths.

**Messaging** - Quo/OpenPhone-compatible SMS supports contractor dispatch commands
such as confirm, decline, on-the-way, and done, plus post-commit contractor
cancellation notices. Email flows cover contractor onboarding, missing-document
correction, acceptance, and activation.

## Customer Booking and Interface Hardening

The booking interface received targeted launch-polish changes rather than a redesign.
Address examples were restyled so placeholder text no longer looked like customer-
entered data. Quote-selection cards were corrected so only the current choice remains
highlighted instead of leaving earlier selections visually active.

Customer photo collection is capped at 12 files. Related copy, selectors, and form
presentation were adjusted while preserving existing booking, pricing, validation,
upload, payment, API, and submission behavior.

The backend also rejects passed same-day appointment windows so customers cannot
submit a booking for a time window that has already elapsed.

## Contractor Screening and Onboarding

### Screening and controlled backend creation

Contractor acquisition starts outside the dispatch system. Applicants move through a
controlled screening workflow before advancing to onboarding or backend contractor
creation.

The production screening flow uses contractor-specific links with expiration values.
The public screening page remains hidden until a prefill request confirms that the
link is valid and available. Malformed, expired, consumed, or otherwise unavailable
links receive a controlled unavailable state rather than applicant data.

A successful screening submission updates the matching Airtable application, records
completion and screening responses, and clears the token and expiration value.
Reopening the same link is rejected. The deployed flow was smoke-tested across valid
prefill, invalid-link handling, successful submission, token consumption, and replay
rejection.

A Make configuration conflict between sequential processing and synchronous webhook
responses was corrected so the browser could receive the intended structured success
response. Airtable and Make still do not provide the same atomic single-use guarantee
as a database transaction for truly simultaneous requests. Moving screening-token
validation and atomic consumption into the backend remains a future hardening option.

Approved applicants are advanced to controlled backend creation. New contractor
records are inactive by default, so screening completion alone does not grant dispatch
eligibility.

### Onboarding resubmission and lifecycle email recovery

Onboarding resubmissions preserve prior progress. The backend aggregates earlier
submission state before computing the current checklist, so a previously received
agreement, tax form, identification document, or insurance document is not reset to
missing merely because a later correction submission omits it.

After a successful Airtable update, the previous missing-documents email reservation
is cleared so another standard follow-up can be sent if the revised submission is
still incomplete. The current implementation accepts loss of that deleted email-event
record as a launch tradeoff; a future history redesign can preserve multiple correction
cycles without reusing the same reservation.

Onboarding acceptance remains separate from activation. Normal activation uses a
guarded admin-protected endpoint, and dispatch independently rejects inactive
contractors. Activated-contractor email sends are recorded, repeated requests return
an already-handled result, and an intentional resend path is available for recovery.

### Missing-document correction workflow

A dedicated Jotform correction form now supports targeted contractor document
resubmission without forcing the contractor to repeat the full onboarding process.
The form carries both the Airtable contractor-record identifier and canonical backend
contractor identifier, allowing the webhook to reconcile the submission with the
existing contractor lifecycle rather than create a duplicate record.

The webhook accepts the production Jotform field aliases for signed agreements, W-9s,
proof documents, other requested files, and contractor messages while preserving
legacy aliases for compatibility. Uploaded files are downloaded through the same
restricted Jotform-host and file-validation controls used by onboarding. The backend
normalizes actual file content before naming and storage, so a Jotform upload labeled
as a PDF but containing JPEG bytes is validated, assigned a `.jpg` extension, and
stored with the correct MIME type instead of trusting the incoming filename.

A production smoke test confirmed the complete correction path: multipart webhook
parsing, contractor resolution, reuse of the existing Google Drive folder, W-9 alias
extraction, successful authenticated download, JPEG signature detection, corrected
filename generation, Drive upload, document-metadata persistence, Airtable
synchronization, and operator notification. The Resend provider record showed the
operator email delivered to `assemblyconcierge@gmail.com`, and the message was
confirmed visible in the mailbox.

Document receipt remains intentionally separate from operator acceptance and
activation. Airtable can show all required files as received while the contractor
remains in `Owner Review Needed` and `Awaiting Review`; dispatch eligibility is not
granted until the review and activation gates are completed.

## Contractor Document Security

Contractor onboarding submissions arrive through Jotform. The backend stores the
signed agreement, W-9, photo ID, insurance document, and generated submission summary
in Google Drive. PostgreSQL tracks canonical onboarding and document status, while
Airtable mirrors status for operator review.

Jotform document downloads are restricted to approved Jotform hosts, HTTPS on the
default secure port, revalidated redirects, bounded redirect count, a total timeout,
and a file-size ceiling. Safe errors avoid exposing authenticated URLs or credential
values.

Before Drive upload, the backend derives the filename extension from the validated
MIME type and verifies matching PDF, PNG, or JPEG magic bytes. Unsupported types and
MIME/signature mismatches are rejected. Generated Drive summaries were expanded to
retain relevant onboarding responses.

The onboarding webhook token was rotated without documenting its value, and the Quo
webhook uses request-signature verification. A production onboarding smoke test and a
separate negative SSRF test succeeded. A dormant Jotform intake route outside the
active production flow was disabled to reduce attack surface.

## Airtable Operator Interface

Airtable remains an operator surface rather than the system of record. Operator work
included:

- current contractor-assignment mirroring and isolated V2 assignment-sync behavior;
- availability result fields populated from backend checks;
- completion override, approver, and approval-time fields;
- scheduled start and end timestamps for operator scheduling views;
- cancellation and redispatch reset behavior;
- operator-focused pages for new jobs, dispatch readiness, active work, exceptions,
  completion review, payments, contractors, completed jobs, and cancelled jobs; and
- read-only treatment of historical completed and cancelled views.

The cancel-assignment workflow clears the current dispatch mirror and restores a
redispatch-ready operator state while leaving backend synchronization timestamps under
the ownership of the backend sync process.

## Make Orchestration Hardening

Six production Make scenarios were inspected read-only first, corrected under explicit
preconditions, saved, and re-read for structural verification. Subsequent launch smoke
testing has now exercised the Dispatch Trigger and Cancel Assignment paths in
production; runtime validation of the remaining hardened scenarios is tracked
separately.

### Completion Approval Trigger

The completion request body contained malformed JSON, the boolean override value could
render blank, and success writeback could overwrite the operator's approver identity
and erase the override-reason audit trail.

The body was rebuilt using Make's structured data mode with native JSON serialization
and an explicit boolean conditional. Two destructive success mappings were removed.
Routing, filters, and error handlers were inspected and deliberately left unchanged.
The scenario is structurally verified but has not produced a captured post-change wire
request.

### Airtable Manual Sync

The backend retry request had no failure route, so a non-2xx response or timeout could
leave the operator request flag set without a visible error.

An error handler now locates the job record from webhook input and writes a failure
result, timestamp, error detail, and reset request flag. The scenario is structurally
verified but not executed. Its success writeback still depends on the backend response
including the expected job identifier.

### Cancel Job

The cancellation reason referenced a nonexistent token and could reach the backend as
blank. The failure path also treated a committed cancellation with pending checkout
cleanup as an outright failure.

A record lookup now supplies the real operator reason. The error path distinguishes
only the exact `CHECKOUT_EXPIRY_PENDING` marker from ordinary failures. The marker
branch writes a distinct committed-but-cleanup-pending status to Airtable; generic
errors remain failures. The scenario has not been executed, and its webhook payload
contract remains inferred from its saved guard configuration.

### Dispatch Trigger

The prior route logic could block a valid first dispatch, require two clicks for a
legitimate blank-result redispatch, record duplicate-suppression conflicts as failures,
leave whitespace in an error field, and reference a contractor identifier from the
wrong module.

Route conditions were corrected, blank-result redispatch was enabled, stale mappings
were removed, true field erasure was restored, and contractor references were pointed
to the authoritative lookup module. Exact `DUPLICATE_DISPATCH` marker branches were
added for both dispatch paths. Those branches perform no Airtable write and send no
owner alert, preventing a losing concurrent request from overwriting the winner's
state. Generic conflicts and failures remain on the failure path.

A later production redispatch test exposed one additional route-state gap: the
redispatch filter accepted `Pending Dispatch` and `Declined` but not the legitimate
post-cancellation `Cancelled` mirror state. Execution history showed two webhook runs
ending after record lookup with no route match. Route 3 was widened to accept
`Cancelled`; a subsequent cancel, reassign, availability check, and approval completed
through Route 3 without manually changing Dispatch Status. Make still sends no
contractor SMS in this flow; SMS remains a backend side effect after commit.

### Owner Alert

The owner SMS alert omitted the available event or operation field. The message body
was updated to include it while retaining the existing customer-email field by explicit
operator decision.

The scenario has no deduplication and no final-failure filter; repeated backend
emissions can create repeated alerts. A richer Phase B design remains parked pending a
broader backend payload contract. The scenario is structurally verified but not
executed.

### Cancel Assignment

The success writeback incorrectly placed a workflow timestamp into a field reserved
for backend synchronization events, with incompatible semantics and formatting.

That mapping was removed entirely rather than erased, preserving the last legitimate
backend-sync value. The remaining success writeback clears assignment and dispatch
references and restores redispatch eligibility. Production cancellation testing
confirmed the backend returned the job to `ready_for_dispatch`, cleared the active
assignment identifiers, and allowed a new assignment to be dispatched after the Route
3 fix described above.

### Automation design principles

The hardening work applied several consistent rules:

- recognize committed special outcomes through exact backend markers, not generic
  status codes;
- fail closed when a marker is absent;
- avoid any loser-side write that could destroy a successful winner's state;
- keep backend-sync fields under a single writer;
- use platform-native serialization for operator free text; and
- keep external automation inert until the backend emits the contract it expects.

## Dispatch Flow and Duplicate Protection

Dispatch begins after payment and operator approval gates are satisfied. The operator
selects a contractor in Airtable, Make checks backend readiness and availability, and
the backend performs the state transition that creates dispatch and assignment
records.

Contractors respond through SMS. The initial dispatch message now includes the job's
scheduled date and time window in the job timezone, along with service, city, payout,
and unchanged confirm/decline commands. Confirm assigns the job, decline returns it to
a dispatchable state, on-the-way records an en-route timestamp and can notify the
customer, and done or finish opens the completion-photo path. The schedule-bearing
initial dispatch SMS was merged, deployed on Render, and confirmed in a production
smoke test.

Launch hardening added transactional duplicate-dispatch protection. The backend locks
the job row before evaluating eligibility, checks for an active dispatch or active
assignment while holding that lock, and follows a consistent job-to-contractor-to-
child-record lock order. A committed winner causes a second attempt to return an exact
marker-specific HTTP 409 response without creating another dispatch or assignment.
Generic conflicts remain distinguishable from a true duplicate.

Legitimate redispatch remains allowed when only cancelled or otherwise inactive
historical assignments exist. The production cancel-to-redispatch path was exercised
with a real record after Make Route 3 was updated to accept the `Cancelled` mirror
state; the new dispatch created fresh dispatch and assignment identifiers without a
manual Dispatch Status reset.

Contractor cancellation notification is also backend-owned. After a successful
assignment cancellation transaction commits, the backend sends a concise cancellation
SMS to the contractor using the existing Quo adapter. The send is deliberately
non-fatal: an SMS failure is logged without rolling back or changing the successful
cancellation result. Existing row locking and active-assignment guards prevent a
second successful cancellation of the same assignment. The simplified patch passed 21
focused cancellation tests, 19 dispatch regression tests, and TypeScript validation,
was squash-merged into `main`, deployed through Render, and the cancellation text was
confirmed received in production.

The direct post-commit SMS design has the same known delivery gap as the existing
dispatch SMS path: if the process stops after the state commit but before delivery,
there is no durable notification worker to recover that send. A future notification
worker can address this class of delivery gap across contractor messaging.

The duplicate-dispatch hardening patch passed the TypeScript build, 24 focused dispatch
tests, and the full 748-test backend suite. It was merged into `main` and deployed live
on Render. Real PostgreSQL concurrency execution and a narrow production duplicate-
dispatch race smoke test remain separate validation gates.

## Completion Photos, Approval, and Remainder Payment

Contractor completion-photo uploads were hardened with upload-count and validation
limits before operator approval. Completion is not automatic when a contractor reports
the job done. The operator reviews the completion signal and photos. An authorized
admin may proceed without the normal photo requirement only by supplying an override
reason.

Completion approval persists whether an override was used, the reason, the approving
operator, and the approval timestamp. Airtable mirrors those fields for review.

After approval, the backend chooses the correct financial path:

- fully paid jobs close as paid and complete;
- jobs with a remainder move into a remainder-payment state and start asynchronous
  Stripe remainder-checkout creation; and
- the Stripe webhook closes the job after successful remainder payment.

Remainder-checkout failures are logged for recovery or manual retry. Because link
creation is asynchronous, a job can temporarily await remainder payment before a
payment link exists. This keeps completion, approval, billing, and closure separate
and auditable.

## Security Hardening

Recent backend hardening includes:

- stricter webhook and admin-route protections;
- Quo request-signature verification;
- disabled dormant production intake routes;
- passed same-day booking-window rejection;
- exact-host, HTTPS, redirect, timeout, and size controls for contractor files;
- MIME-derived filenames and magic-byte validation;
- inactive-by-default contractor creation and guarded activation;
- private storage with scoped presigned upload and review flows;
- transaction-bound duplicate-dispatch prevention; and
- observable audit, email, integration-failure, and retry records.

## Alerting and Recovery

The backend contains recoverable side-effect patterns for Airtable sync, selected
email and SMS sends, and payment-link creation. These paths record failures so
canonical state changes are not silently discarded.

Failure-monitoring patterns include integration-failure records, retry paths, operator-
visible result and error summaries, a confirmed webhook alert path for final Airtable
sync failure after exhausted retries, and audit events for major admin actions.

Broader owner-alert filtering and deduplication, durable payment-webhook processing,
and selected downstream recovery paths remain launch-hardening concerns rather than
completed claims.

## Validation Status

Current evidence:

- 748 automated backend tests passed;
- the TypeScript build passed for the latest dispatch hardening patch;
- contractor screening passed a production smoke test covering valid prefill,
  successful submission, token consumption, and replay rejection;
- contractor onboarding passed a production smoke test, including document handling,
  and a separate negative SSRF test;
- the missing-document correction patch passed its focused 162-test set and a broader
  399-test regression run, was merged into `main`, and deployed successfully on Render;
- the missing-document production smoke test passed through Jotform parsing, validated
  file download, MIME/signature correction, Google Drive storage, PostgreSQL metadata,
  Airtable synchronization, and confirmed operator-email delivery;
- the transactional duplicate-dispatch patch was merged and deployed live;
- the contractor dispatch SMS schedule patch passed 19 focused dispatch tests plus 40
  route/SMS regression tests, was merged and deployed, and its date/time window was
  confirmed in production;
- the cancel-to-redispatch flow was production-tested through the legitimate
  `Cancelled` Airtable mirror state after the Make Route 3 filter was corrected;
- the contractor cancellation SMS patch passed 21 focused cancellation tests, 19
  dispatch regression tests, and TypeScript validation, was squash-merged into
  `main`, deployed, and confirmed received in production; and
- the Dispatch Trigger and Cancel Assignment Make paths have now been exercised in
  production after hardening, while the remaining hardened scenarios are still
  tracked for runtime validation.

Still pending or separately tracked:

- operator acceptance and activation of the contractor used for the missing-document
  smoke test;
- real PostgreSQL concurrency execution for the duplicate-dispatch race;
- narrow production smoke testing of duplicate-dispatch race behavior after deployment;
- runtime validation of the remaining hardened Make scenarios;
- captured request proof for completion override values and structured boolean output;
- confirmation of selected Airtable field-ID-to-name mappings;
- validation of the Cancel Job webhook payload and Airtable-side gating;
- durable recovery for selected payment and downstream synchronization failures,
  including the direct post-commit SMS crash window;
- broader owner-alert filtering and deduplication;
- final validation of external Make, Airtable, Stripe, and Render settings;
- completion-override behavior under production use; and
- contractor cancellation compensation and expanded-scope payment workflows.

## Engineering Takeaways

- Airtable is effective as an operator interface, but PostgreSQL must own canonical
  lifecycle state.
- Make is useful for orchestration, but backend endpoints must own validation,
  idempotency, and authoritative side effects.
- Exact machine-readable markers are safer than interpreting generic HTTP status
  codes for committed special outcomes.
- Synchronous webhook responses and queueing settings must be evaluated together.
- Contractor activation needs a dedicated lifecycle, not a profile-edit shortcut.
- Email, SMS, payment creation, and Airtable sync should be observable and recoverable
  side effects rather than hidden dependencies inside primary transactions.
- Concurrency protections should be enforced where canonical state is written, not
  inferred from operator-interface state.
- Launch readiness is a workflow discipline: rotate credentials, smoke-test complete
  operator paths, verify monitoring, and avoid documenting secrets.