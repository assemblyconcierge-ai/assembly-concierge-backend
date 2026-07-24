# INTERNAL OPERATIONS — NOT FOR PORTFOLIO OR PUBLIC DISTRIBUTION

## Verified production test-data cleanup inventory

**Snapshot date:** 2026-07-24
**Status:** Historical test records verified; cleanup not executed
**Distribution:** Internal operations only

These records were created before Assembly Concierge went live and are not expected to affect normal operations. The PostgreSQL inventory was verified using read-only transactions. The corresponding Airtable job records were separately checked and were no longer present, so the PostgreSQL `airtable_record_id` values below are stale mappings.

This document is not authorization to run the SQL. A new production read-only precondition check and a current recovery check are required immediately before any future execution.

## Isolated job graph allowlist

| PostgreSQL job UUID | PostgreSQL payment UUID | PostgreSQL address UUID | PostgreSQL customer UUID | Protected intake UUID | Stale Airtable record ID |
|---|---|---|---|---|---|
| `054c27d3-0d8a-4c42-8926-79ad7b7fbb2a` | `71254304-4695-4b78-b227-f132bd85fd0e` | `5220a103-e6bf-4458-9a77-ac47d71741fc` | `fe8a8041-4e7f-45d5-b0c3-f9c3e9fe688e` | `dddba90a-81d3-40b1-aba3-4d0f90f9ae1f` | `recC4TVJFS3VclAVF` |
| `18555f37-8c4c-49d5-97bc-bdc88f785a3a` | `0a3f533e-e908-4676-adec-1843ce7adfba` | `60a86cf9-c220-4593-a154-479fc64a0fa5` | `c3cb7fbb-b216-4070-b8a7-378651f1aeeb` | `b2ebce3c-d696-436f-93a1-868c4e270e9d` | `rechCc6YjYYKu32Lj` |
| `c162282e-bd65-4ee0-b859-1833b1dd9694` | `cf71eaeb-d78a-4bc0-ba77-9a528c714e20` | `64bfd69e-1d5e-4210-b801-bd689847581f` | `c3cb7fbb-b216-4070-b8a7-378651f1aeeb` | `ae344775-f13e-4e20-9705-6a2af4246f2e` | `recVr1whPuRCAgdh5` |
| `6d239699-f6f9-47f2-a529-b940959b1e96` | `b9ae9933-725e-4e9b-afb1-1b7c4a8eece3` | `7100f973-6fa5-43d4-99d7-587d88c867df` | `9865ce6b-abf0-43ea-837e-85566bce091b` | `62758a5d-ca6f-4ebc-a716-ed911ae81c0e` | `recfUPcB9j3M1HmXK` |
| `66330214-1a94-4e60-af19-192745ae612f` | `596a4e4f-fed4-4b07-a1e5-675a8780e886` | `0539daae-50cb-49a1-bfaf-275ec987823a` | `9865ce6b-abf0-43ea-837e-85566bce091b` | `c784cfb3-ab57-4e40-8a23-2c121fbbdf59` | `receKSw0JEouKcH7a` |
| `989a3f7f-3979-401a-b493-ba2788bc84b5` | `1f50f06c-5ca2-46f1-89b2-404248acaf75` | `1b16e8bc-274f-4d90-b3f8-6b5923143708` | `c3cb7fbb-b216-4070-b8a7-378651f1aeeb` | `d4e0282b-f81d-4f4c-a899-c3168b764e46` | `recK2ghLWzDc2uUlj` |
| `8f1ebc0a-1cf1-4f18-98b5-17c0514bf3ec` | `a67c405a-d686-49e5-b789-e55f9b8eca0e` | `91aa827a-8c6d-4a40-ab6b-9c887b469d2f` | `891b4154-3c1e-4cc3-8e5f-c6732eff66c3` | `5c51e077-472e-4967-bc31-804a3ba7a79f` | `rec0CHQwyEgWyQSUb` |
| `821a8d69-1046-4bd6-a918-a93c27347c7a` | `dff798cc-1212-4b88-a365-1f6b55dd9da7` | `43acfb77-d072-45eb-8628-73d20fcb1774` | `61ea5710-25cd-4397-b0c4-69e4b5e8e944` | `b940dcec-fd0e-44ed-a432-16894516efac` | `recHDkqbZKWJJMdxy` |
| `4de7811f-1234-4ce8-b1bd-39c988d7880d` | `2d1cb539-d99a-4093-88a1-ed27190b1701` | `18eeae9c-ce27-4208-b161-c2c391f6cd95` | `891b4154-3c1e-4cc3-8e5f-c6732eff66c3` | `398d12cc-c7d3-4fb1-b3a8-46a159456ec3` | `rec0xH8Q0ZaDqBTG3` |
| `3397a340-dcba-45c6-97ad-92320822a89f` | `f5fc7111-9542-43a0-8a76-c5e8ea84d650` | `2dfd0994-ba68-48c5-8f52-21066aaca40d` | `8d5c94d0-4d6d-49c1-ac12-306c3b05f671` | `fc8996f4-228e-49a2-932d-e55599fffd06` | `recHjkauAtrz50KqU` |
| `5ec272a0-cc02-4686-8ae4-0f2bbe674183` | `d35e23b0-31aa-4272-813f-6ae88aee9b2c` | `61c525f3-ff41-4db6-ba23-01bca294f29e` | `8d5c94d0-4d6d-49c1-ac12-306c3b05f671` | `8d07f939-b6e3-412e-b660-7576f64084c2` | `rec4mnTGOmXGUpJyD` |
| `4b5dc186-35c4-4a92-abe1-90bc35e30c0a` | `2a3a6dbc-ebc6-4b6a-8ace-e1733e809c5c` | `32add140-97a5-40bf-8c68-9b63281599c3` | `8d5c94d0-4d6d-49c1-ac12-306c3b05f671` | `09705205-6387-4294-a58d-d282a387da0b` | `recVf1wiYgBLTw7qW` |
| `5886569d-76a4-49ff-91b5-d7295110043f` | `137841eb-d984-4804-bb39-bce039600879` | `106171ce-afd1-4c7e-8f19-59e7a5200cee` | `8d5c94d0-4d6d-49c1-ac12-306c3b05f671` | `2fcbff24-02f8-4309-97fc-a79da3073342` | `recP95Ab7vYUh3vmy` |
| `d8de6450-aea3-49de-bdaa-07b2eb7d0ea3` | `46d2479e-816b-42b7-9141-a063fa904283` | `836bff24-59bb-481b-bcea-c915c5d6174b` | `8d5c94d0-4d6d-49c1-ac12-306c3b05f671` | `14a9fb3d-cef7-40c2-8575-d825585d6a2c` | `recyRkzzitN9jPd8i` |
| `1c1ad3cc-be30-425c-9003-0593bb9720b2` | `5116ddba-e8d3-4ee5-9ae2-c1c2bd3e939c` | `5c97a850-8442-4c01-8b26-2cd490eace65` | `c3cb7fbb-b216-4070-b8a7-378651f1aeeb` | `59287063-cc5a-484e-9315-c7dfb6608ade` | `recnKXQVuXdLO8WxU` |
| `4a5b5a57-d994-48b8-a295-72b9a97028a7` | `6a4590e5-398b-4a62-93c0-2fccdeff11a4` | `206cda2c-b4a6-4073-a637-241075f29415` | `9865ce6b-abf0-43ea-837e-85566bce091b` | `7f8386ef-cc71-48ce-93dd-2f9896115e2b` | `recqzsuKWxZcIaA2y` |
| `6983bf46-17b7-4c15-881b-5ff8e3f45da9` | `b79819ec-805b-406c-b7fe-2dd90ef648bf` | `f6ac929e-8a6d-4292-9e15-4514437c3937` | `9865ce6b-abf0-43ea-837e-85566bce091b` | `b4d5574a-c487-4eab-bb5c-9aca62e6d556` | `recb0pjfg1qpP5ztG` |
| `fa01b0de-864b-405d-9e7e-dafc649b495d` | `69b134ad-520c-4acc-addd-da1ee3f751bd` | `255cb148-f012-4e13-8078-458813317cd6` | `c3cb7fbb-b216-4070-b8a7-378651f1aeeb` | `f96c7d94-0f3e-4c1b-8ef6-6f75797a363c` | `reccejXj4MZvzGAIA` |
| `5da04fa3-d059-4fd2-81b6-970f8cd510d0` | `ae1b4d6d-8eba-4501-b266-31d389b732e9` | `c07a2b95-d209-4424-89ce-a06897ea77b0` | `c3cb7fbb-b216-4070-b8a7-378651f1aeeb` | `99be6523-1cef-4325-917c-7f12216cdf63` | `recy9OraD4mXIOv7P` |
| `09fc4f9b-54fe-479d-96ff-28217e21407e` | `733c5042-0fa4-43ed-be8b-1802ac1ca3e5` | `9e8c7a85-3443-4b91-9437-25b6b177edd8` | `9865ce6b-abf0-43ea-837e-85566bce091b` | `5eec4559-7a89-485e-8553-64518e46fb1e` | `recp6XTeQY1UH0Fy5` |
| `7bf95def-c3e9-48e9-a1da-1c6c2fc9ba68` | `8b1cd368-0788-464e-a9a5-e3e550d83733` | `c4f9d9aa-d07e-44c2-91e2-6018316e3628` | `9865ce6b-abf0-43ea-837e-85566bce091b` | `3f5dac7b-8ae5-4560-a281-256e7c62c382` | `reczbqEAuaUpgGAk1` |
| `106acebe-28ab-4ff1-ab29-d5bae4f2e828` | `e4044f6c-70f7-497f-8f74-4b4795107c9f` | `dbbc0734-dfc8-49c8-94a2-ed7341c46c88` | `49f1bb30-d953-4f19-bc40-515fc7546bcd` | `e0a61b77-aa9c-47e0-9f75-6e7fd86e1318` | `reclQoFVnyg0MpDJc` |
| `eaf87ed8-79d0-4a66-ba85-c4baec52aace` | `8d4d09ed-9c53-4aef-9dcb-01ee86ef3ed9` | `7bdc3ea1-1273-4342-9c31-a828fc04f567` | `49f1bb30-d953-4f19-bc40-515fc7546bcd` | `04ebc0f5-a05f-418c-87cb-e033c866795c` | `recxStgcQiOSfx6rd` |
| `5719db16-c2b2-47e5-9cf2-f41981641df7` | `4827955f-eac2-4441-8e73-5511fc4cb89e` | `71577f0b-11d0-450c-85f2-9e6c1098b6aa` | `9865ce6b-abf0-43ea-837e-85566bce091b` | `8b580d9d-6b8a-46d9-bf15-9b62dcb48700` | `recoOMD4OTxUraWMB` |
| `e66cbc85-7e39-4c15-ab3c-72967e91417c` | `b1e951c1-ef86-4cfb-a28d-9cec281abf0e` | `2553e66a-4244-4282-a51a-09ed075dc1bf` | `49f1bb30-d953-4f19-bc40-515fc7546bcd` | `e82fa649-80ab-42fd-b011-204e482d6227` | `recVmBXHUe3Jnpg6r` |

