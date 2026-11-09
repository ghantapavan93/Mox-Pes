# CRM connectors — FieldRoutes-compatible, read-only

Synthetic and independent. The connector talks to this app's own mock, built from public
FieldRoutes documentation (research/17-fieldroutes-api-contract.md) and filled with the synthetic
world. Nothing here has called, or is authorized to call, a real FieldRoutes tenant.

## Pieces

| File | Role |
|---|---|
| `types.ts` | Provider-neutral `CrmConnector`: `capabilities`, `validateConnection`, `listOffices`, `search(entity, {officeId, updatedFrom, updatedTo, idsAfter})`, `get(entity, {officeId, ids})` |
| `errors.ts` | `AuthError` (never retried), `RateLimitError` (`retryAfterMs`), `TimeoutError`, `UnavailableError`, `ProtocolError` (never retried), `BadRecordError` (per record, as a value) |
| `fieldroutes-client.ts` | `FieldRoutesHttpClient`: real HTTP over an injectable `fetch`, timeout, paging, classification, call trace. No write methods exist |
| `config.ts` | Connector rows; credentials resolved from env-var NAMES (`FIELDROUTES_KEY_{officeId}` / `FIELDROUTES_TOKEN_{officeId}`) |
| `demo-keys.ts` | The mock's published demo keys (local mock only) and the real-host guard |
| `mock-fieldroutes.ts` | Pure `(Request) => Promise<Response>` mock; served at `/api/mock/fieldroutes/{entity}/{action}` |
| `faults.ts` | Fault injection rows for the mock (`mock_fieldroutes_faults`), audited |
| `fieldroutes-mapping.ts` | Declarative field → column spec; a test proves it matches `FieldRoutesMapper` both ways |
| `studio.ts`, `views.ts` | Read models and JSON views for the Integration Studio |
| `../jobs/sync.ts` | `enqueueSync`, `runPendingJobs`, `cancelJob`, `retryJob` |
| `../jobs/runtime.ts`, `../jobs/kick.ts` | Production wiring; the web app's `after()` drain |
| `scripts/worker.ts` | `npm run worker` |

## How a sync runs

1. `POST /api/connectors/:id/sync` (permission `sync`) queues one job per office × entity, keyed by
   the request's idempotency key. A stream that already has a queued job is not queued twice.
2. The response returns; `after()` drains the queue in-process (the worker does the same).
   Claims are single-row `FOR UPDATE SKIP LOCKED`; a partial unique index allows one running job
   per connector + office + entity.
3. First attempt fixes the window: `[checkpoint − overlap, business now]` (no checkpoint:
   `initialLookbackHours` back). Overlap: 30 min for entities with `dateUpdated`, 35 days for
   payments (swept by `date`).
4. `search` pages at the cap with `{entity}IDs > last`; `get` fetches ≤ `getLimit` per call. Each
   batch goes through `ingestRecords` + `FieldRoutesMapper` (the only write path) in its own
   transaction, recording `resume_after_id`. The checkpoint moves to the window end only in the
   transaction of the last batch.
5. Failures: 429/503/timeouts back off (Retry-After when sent, else 2 s · 2^(n−1) with jitter, capped
   at 5 min) and resume after the last committed id; auth and contract errors fail at once with
   what a person must do. One office's job never affects another's.
6. Every HTTP exchange is stored in `sync_api_calls`; every job transition in `audit_log`.

## Documented vs. inferred (client and mock)

| Behaviour | Status |
|---|---|
| POST for every call, `{base}/api/{entity}/{search\|get}`, JSON body, JSON responses | documented |
| Credentials in `authenticationKey` / `authenticationToken` headers | documented (recommended form) |
| 401 = credentials missing, 403 = invalid / expired / not permitted | documented |
| 200 + `success:false` is a failure; pre-10.6 auth failures looked like this | documented |
| Error text in `errorMessage ?? error ?? message` | inferred (pages disagree) |
| Search ≤ 50,000 ids, page with `{entity}IDs: {operator: ">", value: lastId}` | documented |
| Ascending id order on every search endpoint | documented for some entities, inferred for the rest — the client pages from the max id, not the last element |
| Get ≤ 1,000 records; extra ids dropped silently by the mock | cap documented; drop behaviour inferred |
| Unknown params ignored and listed in `ignoredParams`; the client fails on a non-empty list | documented; the fail-loudly policy is ours |
| Appointment search hides status −2/−1/2, subscription hides leads, ticket hides templates by default; the client sends explicit status filters | documented |
| A standard key's `officeIDs` filter is forced to its office | documented; omitting other offices' records from `get` is inferred |
| Records for another office in a response are rejected, never stored | our policy |
| 60 reads/min and 3,000/day per key; 429 over the limit | documented |
| `Retry-After` on 429 | **mock only** — not documented; the client falls back to backoff without it |
| Rolling-minute and calendar-day windows in the mock | inferred |
| Payments swept by `date` over 35 days | inferred (current docs add a payment `dateUpdated`; legacy spec has none) |
| Window bounds sent as wall time in `wireTimeZone` (`office` for the mock) | documented: real datetimes are Pacific time — see G1 |
| Lexical comparison of `YYYY-MM-DD HH:MM:SS` filters, date-only bound compares the date part | inferred |
| Expired key fault answers 403 (the task brief said 401; the docs say 403 for expired) | documented |
| Fault injection, demo keys, the world-backed snapshot | mock only |

## Mapper deviations from the current docs

The mapper (lib/adapters/crm-fieldroutes.ts, not owned by this module) and the synthetic world
agree with each other, so the demo is consistent. Against the October 2026 docs they differ; each
is labelled `deviation` in the mapping inspector. Before a real tenant:

- G1 datetimes are Pacific time, not office-local (set `wireTimeZone: "America/Los_Angeles"` and
  convert in the mapper with the same zone);
- G2 negative `officeID` (soft-deleted customer) and `subscriptionID = -1` (stand-alone visit);
- G3 appointment response field is `isInitial` (`salesAnchor` is the filter name);
- G4 regular invoices are `templateType = NA`;
- G5 payments carry `invoiceIDs` / `paymentApplications`, not `ticketID`;
- G6 payment status 3–7 (disputes, ACH return); G8 ZIP+4; G9 subscription `active = -3`;
  G10 customer `source` is the first subscription's source.

## Not built (yet)

- Tombstones: a record missing from search is not deleted downstream (by design); periodic
  full-id-set diffs to detect hard deletes and merges are not implemented.
- Reconciliation does not run after a sync; exceptions for newly quarantined records appear on the
  next reconcile run.
- The mock world is generated on first use (~15–20 s, blocking the dev server once); the first
  attempts of the first sync typically time out and recover on retry, which the trace shows.
- Global keys and key groups are described but not modelled in the mock.
