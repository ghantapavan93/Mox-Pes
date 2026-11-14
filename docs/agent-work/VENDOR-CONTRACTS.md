# Vendor contracts: what is documented, assumed, mock-verified and live-verified

Read on 2026-11-11 from official vendor documentation: CallRail API v3 (apidocs.callrail.com),
Google Ads API v26 (developers.google.com/google-ads/api, support.google.com/google-ads),
FieldRoutes (knowledgebase.fieldroutes.com; the full FieldRoutes matrix is in
`lib/connectors/README.md`).

**Nothing in this document is live-verified.** No real CallRail, Google Ads or FieldRoutes
account has been called. "Mock-verified" means a synthetic payload in the documented shape went
through the real mapper in `tests/unit/vendor-contract.test.ts` (17 cases), or the FieldRoutes
mock and connector tests.

## How to read the matrix

| Evidence | Meaning |
|---|---|
| DOC | stated in the vendor's documentation (URL in the row) |
| INFERRED | follows from documented facts, not stated |
| ASSUMED | our assumption; no documentation either way |
| NOT DOC | the documentation is silent |

| Behaviour today | Meaning |
|---|---|
| handled | stored correctly |
| refused | quarantined with a code: visible, blocks decisions, never silently wrong |
| **SILENT** | stored as something else with no signal. A defect. |
| not built | no code path exists |

## CallRail (calls)

The push intake accepts a CallRail-**shaped** call that an upstream step has already tagged
with `branch_tag`. It is not a native CallRail webhook receiver.

> **Status, 2026-11-13:** `calls@1.2` and `ads@1.2` are the active mappers (`ACTIVE_VERSION` in
> `lib/adapters/registry.ts`, switched on in commit `8ce7e62`). The tables and the paragraph
> below were written before that; their column headings now read "1.1" and "1.2 (active)". Records
> stored before a version keep the version that mapped them until they are replayed or re-sent.

| ID | State | Evidence | calls@1.1 | calls@1.2 (active) | Mock-verified |
|---|---|---|---|---|---|
| C-1 | `start_time` is ISO 8601 with an offset, e.g. `2026-10-14T10:12:33.000-04:00` | DOC | handled | handled | yes |
| C-2 | A native call object identifies the account by `company_id`, not a branch | DOC | refused `SCHEMA_VIOLATION` | refused | yes |
| C-3a | Outbound calls arrive as call objects (`direction: "outbound"`, Outbound Post-Call webhook) | DOC | **SILENT**: counted as a new inbound lead | refused `NOT_INBOUND` | yes |
| C-3b | A call marked spam (Call Modified fires on spam marking) | DOC | **SILENT**: counted as a lead | refused `SPAM_CALL` | yes |
| C-3c | `lead_status: "not_a_lead"` | DOC | **SILENT**: counted as a lead | refused `NOT_A_LEAD` | yes |
| C-4 | Call Modified resends the full call object under the same `id`; calls have **no `updated_at`** | DOC (no `updated_at`: NOT DOC) | handled as a new version ordered by **receipt** | same | yes |
| C-4a | Post-Call may arrive up to 20 minutes after hang-up, so it can land after a Call Modified | DOC (20 min); ordering INFERRED | **SILENT**: the older content, received later, wins | same | identity only |
| C-5 | Webhooks are not resent ("CallRail does not resend webhooks") | DOC | **SILENT**: a call delivered while intake was down is never seen. The coverage-gap detector only catches a whole channel going quiet | same | no |
| C-6 | Signature: `Signature` header, HMAC of the request body with a per-company signing key; SHA-1 in the sample | DOC (algorithm INFERRED from the sample) | not built (intake uses `x-ingest-key`) | — | no |
| C-7 | Rate limits 1,000/hour and 10,000/day; 429 when exceeded; no `Retry-After` documented | DOC | not built (no CallRail poller) | — | no |
| C-8 | Calls are deleted after 25 months; no API delete or redact endpoint | DOC | not built (no tombstones) | — | no |

What C-3 fixes and what it does not: calls@1.2 makes those calls **visible**. It does not
remove a lead that was already projected before the call was marked spam. The projection has no
"excluded lead" state, so the old version stays counted beside a quarantined new version, and
that quarantine opens a decision-blocking exception for the branch. The same holds for ads@1.2
when a later fetch of a day turns fractional or non-USD. The proper fix is an exclusion state on
`leads` (and a superseded state for spend days) that metrics respect. It is not built, and it
must be built before activating either staged mapper.

## Google Ads (spend)

There is no Google Ads connector. Spend arrives as `spend_day` records in a documented-like
shape (the simulation produces them).