## Customer deletion allowlist

These four customers become fully isolated only after the complete 25-job allowlist is removed:

- `fe8a8041-4e7f-45d5-b0c3-f9c3e9fe688e`
- `891b4154-3c1e-4cc3-8e5f-c6732eff66c3`
- `61ea5710-25cd-4397-b0c4-69e4b5e8e944`
- `8d5c94d0-4d6d-49c1-ac12-306c3b05f671`

## Standalone payment-only allowlist

These payment rows may be removed without deleting their parent jobs:

- `353795a2-1a9e-4d59-86f2-0e73376d7d6b`
- `821a335d-92bf-4314-a249-383334463cc9`
- `1f55d14e-e3e9-4406-930a-8f0e9f9ea49f`
- `b05aca9e-1eac-4fed-b661-0b31a146f0a9`
- `071f3a1a-d76c-4e84-87da-cb1ff66a00cf`
- `fd59eb4c-6a08-4f00-a795-c60bcb5564df`

## Expected deletion counts

| Table | Expected rows deleted |
|---|---:|
| `payments` | 31 |
| `jobs` | 25 |
| `addresses` | 25 |
| `customers` | 4 |
| Every other table | 0 |

## Mandatory preservation rules

The following must remain unchanged:

- All `intake_submissions`, including the 25 protected intake UUIDs in the allowlist table.
- All `audit_events`, including the 59 textual job audit references associated with the 25 jobs.
- All `payment_events`.
- Every payment referenced by a `payment_events` row.
- The two retained-contractor-graph payments:
  - `d80f8184-15f6-4f43-9434-09de363eba8c`
  - `82fb88fc-2f62-463d-831f-3acee6de9dec`
