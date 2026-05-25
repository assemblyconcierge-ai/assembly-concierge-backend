# Public Booking Frontend Contract

## Current backend endpoints

- `POST /public/bookings`
- `POST /public/review-requests`
- `GET /jobs/pay/:publicPayToken`

---

## Fixed-price available-slot flow

Customer submits a fixed-price booking for one of the following service types:

- `small`
- `medium`
- `large`
- `treadmill`

**Flow:**

1. Frontend sends `POST /public/bookings`.
2. Backend validates service type, city/service area, date/window, same-day rule, and soft capacity.
3. If the slot is available, backend creates a job at status `awaiting_payment`.
4. Backend creates a Stripe checkout session asynchronously (after the HTTP response is sent).
5. Backend sends the checkout link by SMS after the checkout session is created.
6. Frontend polls `GET /jobs/pay/:publicPayToken` until `checkoutUrl` is non-null.
7. When `checkoutUrl` is ready, frontend redirects to Stripe.

**Important:**

- `POST /public/bookings` does **not** return `checkoutUrl` in the 201 response.
- The first poll may return `checkoutUrl: null` — this is normal, not an error.
- Frontend must poll rather than treating a null `checkoutUrl` as a failure.
- The SMS payment link is a fallback for customers who leave the page. It is not the primary redirect mechanism.

---

## Fixed-price unavailable-slot flow

When the backend returns `409 APPOINTMENT_SLOT_UNAVAILABLE`, the response includes:

```json
{
  "error": "APPOINTMENT_SLOT_UNAVAILABLE",
  "recoverable": true,
  "manualReviewAvailable": true
}
```

Frontend must present two explicit recovery choices — not just an error message:

1. **Choose another window** — re-enable the date and window fields so the customer can pick a different time and resubmit. Preserve all other form data.
2. **Request this window anyway** — carry the customer's name, contact info, service type, and original date/window forward and call `POST /public/review-requests` with `reviewReason: "slot_full_manual_review"`.

---

## Manual-review flow

Use `POST /public/review-requests` for:

- `custom` jobs (`reviewReason: "custom_job"`)
- `fitness_equipment` (`reviewReason: "fitness_equipment"`)
- Slot-full fallback from a fixed-price booking attempt (`reviewReason: "slot_full_manual_review"`)
- Uncertain or unknown service type (`reviewReason: "other_uncertain"`)

**What a manual review job looks like on the backend:**

- Job status: `intake_validated`
- Payment mode: `custom_review`
- Amount: `$0`
- No Stripe checkout session is created
- No payment-link SMS is sent
- Job is not eligible for contractor dispatch
- Airtable receives the record for owner review and follow-up

---

## Checkout polling behavior

After `POST /public/bookings` returns `201`:

1. Wait approximately 1 second.
2. Call `GET /jobs/pay/:publicPayToken`.
3. If `checkoutUrl` is `null`, retry every 2 seconds.
4. Retry up to approximately 15 attempts (30 seconds total).
5. If `checkoutUrl` becomes non-null, redirect to Stripe immediately.
6. If retries are exhausted, show:

> "We're having trouble loading your payment page. Your payment link has also been sent to your phone. Please check your messages."

**Do not retry `POST /public/bookings` after a successful 201.** The job already exists. A second POST creates a duplicate job record.

---

## Customer-facing wording

**Use:**

- "preferred appointment window"
- "secure your preferred appointment window"
- "your appointment window is reserved"
- "we'll confirm once a contractor is assigned"

**Avoid:**

- "appointment confirmed"
- "scheduled appointment"
- "guaranteed appointment time"

**Reason:** The selected date and window represent the customer's preference. The window is not confirmed until payment is complete and a contractor has been assigned and accepted the job.

---

## POST /public/bookings request

```json
{
  "firstName": "Jane",
  "lastName": "Smith",
  "email": "jane@example.com",
  "phone": "(404) 555-1234",
  "addressLine1": "123 Main St",
  "city": "Hampton",
  "state": "GA",
  "postalCode": "30228",
  "serviceType": "small",
  "rushType": "No Rush",
  "appointmentDate": "2026-06-15",
  "appointmentWindow": "Morning(8am-12pm)",
  "paymentType": "deposit"
}
```

**Valid `serviceType` values:**

- `small`
- `medium`
- `large`
- `treadmill`

**Valid `appointmentWindow` values (exact strings):**

- `Morning(8am-12pm)`
- `Afternoon(12pm-4pm)`
- `Evening(4pm-8pm)`

**Field notes:**

- `state` defaults to `"GA"` server-side if omitted. Must be exactly 2 uppercase characters if provided.
- `rushType` defaults to `"No Rush"` if omitted. Valid values: `"No Rush"`, `"Same-day (+30)"`, `"Next-day (+20)"`.
- `paymentType` defaults to `"deposit"` if omitted. Valid values: `"deposit"`, `"full"`.
- `postalCode` is optional.
- `customJobDetails` is optional.
- The schema is **strict**. Do not send any undeclared fields.

---

## POST /public/bookings 201 response

```json
{
  "jobKey": "AC-2026-ABCD",
  "publicPayToken": "ppt_abc123xyz",
  "status": "awaiting_payment",
  "serviceAreaStatus": "in_area",
  "totalAmountCents": 10900,
  "checkoutRequired": true
}
```