| ID | State | Evidence | ads@1.1 | ads@1.2 (active) | Mock-verified |
|---|---|---|---|---|---|
| G-1 | `metrics.cost_micros` is int64 (a string in REST JSON); 1,000,000 micros = 1 unit | DOC | handled (exact cents) | handled | yes |
| G-2 | `metrics.conversions` is a **double** (fractional under data-driven attribution) | DOC | refused `SCHEMA_VIOLATION` | refused `FRACTIONAL_CONVERSIONS` | yes |
| G-3 | Spend is in `customer.currency_code` | DOC | **SILENT**: no currency field, so a CAD account is summed as dollars | refused `CURRENCY_UNSUPPORTED`; a record **without** a currency is still ASSUMED USD | yes |
| G-4 | `segments.date` is in the account's time zone | DOC | ASSUMED to match the branch's day | same | no |
| G-5 | Metrics may be revised "one or more days after"; invalid clicks removed retroactively; maximum window NOT DOC | DOC | handled: each fetch is a version, newest `fetchedAt` wins | same | yes |
| G-6 | Conversions can grow for up to the 90-day conversion window, by impression date | DOC (window); growth INFERRED | platform conversions are display-only here (CAC uses CRM customers), so no effect on CAC | same | no |
| G-7 | `partial_failure` exists for **mutate and upload** methods only | DOC | not applicable to reads. The conversion upload (`/feedback`) is a **dry run**; partial failure of a real upload is not modelled | — | no |
| G-8 | A SearchStream can drop mid-way; what happens to rows already received is NOT DOC | DOC / NOT DOC | not built. A future client should discard a partial stream and re-run the whole query (INFERRED) | — | no |
| G-9 | Quota exceeded: `RESOURCE_EXHAUSTED` (HTTP 429); transient errors retried with exponential backoff and jitter | DOC | not built | — | no |
| G-10 | Developer tokens sunset 2026-09-09; `login-customer-id` required through a manager account | DOC | not built | — | no |

## FieldRoutes (CRM)

The connector and mock follow the published API shape (see `lib/connectors/README.md` for the
full documented / inferred table and the G1–G10 mapper deviations). The states below were
added to the executable contract test.

| ID | State | Evidence | Today (crm@1.0) | Mock-verified |
|---|---|---|---|---|
| F-1 | Refund: negative `amount` with `originalPaymentID` | DOC | handled | yes |
| F-2 | Payments carry `invoiceIDs` / `paymentApplications`, not `ticketID` | DOC | refused `MISSING_FIELD` (every real payment: a hard blocker before a real tenant, G5) | yes |
| F-3 | Unapplied payment (`invoiceIDs: ""`, `unassignedAmount`) | DOC | refused `MISSING_FIELD`; applied vs unapplied cash is not modelled | yes |
| F-4 | Payment status 3–7 (disputes, ACH returns) | DOC | refused `SCHEMA_VIOLATION`, never mapped to paid or void | yes |
| F-5 | Customer delete negates `officeID` on the customer and its records | DOC | refused; and office-scoped searches stop returning them, so most deletes are **SILENT** (no tombstone, G-7) | yes (refusal) |
| F-6 | Ticket and subscription deletes are permanent | DOC | **SILENT**: the record simply stops appearing | no |
| F-7 | A merge removes the merged-away customer; history moves to the master | DOC (UI); API shape NOT DOC | children re-parented within a brand are applied; across brands quarantined (migration 0015); the removed customer stays (**SILENT**) | re-parenting: `ledger-model.test.ts` |
| F-8 | Stand-alone visit: `subscriptionID = -1` | DOC | refused `SCHEMA_VIOLATION` (G2) | yes |

## What must happen before each real connection

| Vendor | Blocking before a real account | Not blocking, but open |
|---|---|---|
| CallRail | ~~Activate calls@1.2 (C-3)~~ active since `8ce7e62`. Map `company_id` to branch (C-2). Verify the signature (C-6). Poll by date range to recover dropped webhooks (C-5) | Ordering of Post-Call vs Call Modified (C-4a): re-fetch the call by id after 20 minutes |
| Google Ads | ~~Activate ads@1.2 (G-3)~~ active since `8ce7e62`. A numeric conversions column and a `reporting.*_v2` view (G-2). Re-fetch a trailing window of days (G-5) | Account time zone vs branch day (G-4) |
| FieldRoutes | Payment applications (F-2, F-3), statuses 3–7 (F-4), Pacific-time datetimes (G1 in the README) | Tombstones by periodic full-id diff (F-5, F-6, F-7) |

Each of those needs a sandbox account and written authorisation. Neither exists for this work.
