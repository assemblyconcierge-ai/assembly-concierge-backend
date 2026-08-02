# Contractor missing-documents backend

The backend now exposes:

`POST /webhooks/jotform/contractor-missing-documents?token=<JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN>`

The route uses the same query-token security and Jotform body parsing as the full
onboarding webhook. It accepts either a parsed body or Jotform's `rawRequest`
JSON envelope.

## Expected fields

Required hidden/outer fields:

- `contractorRecord` (or webhook key `q34_contractorRecord`): Airtable record ID
- `backendContractor` (or webhook key `q35_backendContractor`): backend UUID
- `submissionID`: Jotform submission ID

Optional outer field: `formID`. When `JOTFORM_MISSING_DOCS_FORM_ID` is configured,
a supplied value must match it.

Optional uploads (semantic key, with supported current-form compatibility key):

- `signedContractorAgreement` (`uploadSigned49`)
- `w9` (`q24_fileupload22`)
- `photoId` (`q29_fileupload27`)
- `insurance` (`q30_fileupload28`)
- `otherDocument` (`q31_fileupload29`)

Optional message keys: `contractorMessage`, `correctionNote`, or
`q40_questionsOr`.

The personalized request link prefills `contractorRecord`, `backendContractor`,
`typeA` (contractor name), `q6_phone4[full]`, `q7_phone5[full]`, and
`q8_email6`. The link contains no signed token or other secret.

## Processing and notification

Each submission ID has durable PostgreSQL file, Airtable, and notification state.
Successful uploads are committed before Airtable is updated. A retry resumes the
failed Airtable or notification phase without re-uploading files. A completed
submission ID is a duplicate; a different correction submission ID is new.

Only successfully supplied document receipt fields are set to true. Omitted
documents do not write false or clear files. Airtable status is set to the
existing valid option `Owner Review Needed`. `Onboarding Documents Accepted`,
activation, contractor status, contact, and dispatch fields are outside the
missing-document write allowlist.

At the start of every Airtable-processing attempt, including Airtable-only
retries, the backend reads only `Onboarding Document Status` and
`Missing Docs Review Status`. It preserves `Approved for Activation Request`,
the potentially intentional administrative/compliance status `Blocked`, and
the operator-controlled review values `Reviewed - Accepted` and
`More Documents Needed`. Otherwise, the single combined PATCH sets
`Onboarding Document Status` to `Owner Review Needed` and
`Missing Docs Review Status` to `Awaiting Review`.

This is a read-before-write safeguard, not a true compare-and-set operation.
An operator edit during the brief interval between the GET and PATCH could be
overwritten. That low-volume race is accepted; no Airtable locking or automation
is added.

Operationally, `Activation Requested` should remain unchecked while
`Missing Docs Review Status` is `Awaiting Review`. The owner should request
activation only after reviewing the replacement documents, setting the review
outcome, and completing the existing manual document-acceptance process. The
backend does not write or clear `Activation Requested`.

After Airtable succeeds, one email is sent to `MISSING_DOCS_NOTIFICATION_EMAIL`.
It lists successes and failures and explicitly says manual review is required.
In `EMAIL_SEND_MODE=log_only`, the notification is rendered and durably recorded
as logged without calling Resend.

## Production configuration still required

This code does not configure production. Before enabling the flow:

1. Create the separate Jotform and map the fields above.
2. Set its webhook URL and existing query token.
3. Set `JOTFORM_MISSING_DOCS_FORM_ID` and `MISSING_DOCS_NOTIFICATION_EMAIL`.
4. Deploy so migration `023_contractor_missing_document_submissions.sql` runs.
5. Verify the Airtable `Onboarding Document Status` option `Owner Review Needed`
   remains available.

Until `JOTFORM_MISSING_DOCS_FORM_ID` is set, the existing missing-documents email
continues to link to the full onboarding form.