- `publicPayToken` is the token used to poll `GET /jobs/pay/:publicPayToken`.
- `checkoutRequired: true` signals that polling should begin.
- `totalAmountCents` is in cents. Divide by 100 for display.

---

## GET /jobs/pay/:publicPayToken response

**Pending — `checkoutUrl` not yet available:**

```json
{
  "jobKey": "AC-2026-ABCD",
  "status": "awaiting_payment",
  "customerName": "Jane Smith",
  "serviceType": "Small Assembly",
  "rushRequested": false,
  "appointmentDate": "2026-06-15T00:00:00.000Z",
  "appointmentWindow": "Morning(8am-12pm)",
  "totalAmountCents": 10900,
  "depositAmountCents": 5450,
  "remainderAmountCents": 5450,
  "paymentMode": "deposit",
  "checkoutUrl": null
}
```

**Ready — `checkoutUrl` available:**

```json
{
  "jobKey": "AC-2026-ABCD",
  "status": "awaiting_payment",
  "customerName": "Jane Smith",
  "serviceType": "Small Assembly",
  "rushRequested": false,
  "appointmentDate": "2026-06-15T00:00:00.000Z",
  "appointmentWindow": "Morning(8am-12pm)",
  "totalAmountCents": 10900,
  "depositAmountCents": 5450,
  "remainderAmountCents": 5450,
  "paymentMode": "deposit",
  "checkoutUrl": "https://checkout.stripe.com/pay/cs_live_..."
}
```

**Notes:**

- `appointmentDate` may serialize as a full ISO timestamp (midnight UTC). Display the date portion only — do not show the time component.
- `paymentMode` is `"deposit"` or `"full"`. Use it to determine which amount to display as due: `depositAmountCents` for `"deposit"`, `totalAmountCents` for `"full"`.
- The endpoint returns `404` if the token is invalid or the job does not exist. Stop polling and show a support message if this occurs.

---

## POST /public/review-requests request

```json
{
  "firstName": "Jane",
  "lastName": "Smith",
  "email": "jane@example.com",
  "phone": "(404) 555-1234",
  "addressLine1": "123 Main St",
  "city": "Hampton",
  "state": "GA",
  "serviceType": "small",
  "reviewReason": "slot_full_manual_review",
  "details": "The June 15 morning window was full. I'd like to be considered for that time.",
  "appointmentDate": "2026-06-15",
  "appointmentWindow": "Morning(8am-12pm)"
}
```

**Valid `reviewReason` values:**

- `custom_job`
- `fitness_equipment`
- `slot_full_manual_review`
- `other_uncertain`

**Field notes:**

- `details` is **required** (minimum 1 character).
- `appointmentDate` and `appointmentWindow` are both optional. Send both or neither. Sending `appointmentWindow` without `appointmentDate` returns `400 MISSING_APPOINTMENT_DATE`.
- The schema is **strict**. Do not send any undeclared fields.

---

## POST /public/review-requests 201 response

```json
{
  "requestId": "AC-2026-ABCD",
  "status": "received",
  "message": "Your request was received for manual review.",
  "correlationId": "..."
}
```

- `requestId` is the job key. Display it as a reference number for the customer.
- No `publicPayToken` is returned. No polling. No payment step follows.

---

## Error handling

| HTTP | `error` | Frontend action |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Map `details.fieldErrors[fieldName]` to inline messages per field. Map `details.formErrors[]` to a top-level banner. |
| 400 | `INVALID_APPOINTMENT_DATE` | Inline on the date field: "Please enter a valid calendar date." |
| 400 | `PAST_APPOINTMENT_DATE` | Inline on the date field: "Date must be today or in the future." |
| 400 | `MISSING_APPOINTMENT_DATE` | Inline on the date field: "A date is required when a window is selected." |
| 409 | `APPOINTMENT_SLOT_UNAVAILABLE` | Show both recovery options (choose another window / request anyway). Do not dismiss the form. |
| 422 | `SAME_DAY_UNAVAILABLE` | "Same-day online booking is not available. Please select a future date." Re-enable the date field only. |
| 422 | `UNSUPPORTED_SERVICE_AREA` | "Instant online booking isn't available in this city." Offer a CTA to the manual review form. |
| 429 | `RATE_LIMITED` | "Too many attempts — please wait a minute and try again." Disable the submit button for 60 seconds. |
| 5xx | any / none | "Something went wrong. Please try again or contact us." Surface the `correlationId` from the response body in fine print for support reference. |

For all non-field errors, include the `correlationId` from the response body in the UI. Customers quoting this value in support conversations allows the operator to locate the exact job and audit trail.

---

## What not to build yet

The following are **not supported by the current backend** and should not be built:

- Customer account or booking status portal
- Customer-initiated reschedule or cancellation flow
- Email payment link delivery (no email infrastructure exists)
- Short or branded checkout links (raw Stripe URLs are used)
- Real-time availability prefetch calendar (use the `409` response as the capacity signal)
- Customer-facing remainder payment flow (admin-initiated only)
- Frontend payment method selection UI (Stripe checkout handles card input)
- Manual-review request status tracking for customers (customers wait for direct outreach)
