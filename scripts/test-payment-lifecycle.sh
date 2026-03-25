#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Assembly Concierge — Payment Lifecycle Validation Script v2
#
# Validates the full deposit → remainder payment lifecycle against a live backend.
# No Jotform UI, no frontend required.
#
# Prerequisites on the Render service:
#   ENABLE_TEST_ROUTES=true   (required — routes return 404 without this)
#   STRIPE_SECRET_KEY         must start with sk_test_ (enforced server-side too)
#
# Usage:
#   export BASE_URL=https://your-backend.onrender.com
#   export ADMIN_TOKEN=your-admin-jwt-secret
#   bash scripts/test-payment-lifecycle.sh
#
# Optional env vars:
#   SERVICE_TYPE   small | medium | large | treadmill  (default: small)
#   CITY           in-area city name                   (default: Hampton)
#   SKIP_REMAINDER set to "1" to run deposit-only test
#
# What this script verifies per phase:
#   PostgreSQL:  jobs.status, payments rows, payment_events rows
#   Airtable:    parent (Backend Intake Sandbox V2) — manual checklist printed
#   Stripe Events Queue: manual checklist printed
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
BASE_URL="${BASE_URL:-https://assembly-concierge-api.onrender.com}"
ADMIN_TOKEN="${ADMIN_TOKEN:?ERROR: ADMIN_TOKEN env var is required}"
SERVICE_TYPE="${SERVICE_TYPE:-small}"
CITY="${CITY:-Hampton}"
SKIP_REMAINDER="${SKIP_REMAINDER:-0}"

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
CYAN="\033[0;36m"
RESET="\033[0m"

pass()   { echo -e "${GREEN}✔ $*${RESET}"; }
warn()   { echo -e "${YELLOW}⚠ $*${RESET}"; }
fail()   { echo -e "${RED}✘ $*${RESET}"; exit 1; }
header() { echo -e "\n${BOLD}${CYAN}── $* ──${RESET}"; }
note()   { echo -e "${BOLD}$*${RESET}"; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"; }
require_cmd curl
require_cmd jq

AUTH_HEADER="X-Admin-Token: ${ADMIN_TOKEN}"

# ── Helper: GET /jobs/:id ─────────────────────────────────────────────────────
get_job() {
  local job_id="$1"
  curl -sf -H "${AUTH_HEADER}" "${BASE_URL}/jobs/${job_id}" | jq '{
    id, job_key, status, payment_mode,
    deposit_amount_cents, remainder_amount_cents, total_amount_cents,
    updated_at
  }'
}

# ── Helper: GET /admin/jobs/:id/payment-events ────────────────────────────────
get_payment_events() {
  local job_id="$1"
  curl -sf -H "${AUTH_HEADER}" "${BASE_URL}/admin/jobs/${job_id}/payment-events"
}

# ── Helper: poll jobs.status until expected value or timeout ──────────────────
poll_status() {
  local job_id="$1"
  local expected="$2"
  local max_attempts=6
  local actual=""
  for i in $(seq 1 "${max_attempts}"); do
    sleep 5
    actual=$(get_job "${job_id}" | jq -r '.status')
    echo "  [attempt ${i}/${max_attempts}] jobs.status = ${actual}"
    [[ "${actual}" == "${expected}" ]] && break
  done
  echo "${actual}"
}

