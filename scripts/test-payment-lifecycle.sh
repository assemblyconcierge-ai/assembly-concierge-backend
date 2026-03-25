#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Assembly Concierge — Payment Lifecycle Validation Script
#
# Tests the full deposit → remainder payment lifecycle against a live backend.
# No Jotform UI, no frontend required.
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
# What this script validates:
#   A. Deposit flow
#      1. POST /admin/test-jobs           → job created, status = awaiting_payment
#      2. GET  /jobs/:id                  → confirm awaiting_payment
#      3. POST /jobs/:id/create-checkout-session (deposit)
#                                         → checkout URL returned
#      4. Manual Stripe test payment      → instructions printed
#      5. GET  /jobs/:id (after payment)  → confirm deposit_paid
#
#   B. Remainder flow (unless SKIP_REMAINDER=1)
#      6. POST /jobs/:id/create-remainder-payment
#                                         → checkout URL returned
#      7. Manual Stripe test payment      → instructions printed
#      8. GET  /jobs/:id (after payment)  → confirm closed_paid
#
# Airtable and Stripe Events Queue checks are printed as a manual checklist
# at the end of each phase — the script cannot automate those directly.
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
RESET="\033[0m"

pass() { echo -e "${GREEN}✔ $*${RESET}"; }
warn() { echo -e "${YELLOW}⚠ $*${RESET}"; }
fail() { echo -e "${RED}✘ $*${RESET}"; exit 1; }
header() { echo -e "\n${BOLD}── $* ──${RESET}"; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1 (install it first)"; }
require_cmd curl
require_cmd jq

AUTH_HEADER="X-Admin-Token: ${ADMIN_TOKEN}"

# ── Helper: GET /jobs/:id and print key fields ────────────────────────────────
get_job() {
  local job_id="$1"
  curl -sf -H "${AUTH_HEADER}" "${BASE_URL}/jobs/${job_id}" | jq '{
    id,
    job_key,
    status,
    payment_mode,
    deposit_amount_cents,
    remainder_amount_cents,
    total_amount_cents,
    updated_at
  }'
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Create test job
# ─────────────────────────────────────────────────────────────────────────────
header "STEP 1: Create test job (service=${SERVICE_TYPE}, city=${CITY}, paymentMode=deposit)"

CREATE_RESPONSE=$(curl -sf -X POST "${BASE_URL}/admin/test-jobs" \
  -H "${AUTH_HEADER}" \
  -H "Content-Type: application/json" \
  -d "{\"serviceTypeCode\":\"${SERVICE_TYPE}\",\"city\":\"${CITY}\",\"paymentMode\":\"deposit\"}")

echo "${CREATE_RESPONSE}" | jq .

JOB_ID=$(echo "${CREATE_RESPONSE}" | jq -r '.jobId')
JOB_KEY=$(echo "${CREATE_RESPONSE}" | jq -r '.jobKey')
AREA_STATUS=$(echo "${CREATE_RESPONSE}" | jq -r '.serviceAreaStatus')
CORRELATION_ID=$(echo "${CREATE_RESPONSE}" | jq -r '.correlationId')

[[ "${JOB_ID}" == "null" || -z "${JOB_ID}" ]] && fail "Job creation failed — no jobId in response"
pass "Job created: ${JOB_KEY} (id=${JOB_ID})"
echo "  serviceAreaStatus = ${AREA_STATUS}"
echo "  correlationId     = ${CORRELATION_ID}"

if [[ "${AREA_STATUS}" != "in_area" ]]; then
  warn "serviceAreaStatus is '${AREA_STATUS}' — job may be in quoted_outside_area or error_review state"
  warn "Ensure city '${CITY}' is in the service area config. Continuing anyway."
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — Verify job exists in backend (awaiting_payment)
# ─────────────────────────────────────────────────────────────────────────────
header "STEP 2: Verify job status = awaiting_payment"

JOB_BEFORE=$(get_job "${JOB_ID}")
echo "${JOB_BEFORE}"

STATUS_BEFORE=$(echo "${JOB_BEFORE}" | jq -r '.status')
if [[ "${STATUS_BEFORE}" == "awaiting_payment" ]]; then
  pass "PostgreSQL: jobs.status = awaiting_payment ✔"
else
  warn "Expected awaiting_payment, got: ${STATUS_BEFORE}"
  warn "If in_area pricing failed, job may be in error_review — check server logs with correlationId=${CORRELATION_ID}"
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

DEPOSIT_URL=$(echo "${DEPOSIT_SESSION}" | jq -r '.checkoutUrl // .url // empty')
DEPOSIT_SESSION_ID=$(echo "${DEPOSIT_SESSION}" | jq -r '.sessionId // empty')

[[ -z "${DEPOSIT_URL}" ]] && fail "No checkoutUrl in deposit session response"
pass "Deposit checkout session created"
echo "  sessionId   = ${DEPOSIT_SESSION_ID}"
echo "  checkoutUrl = ${DEPOSIT_URL}"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — Manual: complete deposit payment in Stripe test mode
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
echo "  After payment completes, press ENTER to continue verification."
read -r -p "  Press ENTER when deposit payment is complete... "

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — Verify deposit_paid
# ─────────────────────────────────────────────────────────────────────────────
header "STEP 5: Verify backend status = deposit_paid"

# Allow up to 30s for webhook processing
DEPOSIT_STATUS=""
for i in $(seq 1 6); do
  sleep 5
  DEPOSIT_STATUS=$(get_job "${JOB_ID}" | jq -r '.status')
  echo "  [attempt ${i}/6] jobs.status = ${DEPOSIT_STATUS}"
  [[ "${DEPOSIT_STATUS}" == "deposit_paid" ]] && break
done

if [[ "${DEPOSIT_STATUS}" == "deposit_paid" ]]; then
  pass "PostgreSQL: jobs.status = deposit_paid ✔"
else
  fail "Expected deposit_paid after deposit payment, got: ${DEPOSIT_STATUS}"
fi

get_job "${JOB_ID}"

echo ""
echo -e "${BOLD}Manual Airtable check (Backend Intake Sandbox V2 — record for ${JOB_KEY}):${RESET}"
echo "  ☐ Status                = paid"
echo "  ☐ Backend Job Status    = deposit_paid"
echo "  ☐ Backend Updated At    = recent timestamp"
echo "  ☐ Last Backend Sync At  = recent timestamp"
echo "  ☐ Backend Sync Error    = (empty)"
echo "  ☐ Deposit Status        = paid"
echo "  ☐ Remainder Status      = (blank)"
echo "  ☐ Overall Payment Status = deposit_paid"
echo ""
echo -e "${BOLD}Manual Stripe Events Queue check (Airtable):${RESET}"
echo "  ☐ Event type = checkout.session.completed"
echo "  ☐ Payment type = deposit"
echo "  ☐ Session ID matches: ${DEPOSIT_SESSION_ID}"

if [[ "${SKIP_REMAINDER}" == "1" ]]; then
  echo ""
  pass "SKIP_REMAINDER=1 — skipping remainder flow"
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

REMAINDER_URL=$(echo "${REMAINDER_SESSION}" | jq -r '.checkoutUrl // .url // empty')
REMAINDER_SESSION_ID=$(echo "${REMAINDER_SESSION}" | jq -r '.sessionId // empty')

[[ -z "${REMAINDER_URL}" ]] && fail "No checkoutUrl in remainder session response"
pass "Remainder checkout session created"
echo "  sessionId   = ${REMAINDER_SESSION_ID}"
echo "  checkoutUrl = ${REMAINDER_URL}"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 7 — Manual: complete remainder payment in Stripe test mode
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
# STEP 8 — Verify closed_paid
# ─────────────────────────────────────────────────────────────────────────────
header "STEP 8: Verify backend status = closed_paid"

REMAINDER_STATUS=""
for i in $(seq 1 6); do
  sleep 5
  REMAINDER_STATUS=$(get_job "${JOB_ID}" | jq -r '.status')
  echo "  [attempt ${i}/6] jobs.status = ${REMAINDER_STATUS}"
  [[ "${REMAINDER_STATUS}" == "closed_paid" ]] && break
done

if [[ "${REMAINDER_STATUS}" == "closed_paid" ]]; then
  pass "PostgreSQL: jobs.status = closed_paid ✔"
else
  fail "Expected closed_paid after remainder payment, got: ${REMAINDER_STATUS}"
fi

get_job "${JOB_ID}"

echo ""
echo -e "${BOLD}Manual Airtable check (Backend Intake Sandbox V2 — record for ${JOB_KEY}):${RESET}"
echo "  ☐ Status                = completed"
echo "  ☐ Backend Job Status    = closed_paid"
echo "  ☐ Backend Updated At    = recent timestamp"
echo "  ☐ Last Backend Sync At  = recent timestamp"
echo "  ☐ Backend Sync Error    = (empty)"
echo "  ☐ Deposit Status        = paid"
echo "  ☐ Remainder Status      = paid"
echo "  ☐ Overall Payment Status = paid_in_full"
echo "  ☐ Total Paid            = full amount"
echo "  ☐ Balance Outstanding   = 0"
echo ""
echo -e "${BOLD}Manual Stripe Events Queue check (Airtable):${RESET}"
echo "  ☐ Second event type = checkout.session.completed"
echo "  ☐ Payment type = remainder"
echo "  ☐ Session ID matches: ${REMAINDER_SESSION_ID}"

echo ""
pass "Payment lifecycle validation complete for ${JOB_KEY} (id=${JOB_ID})"
echo ""
echo "Summary:"
echo "  Job Key:              ${JOB_KEY}"
echo "  Job ID:               ${JOB_ID}"
echo "  Deposit Session ID:   ${DEPOSIT_SESSION_ID}"
echo "  Remainder Session ID: ${REMAINDER_SESSION_ID}"
echo "  Correlation ID:       ${CORRELATION_ID}"