- The six retained contractors:
  - `b19c3eb4-272c-469a-9878-7bda99f2594c`
  - `26fd1f3d-f794-4c0d-b2e4-7e61283d2b1c`
  - `4c3cefe5-d9f6-40ff-b0b6-373e6b796423`
  - `159da83a-1e90-47be-a153-d514f1bda68e`
  - `1a2dbfeb-7707-4651-adf3-ceaef8995711`
  - `8413330e-f4ff-4424-981e-5a415e283046`
- Every dependency closure belonging to those retained contractors.
- All `contractor_onboarding_documents`.
- All unresolved `integration_failures`.
- All sent notifications and email events.
- All webhook, idempotency, replay, token, and reconciliation protection records.

## Mandatory backup and recovery gate

Before any future execution:

1. Open the database's **Recovery** page in the Render Dashboard.
2. Confirm that an active point-in-time recovery window is available, or create a logical export and wait for it to complete.
3. Record the recovery/export timestamp in the change record.
4. Perform a new production read-only precondition inventory.
5. Compare the new inventory to every assertion in the SQL below.
6. Do not execute if any count, relationship, or UUID differs.

Render currently documents PITR for paid Postgres instances and on-demand logical exports. Free instances do not have Render-managed recovery features. See [Render Postgres Recovery and Backups](https://render.com/docs/postgresql-backups).

## DO NOT RUN WITHOUT A NEW READ-ONLY PRECONDITION CHECK

The SQL below is retained only as a guarded historical cleanup procedure. It uses explicit UUID allowlists, serializable isolation, table locks, exact count assertions, affected-row assertions, and postconditions. Any mismatch raises an exception and rolls back the transaction.

```sql
BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL idle_in_transaction_session_timeout = '5min';

SELECT pg_advisory_xact_lock(
    hashtext('assembly-concierge-verified-cleanup-2026-07-24')
);

CREATE TEMP TABLE cleanup_job_allowlist (
    job_id uuid PRIMARY KEY,
    payment_id uuid UNIQUE NOT NULL,
    address_id uuid UNIQUE NOT NULL,
    customer_id uuid NOT NULL,
    intake_submission_id uuid UNIQUE NOT NULL,
    airtable_record_id text NOT NULL
) ON COMMIT DROP;

INSERT INTO cleanup_job_allowlist (
    job_id,
    payment_id,
    address_id,
    customer_id,
    intake_submission_id,
    airtable_record_id
)
VALUES
('054c27d3-0d8a-4c42-8926-79ad7b7fbb2a','71254304-4695-4b78-b227-f132bd85fd0e','5220a103-e6bf-4458-9a77-ac47d71741fc','fe8a8041-4e7f-45d5-b0c3-f9c3e9fe688e','dddba90a-81d3-40b1-aba3-4d0f90f9ae1f','recC4TVJFS3VclAVF'),
('18555f37-8c4c-49d5-97bc-bdc88f785a3a','0a3f533e-e908-4676-adec-1843ce7adfba','60a86cf9-c220-4593-a154-479fc64a0fa5','c3cb7fbb-b216-4070-b8a7-378651f1aeeb','b2ebce3c-d696-436f-93a1-868c4e270e9d','rechCc6YjYYKu32Lj'),
('c162282e-bd65-4ee0-b859-1833b1dd9694','cf71eaeb-d78a-4bc0-ba77-9a528c714e20','64bfd69e-1d5e-4210-b801-bd689847581f','c3cb7fbb-b216-4070-b8a7-378651f1aeeb','ae344775-f13e-4e20-9705-6a2af4246f2e','recVr1whPuRCAgdh5'),
('6d239699-f6f9-47f2-a529-b940959b1e96','b9ae9933-725e-4e9b-afb1-1b7c4a8eece3','7100f973-6fa5-43d4-99d7-587d88c867df','9865ce6b-abf0-43ea-837e-85566bce091b','62758a5d-ca6f-4ebc-a716-ed911ae81c0e','recfUPcB9j3M1HmXK'),
('66330214-1a94-4e60-af19-192745ae612f','596a4e4f-fed4-4b07-a1e5-675a8780e886','0539daae-50cb-49a1-bfaf-275ec987823a','9865ce6b-abf0-43ea-837e-85566bce091b','c784cfb3-ab57-4e40-8a23-2c121fbbdf59','receKSw0JEouKcH7a'),
('989a3f7f-3979-401a-b493-ba2788bc84b5','1f50f06c-5ca2-46f1-89b2-404248acaf75','1b16e8bc-274f-4d90-b3f8-6b5923143708','c3cb7fbb-b216-4070-b8a7-378651f1aeeb','d4e0282b-f81d-4f4c-a899-c3168b764e46','recK2ghLWzDc2uUlj'),
('8f1ebc0a-1cf1-4f18-98b5-17c0514bf3ec','a67c405a-d686-49e5-b789-e55f9b8eca0e','91aa827a-8c6d-4a40-ab6b-9c887b469d2f','891b4154-3c1e-4cc3-8e5f-c6732eff66c3','5c51e077-472e-4967-bc31-804a3ba7a79f','rec0CHQwyEgWyQSUb'),
('821a8d69-1046-4bd6-a918-a93c27347c7a','dff798cc-1212-4b88-a365-1f6b55dd9da7','43acfb77-d072-45eb-8628-73d20fcb1774','61ea5710-25cd-4397-b0c4-69e4b5e8e944','b940dcec-fd0e-44ed-a432-16894516efac','recHDkqbZKWJJMdxy'),
('4de7811f-1234-4ce8-b1bd-39c988d7880d','2d1cb539-d99a-4093-88a1-ed27190b1701','18eeae9c-ce27-4208-b161-c2c391f6cd95','891b4154-3c1e-4cc3-8e5f-c6732eff66c3','398d12cc-c7d3-4fb1-b3a8-46a159456ec3','rec0xH8Q0ZaDqBTG3'),
('3397a340-dcba-45c6-97ad-92320822a89f','f5fc7111-9542-43a0-8a76-c5e8ea84d650','2dfd0994-ba68-48c5-8f52-21066aaca40d','8d5c94d0-4d6d-49c1-ac12-306c3b05f671','fc8996f4-228e-49a2-932d-e55599fffd06','recHjkauAtrz50KqU'),
('5ec272a0-cc02-4686-8ae4-0f2bbe674183','d35e23b0-31aa-4272-813f-6ae88aee9b2c','61c525f3-ff41-4db6-ba23-01bca294f29e','8d5c94d0-4d6d-49c1-ac12-306c3b05f671','8d07f939-b6e3-412e-b660-7576f64084c2','rec4mnTGOmXGUpJyD'),
('4b5dc186-35c4-4a92-abe1-90bc35e30c0a','2a3a6dbc-ebc6-4b6a-8ace-e1733e809c5c','32add140-97a5-40bf-8c68-9b63281599c3','8d5c94d0-4d6d-49c1-ac12-306c3b05f671','09705205-6387-4294-a58d-d282a387da0b','recVf1wiYgBLTw7qW'),
('5886569d-76a4-49ff-91b5-d7295110043f','137841eb-d984-4804-bb39-bce039600879','106171ce-afd1-4c7e-8f19-59e7a5200cee','8d5c94d0-4d6d-49c1-ac12-306c3b05f671','2fcbff24-02f8-4309-97fc-a79da3073342','recP95Ab7vYUh3vmy'),
('d8de6450-aea3-49de-bdaa-07b2eb7d0ea3','46d2479e-816b-42b7-9141-a063fa904283','836bff24-59bb-481b-bcea-c915c5d6174b','8d5c94d0-4d6d-49c1-ac12-306c3b05f671','14a9fb3d-cef7-40c2-8575-d825585d6a2c','recyRkzzitN9jPd8i'),
('1c1ad3cc-be30-425c-9003-0593bb9720b2','5116ddba-e8d3-4ee5-9ae2-c1c2bd3e939c','5c97a850-8442-4c01-8b26-2cd490eace65','c3cb7fbb-b216-4070-b8a7-378651f1aeeb','59287063-cc5a-484e-9315-c7dfb6608ade','recnKXQVuXdLO8WxU'),
('4a5b5a57-d994-48b8-a295-72b9a97028a7','6a4590e5-398b-4a62-93c0-2fccdeff11a4','206cda2c-b4a6-4073-a637-241075f29415','9865ce6b-abf0-43ea-837e-85566bce091b','7f8386ef-cc71-48ce-93dd-2f9896115e2b','recqzsuKWxZcIaA2y'),
('6983bf46-17b7-4c15-881b-5ff8e3f45da9','b79819ec-805b-406c-b7fe-2dd90ef648bf','f6ac929e-8a6d-4292-9e15-4514437c3937','9865ce6b-abf0-43ea-837e-85566bce091b','b4d5574a-c487-4eab-bb5c-9aca62e6d556','recb0pjfg1qpP5ztG'),
('fa01b0de-864b-405d-9e7e-dafc649b495d','69b134ad-520c-4acc-addd-da1ee3f751bd','255cb148-f012-4e13-8078-458813317cd6','c3cb7fbb-b216-4070-b8a7-378651f1aeeb','f96c7d94-0f3e-4c1b-8ef6-6f75797a363c','reccejXj4MZvzGAIA'),
('5da04fa3-d059-4fd2-81b6-970f8cd510d0','ae1b4d6d-8eba-4501-b266-31d389b732e9','c07a2b95-d209-4424-89ce-a06897ea77b0','c3cb7fbb-b216-4070-b8a7-378651f1aeeb','99be6523-1cef-4325-917c-7f12216cdf63','recy9OraD4mXIOv7P'),
('09fc4f9b-54fe-479d-96ff-28217e21407e','733c5042-0fa4-43ed-be8b-1802ac1ca3e5','9e8c7a85-3443-4b91-9437-25b6b177edd8','9865ce6b-abf0-43ea-837e-85566bce091b','5eec4559-7a89-485e-8553-64518e46fb1e','recp6XTeQY1UH0Fy5'),
('7bf95def-c3e9-48e9-a1da-1c6c2fc9ba68','8b1cd368-0788-464e-a9a5-e3e550d83733','c4f9d9aa-d07e-44c2-91e2-6018316e3628','9865ce6b-abf0-43ea-837e-85566bce091b','3f5dac7b-8ae5-4560-a281-256e7c62c382','reczbqEAuaUpgGAk1'),
('106acebe-28ab-4ff1-ab29-d5bae4f2e828','e4044f6c-70f7-497f-8f74-4b4795107c9f','dbbc0734-dfc8-49c8-94a2-ed7341c46c88','49f1bb30-d953-4f19-bc40-515fc7546bcd','e0a61b77-aa9c-47e0-9f75-6e7fd86e1318','reclQoFVnyg0MpDJc'),
('eaf87ed8-79d0-4a66-ba85-c4baec52aace','8d4d09ed-9c53-4aef-9dcb-01ee86ef3ed9','7bdc3ea1-1273-4342-9c31-a828fc04f567','49f1bb30-d953-4f19-bc40-515fc7546bcd','04ebc0f5-a05f-418c-87cb-e033c866795c','recxStgcQiOSfx6rd'),
('5719db16-c2b2-47e5-9cf2-f41981641df7','4827955f-eac2-4441-8e73-5511fc4cb89e','71577f0b-11d0-450c-85f2-9e6c1098b6aa','9865ce6b-abf0-43ea-837e-85566bce091b','8b580d9d-6b8a-46d9-bf15-9b62dcb48700','recoOMD4OTxUraWMB'),
('e66cbc85-7e39-4c15-ab3c-72967e91417c','b1e951c1-ef86-4cfb-a28d-9cec281abf0e','2553e66a-4244-4282-a51a-09ed075dc1bf','49f1bb30-d953-4f19-bc40-515fc7546bcd','e82fa649-80ab-42fd-b011-204e482d6227','recVmBXHUe3Jnpg6r');

CREATE TEMP TABLE cleanup_standalone_payment_allowlist (
    payment_id uuid PRIMARY KEY,
    parent_job_id uuid UNIQUE NOT NULL
) ON COMMIT DROP;

INSERT INTO cleanup_standalone_payment_allowlist (payment_id, parent_job_id)
VALUES
('353795a2-1a9e-4d59-86f2-0e73376d7d6b','24dcca9f-650c-4d9c-a86a-39ce8e9a54d9'),
('821a335d-92bf-4314-a249-383334463cc9','fb4c2d62-279c-4f6f-a009-8a6a0af6f108'),
('1f55d14e-e3e9-4406-930a-8f0e9f9ea49f','98b25e74-9c4d-4f7e-87c8-5ea4733ba106'),
('b05aca9e-1eac-4fed-b661-0b31a146f0a9','50ba217f-35c5-46a3-87b9-61eee7fa1781'),
('071f3a1a-d76c-4e84-87da-cb1ff66a00cf','ef087cf5-22ed-4b13-a41f-cb66f4a7747e'),
('fd59eb4c-6a08-4f00-a795-c60bcb5564df','d2d13ce2-a017-4a70-8fda-b72d5b64b45f');

CREATE TEMP TABLE cleanup_customer_allowlist (
    customer_id uuid PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO cleanup_customer_allowlist (customer_id)
VALUES
('fe8a8041-4e7f-45d5-b0c3-f9c3e9fe688e'),
('891b4154-3c1e-4cc3-8e5f-c6732eff66c3'),
('61ea5710-25cd-4397-b0c4-69e4b5e8e944'),
('8d5c94d0-4d6d-49c1-ac12-306c3b05f671');

CREATE TEMP TABLE cleanup_retained_contractor_allowlist (
    contractor_id uuid PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO cleanup_retained_contractor_allowlist (contractor_id)
VALUES
('b19c3eb4-272c-469a-9878-7bda99f2594c'),
('26fd1f3d-f794-4c0d-b2e4-7e61283d2b1c'),
('4c3cefe5-d9f6-40ff-b0b6-373e6b796423'),
('159da83a-1e90-47be-a153-d514f1bda68e'),
('1a2dbfeb-7707-4651-adf3-ceaef8995711'),
('8413330e-f4ff-4424-981e-5a415e283046');

CREATE TEMP TABLE cleanup_retained_payment_allowlist (
    payment_id uuid PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO cleanup_retained_payment_allowlist (payment_id)
VALUES
('d80f8184-15f6-4f43-9434-09de363eba8c'),
('82fb88fc-2f62-463d-831f-3acee6de9dec');

LOCK TABLE
    payment_events,
    payments,
    dispatches,
    contractor_assignments,
    uploaded_media,
    email_events,
    notifications,
    integration_failures,
    jobs,
    addresses,
    customers,
    intake_submissions,
    audit_events,
    contractors
IN SHARE ROW EXCLUSIVE MODE NOWAIT;

DO $preconditions$
DECLARE
    n bigint;
BEGIN
    SELECT count(*) INTO n FROM cleanup_job_allowlist;
    IF n <> 25 THEN
        RAISE EXCEPTION 'Expected 25 job allowlist rows, found %', n;
    END IF;

    SELECT count(*) INTO n FROM cleanup_standalone_payment_allowlist;
    IF n <> 6 THEN
        RAISE EXCEPTION 'Expected 6 standalone payment rows, found %', n;
    END IF;

    SELECT count(*) INTO n FROM cleanup_customer_allowlist;
    IF n <> 4 THEN
        RAISE EXCEPTION 'Expected 4 customer allowlist rows, found %', n;
    END IF;

    SELECT count(*) INTO n
    FROM cleanup_job_allowlist a
    JOIN jobs j
      ON j.id = a.job_id
     AND j.address_id = a.address_id
     AND j.customer_id = a.customer_id
     AND j.intake_submission_id = a.intake_submission_id
     AND j.airtable_record_id = a.airtable_record_id
    JOIN payments p
      ON p.id = a.payment_id
     AND p.job_id = a.job_id;

    IF n <> 25 THEN
        RAISE EXCEPTION 'Expected 25 exact job/payment pairs, found %', n;
    END IF;

    SELECT count(*) INTO n
    FROM payments p
    JOIN cleanup_job_allowlist a ON a.payment_id = p.id
    WHERE p.amount_paid_cents = 0
      AND p.paid_at IS NULL
      AND p.status::text = 'checkout_created'
      AND p.provider_session_id LIKE 'cs_test_%';

    IF n <> 25 THEN
        RAISE EXCEPTION 'Expected 25 unchanged isolated test payments, found %', n;
    END IF;

    SELECT count(*) INTO n
    FROM payments p
    JOIN cleanup_standalone_payment_allowlist a
      ON a.payment_id = p.id
     AND a.parent_job_id = p.job_id
    WHERE p.amount_paid_cents = 0
      AND p.paid_at IS NULL
      AND p.status::text = 'checkout_created'
      AND p.provider_session_id LIKE 'cs_test_%';

    IF n <> 6 THEN
        RAISE EXCEPTION 'Expected 6 unchanged standalone test payments, found %', n;
    END IF;

    SELECT count(*) INTO n
    FROM cleanup_standalone_payment_allowlist a
    JOIN jobs j ON j.id = a.parent_job_id;

    IF n <> 6 THEN
        RAISE EXCEPTION 'Expected 6 standalone parent jobs, found %', n;
    END IF;

    SELECT count(*) INTO n
    FROM payments p
    JOIN cleanup_job_allowlist a ON a.job_id = p.job_id;

    IF n <> 25 THEN
        RAISE EXCEPTION 'Expected exactly 25 payments on candidate jobs, found %', n;
    END IF;

    SELECT count(*) INTO n
    FROM payment_events pe
    WHERE pe.payment_id IN (
        SELECT payment_id FROM cleanup_job_allowlist
        UNION ALL
        SELECT payment_id FROM cleanup_standalone_payment_allowlist
    );

    IF n <> 0 THEN
        RAISE EXCEPTION 'Candidate payment event count changed: %', n;
    END IF;

    SELECT count(*) INTO n
    FROM dispatches d
    JOIN cleanup_job_allowlist a ON a.job_id = d.job_id;
    IF n <> 0 THEN RAISE EXCEPTION 'Candidate dispatch count changed: %', n; END IF;

    SELECT count(*) INTO n
    FROM contractor_assignments ca
    JOIN cleanup_job_allowlist a ON a.job_id = ca.job_id;
    IF n <> 0 THEN RAISE EXCEPTION 'Candidate assignment count changed: %', n; END IF;

    SELECT count(*) INTO n
    FROM uploaded_media um
    JOIN cleanup_job_allowlist a ON a.job_id = um.job_id;
    IF n <> 0 THEN RAISE EXCEPTION 'Candidate media count changed: %', n; END IF;

    SELECT count(*) INTO n
    FROM email_events ee
    JOIN cleanup_job_allowlist a ON a.job_id = ee.related_job_id;
    IF n <> 0 THEN RAISE EXCEPTION 'Candidate email event count changed: %', n; END IF;

    SELECT count(*) INTO n
    FROM notifications no
    JOIN cleanup_job_allowlist a ON a.job_id = no.job_id;
    IF n <> 0 THEN RAISE EXCEPTION 'Candidate notification count changed: %', n; END IF;

    SELECT count(*) INTO n
    FROM integration_failures f
    WHERE f.related_entity_id IN (
        SELECT job_id::text FROM cleanup_job_allowlist
        UNION ALL
        SELECT payment_id::text FROM cleanup_job_allowlist
        UNION ALL
        SELECT payment_id::text FROM cleanup_standalone_payment_allowlist
    );
    IF n <> 0 THEN RAISE EXCEPTION 'Candidate integration failure count changed: %', n; END IF;

    SELECT count(*) INTO n
    FROM contractor_assignments ca
    JOIN cleanup_job_allowlist j ON j.job_id = ca.job_id
    JOIN cleanup_retained_contractor_allowlist r
      ON r.contractor_id = ca.contractor_id;
    IF n <> 0 THEN RAISE EXCEPTION 'Retained-contractor assignment overlap: %', n; END IF;

    SELECT count(*) INTO n
    FROM dispatches d
    JOIN cleanup_job_allowlist j ON j.job_id = d.job_id
    JOIN cleanup_retained_contractor_allowlist r
      ON r.contractor_id = d.assigned_contractor_id;
    IF n <> 0 THEN RAISE EXCEPTION 'Retained-contractor dispatch overlap: %', n; END IF;

    SELECT count(*) INTO n
    FROM addresses ad
    JOIN cleanup_job_allowlist a ON a.address_id = ad.id;
    IF n <> 25 THEN RAISE EXCEPTION 'Expected 25 addresses, found %', n; END IF;

    SELECT count(*) INTO n
    FROM jobs j
    JOIN cleanup_job_allowlist a ON a.address_id = j.address_id
    WHERE j.id <> a.job_id;
    IF n <> 0 THEN RAISE EXCEPTION 'Candidate addresses gained outside references: %', n; END IF;

    SELECT count(*) INTO n
    FROM customers c
    JOIN cleanup_customer_allowlist a ON a.customer_id = c.id;
    IF n <> 4 THEN RAISE EXCEPTION 'Expected 4 customers, found %', n; END IF;

    SELECT count(*) INTO n
    FROM jobs j
    JOIN cleanup_customer_allowlist c ON c.customer_id = j.customer_id
    JOIN cleanup_job_allowlist a ON a.job_id = j.id;
    IF n <> 9 THEN RAISE EXCEPTION 'Expected 9 candidate jobs for isolated customers, found %', n; END IF;

    SELECT count(*) INTO n
    FROM jobs j
    JOIN cleanup_customer_allowlist c ON c.customer_id = j.customer_id
    LEFT JOIN cleanup_job_allowlist a ON a.job_id = j.id
    WHERE a.job_id IS NULL;
    IF n <> 0 THEN RAISE EXCEPTION 'Candidate customers gained outside references: %', n; END IF;

    SELECT count(*) INTO n
    FROM intake_submissions i
    JOIN cleanup_job_allowlist a ON a.intake_submission_id = i.id;
    IF n <> 25 THEN RAISE EXCEPTION 'Expected 25 protected intakes, found %', n; END IF;

    SELECT count(*) INTO n
    FROM audit_events ae
    WHERE ae.aggregate_type = 'job'
      AND ae.aggregate_id IN (
          SELECT job_id::text FROM cleanup_job_allowlist
      );
    IF n <> 59 THEN RAISE EXCEPTION 'Expected 59 protected audit references, found %', n; END IF;

    SELECT count(*) INTO n FROM payment_events;
    IF n <> 131 THEN RAISE EXCEPTION 'payment_events changed: expected 131, found %', n; END IF;

    SELECT count(DISTINCT p.id) INTO n
    FROM payments p
    JOIN payment_events pe ON pe.payment_id = p.id;
    IF n <> 111 THEN RAISE EXCEPTION 'Replay-protected payments changed: expected 111, found %', n; END IF;

    SELECT count(*) INTO n
    FROM contractors c
    JOIN cleanup_retained_contractor_allowlist r ON r.contractor_id = c.id;
    IF n <> 6 THEN RAISE EXCEPTION 'Retained contractors changed: expected 6, found %', n; END IF;

    SELECT count(*) INTO n
    FROM payments p
    JOIN cleanup_retained_payment_allowlist r ON r.payment_id = p.id;
    IF n <> 2 THEN RAISE EXCEPTION 'Retained payments changed: expected 2, found %', n; END IF;

    SELECT count(*) INTO n
    FROM cleanup_retained_payment_allowlist r
    WHERE r.payment_id IN (
        SELECT payment_id FROM cleanup_job_allowlist
        UNION ALL
        SELECT payment_id FROM cleanup_standalone_payment_allowlist
    );
    IF n <> 0 THEN RAISE EXCEPTION 'Retained payment allowlist overlap: %', n; END IF;
END
$preconditions$;

DO $cleanup$
DECLARE
    n bigint;
BEGIN
    DELETE FROM payments p
    USING cleanup_standalone_payment_allowlist a
    WHERE p.id = a.payment_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 6 THEN RAISE EXCEPTION 'Standalone payments deleted %, expected 6', n; END IF;

    DELETE FROM payments p
    USING cleanup_job_allowlist a
    WHERE p.id = a.payment_id
      AND p.job_id = a.job_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 25 THEN RAISE EXCEPTION 'Isolated payments deleted %, expected 25', n; END IF;

    DELETE FROM jobs j
    USING cleanup_job_allowlist a
    WHERE j.id = a.job_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 25 THEN RAISE EXCEPTION 'Jobs deleted %, expected 25', n; END IF;

    DELETE FROM addresses ad
    USING cleanup_job_allowlist a
    WHERE ad.id = a.address_id
      AND NOT EXISTS (
          SELECT 1 FROM jobs remaining WHERE remaining.address_id = ad.id
      );
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 25 THEN RAISE EXCEPTION 'Addresses deleted %, expected 25', n; END IF;

    DELETE FROM customers c
    USING cleanup_customer_allowlist a
    WHERE c.id = a.customer_id
      AND NOT EXISTS (
          SELECT 1 FROM jobs remaining WHERE remaining.customer_id = c.id
      );
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 4 THEN RAISE EXCEPTION 'Customers deleted %, expected 4', n; END IF;
END
$cleanup$;

DO $postconditions$
DECLARE
    n bigint;
BEGIN
    SELECT count(*) INTO n
    FROM payments p
    WHERE p.id IN (
        SELECT payment_id FROM cleanup_job_allowlist
        UNION ALL
        SELECT payment_id FROM cleanup_standalone_payment_allowlist
    );
    IF n <> 0 THEN RAISE EXCEPTION 'Candidate payments remain: %', n; END IF;

    SELECT count(*) INTO n
    FROM jobs j JOIN cleanup_job_allowlist a ON a.job_id = j.id;
    IF n <> 0 THEN RAISE EXCEPTION 'Candidate jobs remain: %', n; END IF;

    SELECT count(*) INTO n
    FROM addresses ad JOIN cleanup_job_allowlist a ON a.address_id = ad.id;
    IF n <> 0 THEN RAISE EXCEPTION 'Candidate addresses remain: %', n; END IF;

    SELECT count(*) INTO n
    FROM customers c JOIN cleanup_customer_allowlist a ON a.customer_id = c.id;
    IF n <> 0 THEN RAISE EXCEPTION 'Candidate customers remain: %', n; END IF;

    SELECT count(*) INTO n
    FROM cleanup_standalone_payment_allowlist a
    JOIN jobs j ON j.id = a.parent_job_id;
    IF n <> 6 THEN RAISE EXCEPTION 'Standalone parent jobs preserved %, expected 6', n; END IF;

    SELECT count(*) INTO n
    FROM intake_submissions i
    JOIN cleanup_job_allowlist a ON a.intake_submission_id = i.id;
    IF n <> 25 THEN RAISE EXCEPTION 'Protected intakes preserved %, expected 25', n; END IF;

    SELECT count(*) INTO n
    FROM audit_events ae
    WHERE ae.aggregate_type = 'job'
      AND ae.aggregate_id IN (
          SELECT job_id::text FROM cleanup_job_allowlist
      );
    IF n <> 59 THEN RAISE EXCEPTION 'Protected audit references preserved %, expected 59', n; END IF;

    SELECT count(*) INTO n FROM payment_events;
    IF n <> 131 THEN RAISE EXCEPTION 'payment_events preserved %, expected 131', n; END IF;

    SELECT count(DISTINCT p.id) INTO n
    FROM payments p
    JOIN payment_events pe ON pe.payment_id = p.id;
    IF n <> 111 THEN RAISE EXCEPTION 'Replay-protected payments preserved %, expected 111', n; END IF;

    SELECT count(*) INTO n
    FROM payments p
    JOIN cleanup_retained_payment_allowlist r ON r.payment_id = p.id;
    IF n <> 2 THEN RAISE EXCEPTION 'Retained payments preserved %, expected 2', n; END IF;

    SELECT count(*) INTO n
    FROM contractors c
    JOIN cleanup_retained_contractor_allowlist r ON r.contractor_id = c.id;
    IF n <> 6 THEN RAISE EXCEPTION 'Retained contractors preserved %, expected 6', n; END IF;
END
$postconditions$;

SELECT 'candidate_payments_remaining' AS verification,
       count(*)::bigint AS actual,
       0::bigint AS expected
FROM payments p
WHERE p.id IN (
    SELECT payment_id FROM cleanup_job_allowlist
    UNION ALL
    SELECT payment_id FROM cleanup_standalone_payment_allowlist
)
UNION ALL
SELECT 'candidate_jobs_remaining', count(*)::bigint, 0::bigint
FROM jobs j JOIN cleanup_job_allowlist a ON a.job_id = j.id
UNION ALL
SELECT 'candidate_addresses_remaining', count(*)::bigint, 0::bigint
FROM addresses ad JOIN cleanup_job_allowlist a ON a.address_id = ad.id
UNION ALL
SELECT 'candidate_customers_remaining', count(*)::bigint, 0::bigint
FROM customers c JOIN cleanup_customer_allowlist a ON a.customer_id = c.id
UNION ALL
SELECT 'standalone_parent_jobs_preserved', count(*)::bigint, 6::bigint
FROM cleanup_standalone_payment_allowlist a
JOIN jobs j ON j.id = a.parent_job_id
UNION ALL
SELECT 'protected_intakes_preserved', count(*)::bigint, 25::bigint
FROM intake_submissions i
JOIN cleanup_job_allowlist a ON a.intake_submission_id = i.id
UNION ALL
SELECT 'protected_audit_references_preserved', count(*)::bigint, 59::bigint
FROM audit_events ae
WHERE ae.aggregate_type = 'job'
  AND ae.aggregate_id IN (
      SELECT job_id::text FROM cleanup_job_allowlist
  )
UNION ALL
SELECT 'payment_events_preserved', count(*)::bigint, 131::bigint
FROM payment_events
UNION ALL
SELECT 'replay_protected_payments_preserved',
       count(DISTINCT p.id)::bigint,
       111::bigint
FROM payments p
JOIN payment_events pe ON pe.payment_id = p.id
UNION ALL
SELECT 'retained_graph_payments_preserved', count(*)::bigint, 2::bigint
FROM payments p
JOIN cleanup_retained_payment_allowlist r ON r.payment_id = p.id
UNION ALL
SELECT 'retained_contractors_preserved', count(*)::bigint, 6::bigint
FROM contractors c
JOIN cleanup_retained_contractor_allowlist r ON r.contractor_id = c.id
ORDER BY verification;

COMMIT;
```

## Operational note

The allowlists represent verified historical test records. Removing them in the guarded order above is not expected to affect normal operations, provided a new read-only precondition pass produces the same relationships and the backup/recovery gate is satisfied.