# ─────────────────────────────────────────────────────────────────────────────
# PRE-FLIGHT: confirm ENABLE_TEST_ROUTES is active
# ─────────────────────────────────────────────────────────────────────────────
header "PRE-FLIGHT: Verify test routes are enabled"
PREFLIGHT=$(curl -sf -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/admin/test-jobs" \
  -H "${AUTH_HEADER}" -H "Content-Type: application/json" -d '{"serviceTypeCode":"__preflight__"}' 2>/dev/null || true)

if [[ "${PREFLIGHT}" == "404" ]]; then
  fail "POST /admin/test-jobs returned 404. Set ENABLE_TEST_ROUTES=true on the Render service and redeploy."
elif [[ "${PREFLIGHT}" == "401" || "${PREFLIGHT}" == "403" ]]; then
  fail "Admin auth failed (HTTP ${PREFLIGHT}). Check ADMIN_TOKEN matches ADMIN_JWT_SECRET on the server."
elif [[ "${PREFLIGHT}" == "500" ]]; then
  warn "Server returned 500 — may be STRIPE_SECRET_KEY not starting with sk_test_. Check server logs."
fi
pass "Test routes appear reachable (HTTP ${PREFLIGHT})"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Create test job
# ─────────────────────────────────────────────────────────────────────────────
header "STEP 1: Create test job (service=${SERVICE_TYPE}, city=${CITY}, paymentMode=deposit)"

CREATE_RESPONSE=$(curl -sf -X POST "${BASE_URL}/admin/test-jobs" \
  -H "${AUTH_HEADER}" \
  -H "Content-Type: application/json" \
  -d "{\"serviceTypeCode\":\"${SERVICE_TYPE}\",\"city\":\"${CITY}\",\"paymentMode\":\"deposit\"}")

echo "${CREATE_RESPONSE}" | jq .

JOB_ID=$(echo "${CREATE_RESPONSE}"    | jq -r '.jobId')
JOB_KEY=$(echo "${CREATE_RESPONSE}"   | jq -r '.jobKey')
AREA_STATUS=$(echo "${CREATE_RESPONSE}" | jq -r '.serviceAreaStatus')
CORRELATION_ID=$(echo "${CREATE_RESPONSE}" | jq -r '.correlationId')

[[ "${JOB_ID}" == "null" || -z "${JOB_ID}" ]] && fail "Job creation failed — no jobId in response"
pass "Job created: ${JOB_KEY} (id=${JOB_ID})"
echo "  serviceAreaStatus = ${AREA_STATUS}"
echo "  correlationId     = ${CORRELATION_ID}"

if [[ "${AREA_STATUS}" != "in_area" ]]; then
  warn "serviceAreaStatus='${AREA_STATUS}' — job may be in error_review. Ensure city '${CITY}' is in service area config."
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — Verify initial PostgreSQL state
# ─────────────────────────────────────────────────────────────────────────────
header "STEP 2: Verify initial backend state (jobs.status = awaiting_payment)"

JOB_BEFORE=$(get_job "${JOB_ID}")
echo "${JOB_BEFORE}"

STATUS_BEFORE=$(echo "${JOB_BEFORE}" | jq -r '.status')
if [[ "${STATUS_BEFORE}" == "awaiting_payment" ]]; then
  pass "PostgreSQL jobs.status = awaiting_payment ✔"
else
  warn "Expected awaiting_payment, got: ${STATUS_BEFORE} (correlationId=${CORRELATION_ID})"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — Create deposit checkout session
# ─────────────────────────────────────────────────────────────────────────────
header "STEP 3: Create deposit checkout session"

DEPOSIT_SESSION=$(curl -sf -X POST "${BASE_URL}/jobs/${JOB_ID}/create-checkout-session" \
  -H "${AUTH_HEADER}" \
  -H "Content-Type: application/json" \
  -d '{"paymentType":"deposit"}')

echo "${DEPOSIT_SESSION}" | jq .

DEPOSIT_URL=$(echo "${DEPOSIT_SESSION}"        | jq -r '.checkoutUrl // .url // empty')
DEPOSIT_SESSION_ID=$(echo "${DEPOSIT_SESSION}" | jq -r '.sessionId // empty')

[[ -z "${DEPOSIT_URL}" ]] && fail "No checkoutUrl in deposit session response"
pass "Deposit checkout session created"
echo "  sessionId   = ${DEPOSIT_SESSION_ID}"
echo "  checkoutUrl = ${DEPOSIT_URL}"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — Manual: complete deposit payment
# ─────────────────────────────────────────────────────────────────────────────
header "STEP 4: Complete deposit payment (MANUAL)"
echo ""
echo -e "${YELLOW}ACTION REQUIRED — complete the Stripe test payment:${RESET}"
echo ""
echo "  Option A (browser): Open the URL below, use test card 4242 4242 4242 4242"
echo "  ${DEPOSIT_URL}"
echo ""
echo "  Option B (Stripe CLI — if webhook forwarding is active):"
echo "  stripe trigger checkout.session.completed \\"
echo "    --override checkout_session:id=${DEPOSIT_SESSION_ID}"
echo ""
read -r -p "  Press ENTER when deposit payment is complete... "

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — Verify deposit_paid (PostgreSQL)
# ─────────────────────────────────────────────────────────────────────────────
header "STEP 5: Verify backend state after deposit"

DEPOSIT_STATUS=$(poll_status "${JOB_ID}" "deposit_paid")

if [[ "${DEPOSIT_STATUS}" == "deposit_paid" ]]; then
  pass "PostgreSQL jobs.status = deposit_paid ✔"
else
  fail "Expected deposit_paid after deposit payment, got: ${DEPOSIT_STATUS}"
fi

echo ""
note "PostgreSQL job record after deposit:"
get_job "${JOB_ID}"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5b — Backend payment/event record verification (deposit)
# ─────────────────────────────────────────────────────────────────────────────
header "STEP 5b: Backend payment + payment_events records (deposit)"

DEPOSIT_EVENTS=$(get_payment_events "${JOB_ID}")
echo "${DEPOSIT_EVENTS}" | jq .

DEPOSIT_PAYMENT_STATUS=$(echo "${DEPOSIT_EVENTS}" | jq -r '.payments[] | select(.payment_type=="deposit") | .status')
DEPOSIT_PAYMENT_INTENT=$(echo "${DEPOSIT_EVENTS}" | jq -r '.payments[] | select(.payment_type=="deposit") | .provider_payment_intent_id // "null"')
DEPOSIT_EVENT_COUNT=$(echo "${DEPOSIT_EVENTS}"    | jq '[.paymentEvents[] | select(.event_type=="checkout.session.completed")] | length')

if [[ "${DEPOSIT_PAYMENT_STATUS}" == "paid" ]]; then
  pass "payments.status = paid for deposit row ✔"
else
  warn "Expected payments.status=paid for deposit, got: '${DEPOSIT_PAYMENT_STATUS}'"
fi

if [[ "${DEPOSIT_PAYMENT_INTENT}" != "null" && -n "${DEPOSIT_PAYMENT_INTENT}" ]]; then
  pass "payments.provider_payment_intent_id populated: ${DEPOSIT_PAYMENT_INTENT} ✔"
else
  warn "payments.provider_payment_intent_id is null — webhook may not have fired yet"
fi

if [[ "${DEPOSIT_EVENT_COUNT}" -ge 1 ]]; then
  pass "payment_events: ${DEPOSIT_EVENT_COUNT} checkout.session.completed event(s) recorded ✔"
else
  warn "No checkout.session.completed event in payment_events — webhook path may not have executed"
fi

echo ""
note "Manual Airtable check — Backend Intake Sandbox V2 (record: ${JOB_KEY}):"
echo "  ☐ Status                 = paid"
echo "  ☐ Overall Payment Status = deposit_paid"
echo "  ☐ Total Paid             = deposit amount"
echo "  ☐ Balance Outstanding    = remainder amount"
echo "  ☐ Backend Job Status     = deposit_paid"
echo "  ☐ Backend Updated At     = recent timestamp"
echo "  ☐ Last Backend Sync At   = recent timestamp"
echo "  ☐ Backend Sync Error     = (empty)"
echo "  ☐ Deposit Status         = paid"
echo "  ☐ Remainder Status       = (blank)"
echo "  ☐ Backend Status Match   = true"
echo "  ☐ Needs Reconciliation   = false"
echo "  ☐ Reconciliation Reason  = (empty)"
echo ""
note "Manual Stripe Events Queue check (Airtable child table):"
echo "  ☐ Event type  = checkout.session.completed"
echo "  ☐ Payment type = deposit"
echo "  ☐ Session ID  = ${DEPOSIT_SESSION_ID}"

if [[ "${SKIP_REMAINDER}" == "1" ]]; then
  echo ""
  pass "SKIP_REMAINDER=1 — deposit-only validation complete"
  echo ""
  echo "Job ID for manual remainder test: ${JOB_ID}"
  echo "Job Key: ${JOB_KEY}"
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6 — Create remainder checkout session
# ─────────────────────────────────────────────────────────────────────────────
header "STEP 6: Create remainder checkout session"

REMAINDER_SESSION=$(curl -sf -X POST "${BASE_URL}/jobs/${JOB_ID}/create-remainder-payment" \
  -H "${AUTH_HEADER}" \
  -H "Content-Type: application/json")

echo "${REMAINDER_SESSION}" | jq .

REMAINDER_URL=$(echo "${REMAINDER_SESSION}"        | jq -r '.checkoutUrl // .url // empty')
REMAINDER_SESSION_ID=$(echo "${REMAINDER_SESSION}" | jq -r '.sessionId // empty')

[[ -z "${REMAINDER_URL}" ]] && fail "No checkoutUrl in remainder session response"
pass "Remainder checkout session created"
echo "  sessionId   = ${REMAINDER_SESSION_ID}"
echo "  checkoutUrl = ${REMAINDER_URL}"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 7 — Manual: complete remainder payment
# ─────────────────────────────────────────────────────────────────────────────
header "STEP 7: Complete remainder payment (MANUAL)"
echo ""
echo -e "${YELLOW}ACTION REQUIRED — complete the Stripe test payment:${RESET}"
echo ""
echo "  Option A (browser): Open the URL below, use test card 4242 4242 4242 4242"
echo "  ${REMAINDER_URL}"
echo ""
echo "  Option B (Stripe CLI — if webhook forwarding is active):"
echo "  stripe trigger checkout.session.completed \\"
echo "    --override checkout_session:id=${REMAINDER_SESSION_ID}"
echo ""
read -r -p "  Press ENTER when remainder payment is complete... "

# ─────────────────────────────────────────────────────────────────────────────
# STEP 8 — Verify closed_paid (PostgreSQL)
# ─────────────────────────────────────────────────────────────────────────────
header "STEP 8: Verify backend state after remainder"

REMAINDER_STATUS=$(poll_status "${JOB_ID}" "closed_paid")

if [[ "${REMAINDER_STATUS}" == "closed_paid" ]]; then
  pass "PostgreSQL jobs.status = closed_paid ✔"
else
  fail "Expected closed_paid after remainder payment, got: ${REMAINDER_STATUS}"
fi

echo ""
note "PostgreSQL job record after remainder:"
get_job "${JOB_ID}"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 8b — Backend payment/event record verification (remainder)
# ─────────────────────────────────────────────────────────────────────────────
header "STEP 8b: Backend payment + payment_events records (remainder)"

REMAINDER_EVENTS=$(get_payment_events "${JOB_ID}")
echo "${REMAINDER_EVENTS}" | jq .

REMAINDER_PAYMENT_STATUS=$(echo "${REMAINDER_EVENTS}" | jq -r '.payments[] | select(.payment_type=="remainder") | .status')
REMAINDER_PAYMENT_INTENT=$(echo "${REMAINDER_EVENTS}" | jq -r '.payments[] | select(.payment_type=="remainder") | .provider_payment_intent_id // "null"')
TOTAL_EVENT_COUNT=$(echo "${REMAINDER_EVENTS}"        | jq '[.paymentEvents[] | select(.event_type=="checkout.session.completed")] | length')

if [[ "${REMAINDER_PAYMENT_STATUS}" == "paid" ]]; then
  pass "payments.status = paid for remainder row ✔"
else
  warn "Expected payments.status=paid for remainder, got: '${REMAINDER_PAYMENT_STATUS}'"
fi

if [[ "${REMAINDER_PAYMENT_INTENT}" != "null" && -n "${REMAINDER_PAYMENT_INTENT}" ]]; then
  pass "payments.provider_payment_intent_id populated: ${REMAINDER_PAYMENT_INTENT} ✔"
else
  warn "payments.provider_payment_intent_id is null for remainder — webhook may not have fired yet"
fi

if [[ "${TOTAL_EVENT_COUNT}" -ge 2 ]]; then
  pass "payment_events: ${TOTAL_EVENT_COUNT} checkout.session.completed events total (deposit + remainder) ✔"
else
  warn "Expected 2 checkout.session.completed events, found: ${TOTAL_EVENT_COUNT}"
fi

echo ""
note "Manual Airtable check — Backend Intake Sandbox V2 (record: ${JOB_KEY}):"
echo "  ☐ Status                 = completed"
echo "  ☐ Overall Payment Status = paid_in_full"
echo "  ☐ Total Paid             = full amount"
echo "  ☐ Balance Outstanding    = 0"
echo "  ☐ Backend Job Status     = closed_paid"
echo "  ☐ Backend Updated At     = recent timestamp"
echo "  ☐ Last Backend Sync At   = recent timestamp"
echo "  ☐ Backend Sync Error     = (empty)"
echo "  ☐ Deposit Status         = paid"
echo "  ☐ Remainder Status       = paid"
echo "  ☐ Backend Status Match   = true"
echo "  ☐ Needs Reconciliation   = false"
echo "  ☐ Reconciliation Reason  = (empty)"
echo ""
note "Manual Stripe Events Queue check (Airtable child table):"
echo "  ☐ Second event type  = checkout.session.completed"
echo "  ☐ Payment type       = remainder"
echo "  ☐ Session ID         = ${REMAINDER_SESSION_ID}"
echo "  ☐ Deposit event also present (Session ID = ${DEPOSIT_SESSION_ID})"

# ─────────────────────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────────────────────
echo ""
pass "Payment lifecycle validation complete for ${JOB_KEY}"
echo ""
echo "Summary:"
echo "  Job Key:              ${JOB_KEY}"
echo "  Job ID:               ${JOB_ID}"
echo "  Correlation ID:       ${CORRELATION_ID}"
echo "  Deposit Session ID:   ${DEPOSIT_SESSION_ID}"
echo "  Remainder Session ID: ${REMAINDER_SESSION_ID}"
echo ""
echo "False-positive prevention:"
echo "  - Unique externalSubmissionId (test-<uuid>) per run — no idempotency collisions"
echo "  - Airtable values confirmed by Backend Updated At timestamp (must be from this run)"
echo "  - Webhook execution confirmed by payment_events rows with provider_event_id from Stripe"
