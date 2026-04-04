#!/usr/bin/env bash
# Live end-to-end test POST to /webhooks/jotform
# Uses correct payload shape matching DEFAULT_JOTFORM_FIELD_MAPPING:
#   - q3_fullName as nested object (first/last)
#   - q26_typeA26 for city (NOT q18_city)
#   - unique submissionID to avoid idempotency dedup

SUBMISSION_ID="test-$(date +%s)"
BASE_URL="https://assembly-concierge-backend.onrender.com"

echo "=== Sending test POST to ${BASE_URL}/webhooks/jotform ==="
echo "=== submissionID: ${SUBMISSION_ID} ==="

curl -s -w "\n\n=== HTTP STATUS: %{http_code} ===" \
  -X POST "${BASE_URL}/webhooks/jotform" \
  -H "Content-Type: application/json" \
  -d "{
    \"submissionID\": \"${SUBMISSION_ID}\",
    \"formID\": \"test-form-001\",
    \"formTitle\": \"Assembly Concierge Test\",
    \"q3_fullName\": { \"first\": \"Jane\", \"last\": \"Smith\" },
    \"q4_email\": \"jane.smith.test@example.com\",
    \"q79_phoneNumber79\": { \"full\": \"(770) 555-0101\" },
    \"q26_typeA26\": \"Hampton\",
    \"q38_addresshttpswwwjotformcomhelp71-Prepopulating-Fiel\": { \"state\": \"GA\", \"postal\": \"30228\" },
    \"q6_streetNumberstreet\": { \"addr_line1\": \"123 Test Lane\" },
    \"q7_serviceNeeded\": \"Small Assembly\",
    \"q48_typeA48\": \"No Rush\",
    \"q9_preferredDate\": \"2026-04-01\",
    \"q11_preferredTime\": \"Morning (8am-12pm)\",
    \"q13_notesFor\": \"Live test submission — please ignore\",
    \"q20_uniqueId\": \"${SUBMISSION_ID}\",
    \"q52_areaTag\": \"Hampton-GA\"
  }" | python3 -m json.tool 2>/dev/null || true

echo ""
