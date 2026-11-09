# Revenue Signal — senior engineer review

Reviewer stance: skeptical. I tried to break it. Every finding below was verified by reading the
code and, where marked **[probe]**, by running a test against a private database
(`revenue_signal_review`, Postgres 17, server `TimeZone = America/Chicago`). Findings I could not
reproduce are marked **SUSPECTED**.

Baseline: `tsc --noEmit` clean, `eslint` clean, `vitest run tests/unit tests/integration/invariants.test.ts tests/integration/replay.test.ts` → 57/57 pass.
Not run: `scenario.test.ts`, Playwright, `db:seed` (per instructions).

Probe sources (outside the repo):
`C:\Users\Pavan Kalyan\AppData\Local\Temp\claude\...\scratchpad\probes\probe.test.ts` and `concurrency.test.ts`.

---

## 1. Score: 53 / 100

The architecture is sound: raw event log, versioned pure mappers, set-based guarded upserts,
detectors as SQL statements, idempotent replay with row-lock claiming. The code is clean and small.
But the details break under exactly the inputs the system says it is built for: malformed
records, out-of-order versions, and real-world payloads.

| Deduction | Points | Reason |
|---|---|---|
| CRITICAL: one malformed record bricks reconciliation | −10 | F1 |
| HIGH: payment versioning lets an old status win | −5 | F2 |
| HIGH: paid spend window depends on server time zone | −5 | F3 |
| HIGH: redaction misses free-text PII and destroys large spend values | −5 | F4 |
| HIGH: poison record stalls a stream or a whole webhook batch | −5 | F5 |
| HIGH: fail-open viewer default (demo identity, but real defect) | −3 | F6 |
| MEDIUM findings (F7–F16) | −9 | ~1 each |
| Test quality: key invariants untested or tested tautologically | −3 | §1 of F17–F19 |
| LOW findings | −2 | F20+ |
| **Total** | **53** | |

---

## 2. Findings (ranked)

### CRITICAL

| # | Where | Failure scenario | Consequence | Fix |
|---|---|---|---|---|
| F1 | `lib/reconcile/reconcile.ts:20-24` (PAYLOAD_BRANCH), `:139-151` (insert); FK at `database/migrations/0001_init.sql:268` | A call arrives with `branch_tag: "B99"` (or any non-branch string). The mapper correctly quarantines it as `UNKNOWN_BRANCH`. The quarantine detector copies the raw payload string into `exceptions.branch_id`, which has an FK to `branches`. **[probe P1]**: `insert or update on table "exceptions" violates foreign key constraint "exceptions_branch_id_fkey"`, for both `"B99"` and `"nonsense"`. | Polling path (`runStream`) commits the quarantined row, so **every later `reconcile()` throws**: every replay, every decision (`/api/exceptions/:id/actions`) and every `POST /api/ingest/*` returns 500 until someone deletes the raw event by hand. On the push path, the whole 500-record batch is rejected. The exact failure mode the quarantine exists to absorb takes the product down. | Resolve the payload branch with `(select id from branches where id = <payload value>)` so unknown values become `null`, or drop the FK on `exceptions.branch_id` and store the raw tag in evidence. Add a test with an unknown branch tag through `reconcile`. |

### HIGH

| # | Where | Failure scenario | Consequence | Fix |
|---|---|---|---|---|
| F2 | `lib/adapters/crm-fieldroutes.ts:285-287` (version = status, clock = `date`), `:413` (`sourceUpdatedAt: paidAt`), guard `lib/ingest/project.ts:121` (`>=`) | Every version of a payment has the same `source_updated_at`, so the `>=` guard means "last delivered wins". **[probe P3]**: void (`status 2`) arrives, then the older `status 1` version arrives late → row flips back to `successful`, collected = $149. **[P3b]**: 1 → 2 → 1 is lost, because `payment:X:1` already exists and counts as a duplicate; row stays `voided`. **[P3c]**: an amount correction with an unchanged status becomes a `payload_conflict` and is dropped. | Collected revenue (the "to the cent" metric) can be overstated or understated by delivery order. The sim never emits a void (`lib/sim/world.ts:192-225` only emits status 0/1 on separate ids), so tests cannot see this. | Version payments by a monotonic field: a source `dateUpdated` if one exists, else `received_at` plus a status precedence (`voided` > `successful` > `failed`). Never use `>=` on a non-unique clock. Add out-of-order void tests. |
| F3 | `lib/metrics/scorecard.ts:61` (`p.t0::date`), `:149`, `:199`, `:284` (`$1::date`), periods `lib/period.ts:352-354` | Periods are UTC instants. `spend_date` is a `date`. Casting the instant to a date uses the Postgres session zone, and node-pg serialises `Date` params in the Node process zone. **[probe P4]**: spend on 09-30 = $100, 10-01 = $200, 10-30 = $400. October paid spend is **$300 on this machine (Chicago)** and **$600 with `TZ=UTC` and `timezone=UTC`**. Sep 30 is included and Oct 30 dropped. | Headline paid spend and paid CAC differ by deployment. This contradicts "every number reproduces" (`0001_init.sql:307-308`) and the definitions page claim "tested to the cent". No test checks spend against ground truth. | Pass periods as `date` strings (`'2026-10-01'`) for spend, and as explicit `timestamptz` for events. Pin `timezone=UTC` on the pool. Better still, define periods in branch-local time (see F12). |
| F4 | `lib/adapters/redact.ts:436-449`; claim at `lib/ingest/ingest.ts:116` | (a) Free text is never scanned. **[probe P2/P2b]**: `agent_note: "Jane Doe, 12 Elm St, alt number 212 555 0177 ext 4"` is stored verbatim in `raw_events.payload` and in `leads.heard_about_text` (`marketing.ts:111`, `:181`). Emails inside sentences, `+44…` numbers and `…x23` extensions also pass through. (b) Shape-matching hits non-PII. **[probe P2]**: `costMicros: "1500000000"` ($1,500/day) matches `PHONE_SHAPE` and gets hashed. The ads mapper then quarantines it (`SCHEMA_VIOLATION`). The same happens for every 10-digit value ($1,000–$9,999.99/day) and every 11-digit value starting with 1 ($10k–$19.9k). | (a) The "nothing downstream ever sees raw PII" claim is false for any note or message field. (b) Real campaigns that spend over $1k/day are quarantined, and **replay cannot recover them**: the raw payload holds the hash, not the value. Paid spend is silently understated. The sim's daily spend stays under ~$500, so this stays hidden. | Redact by declared field per mapper plus a free-text scrubber (regex replace inside strings). Never hash numeric-only strings outside known contact fields. Keep a key-encrypted raw copy if replay must be lossless. |
| F5 | `lib/ingest/ingest.ts:220` + `lib/ingest/project.ts:168` (one statement per table inside the batch tx); `crm-fieldroutes.ts:314` (`Number(p.customerID)`); `marketing.ts:251` (`clicks` unbounded) | **[probe P9]**: `customerID: "99999999999999999999"` passes the `^\d+$` schema, then `bigint out of range` aborts the batch; `raw_events` count = 0. **[probe P10]**: `clicks: 3000000000` → `integer out of range`. **[P9b]**: ids 2^53 and 2^53+1 collapse to one customer (precision loss through `Number`). | One bad record means `runStream` fails, the cursor never advances, and every later run re-fetches and fails. **The stream is stalled permanently.** On `/api/ingest` the whole batch is rejected, so webhook retries loop forever. The "every delivery lands in the raw log first" claim does not hold: nothing lands. | Validate numeric ranges in the zod schemas (ids ≤ 2^53−1 or keep them as strings, int4 bounds). Insert raw events in their own statement before projection, and on a projection error re-run row-by-row and quarantine the offender (`error_code = 'PROJECTION_FAILED'`). |
| F6 | `lib/viewer.ts:306-308`; `app/api/role/route.ts:9-14` | No cookie, or an unknown value, resolves to `VIEWERS.marketing`: all branches, `decide: true`. `curl /api/metrics` with no cookie returns every branch. `POST /api/exceptions/:id/actions` with no cookie can map campaigns and override lead credit. Any caller can also `POST /api/role {"role":"engineer"}`. | The claim at `viewer.ts:266-269` ("a branch partner cannot read or act on another branch by … calling the API") is unsupported. **Demo vs real:** the role picker is demo by design. But "default to a privileged role" is a real defect that will survive an SSO swap if this pattern is copied. Per-route scope checks given a Viewer are correct (see §3). | Missing or invalid identity → 401, never a default role. Gate `/api/role` behind a demo flag. |

### MEDIUM

| # | Where | Failure scenario | Consequence | Fix |
|---|---|---|---|---|
| F7 | `lib/metrics/scorecard.ts:88-90`; definition `lib/metrics/definitions.ts:423-428`; headline `app/page.tsx:43-46` | **[probe P5]**: one customer with both a `branch_mismatch` and a `channel_conflict`, plus a $500 unmapped-spend exception. Totals: `openExceptions = 2` (actual 3), `atRiskCents = 29,800`, but the customer only paid 14,900. Null-branch exceptions (unmapped spend, payload conflicts, branch-less quarantine) are always dropped. | The headline says "N open exceptions hold $X of collected revenue", but that number double counts customers and excludes the very spend the definition names. It disagrees with `/exceptions`. | Compute at-risk over distinct customers. Show company-wide exceptions separately in totals. |
| F8 | `lib/ingest/replay.ts:250-265`; `components/ReplayPanel.tsx:60`, `:103` | The idempotency key is global and not bound to the request. **[probe P6]**: key reused for a different group → `alreadyProcessed: true`, claimed reported as 1, and the second group stays quarantined. UI: after a committed replay, if new records join the group, the panel reuses `lastReplay.idempotencyKey` and labels the button "Replay N records". Clicking it replays nothing. | The "Replay N records" button does not do what it says. A key reused by mistake silently skips work. | Store a request fingerprint (source, exception, mapper, sorted ids) with the key, and return 409/422 on a mismatch. Mint a fresh key whenever `records > 0`. |
| F9 | `lib/adapters/marketing.ts:83` (`identifyBy(..., "start_time")`); also `:154`, `:205` | Call version = `start_time`, which never changes. **[probe P7]**: the same call later re-sent with `source: "Google Ads"` and a gclid (CallRail updates attribution after the fact) → `conflicts: 1`, and the lead stays `unknown`. | Legitimate source updates are dropped as "conflicts", and attribution stays wrong. | Version by a source `updated_at` when the feed has one. Otherwise treat a changed payload under the same id as a new version ordered by `received_at`. |
| F10 | `lib/ingest/ingest.ts:155` | **[probe P8]**: two different payloads for the same version in one batch → `conflicts: 1`, **0 exceptions**, and the second payload is discarded with no trace. | Cross-batch conflicts raise an exception, same-batch ones vanish. The behaviour is inconsistent and the evidence is lost. | Call `recordPayloadConflict` for in-batch conflicts too. |
| F11 | `app/api/exceptions/[id]/actions/route.ts:16-20`; `lib/reconcile/reconcile.ts:107-117`; `lib/actions.ts:242-261` | `channel_conflict` has no action and is re-detected forever, because the underlying condition is permanent history. `payload_conflict` can only be "closed". There is no way to accept the incoming payload, so the first (often stale) version stays in the metrics. Quarantine groups of permanently invalid records (e.g. `UNKNOWN_ENTITY`) can only close through a replay that can never succeed. | Open exceptions and at-risk only grow, so every branch eventually trips the `exceptions` attention flag (`lib/attention.ts:30`). "Close conflict" makes the warning go away but leaves the number wrong. | Add an acknowledge/override decision for `channel_conflict`, an "accept incoming version" action, and a "discard record (with reason)" action for quarantine. |
| F12 | `lib/period.ts:352-354`; `scorecard.ts:67`, `:81`, `:86` | Event metrics use UTC month boundaries. A Phoenix payment at 18:00 local on Sep 30 is 01:00Z on Oct 1, so it counts in October. `docs/metric-definitions.md`, cited in `0001_init.sql:40`, `0002_attribution_views.sql:3`, `:12` and `definitions.ts:3`, **does not exist** (`docs/` was empty before this review). | Branch partners see month totals that do not match their local books. The zone policy is undocumented. | Define periods in branch-local time, or state "UTC" on every period label. Write the referenced doc. |
| F13 | `app/api/ingest/[source]/route.ts:17` | `INGEST_API_KEY` falls back to `"dev-ingest-key"`, the value in `.env.example`, when unset. | A production deploy without the env var accepts writes from anyone who has read the repo. | Fail closed: throw at startup if the key is unset outside development. |
| F14 | `app/api/ingest/[source]/route.ts:41`; `reconcile.ts:135` | Every webhook push runs a full `reconcile()`, which materialises `v_acquisitions` over all customers and runs five full-table detectors inside the ingest transaction. | Push latency grows with total history, not batch size, and webhook senders time out at scale. **SUSPECTED** (not measured: I could not seed a full dataset under the instructions). | Reconcile asynchronously or on a schedule, or incrementally by affected customer. |
| F15 | `lib/sim/clients.ts:329-345`; `lib/ingest/ingest.ts:270-273` | The mock client filters on `visibleAt`, a simulator-only perfect clock, not on any payload field. A real FieldRoutes payment poll has to filter on `date` (no `dateUpdated`, per `crm-fieldroutes.ts:175`), so a void or refund status change more than 72 hours after the payment date is never re-fetched. The cursor is also set to `windowEnd` with no `greatest()`, so a late, older run can move it backwards. | The cursor/overlap design is validated only against an oracle clock. **SUSPECTED** for real-API behaviour; the code facts are verified. | Have the mock filter on the same payload field a real client would. Add a periodic deep re-sync for payments. Use `cursor_at = greatest(cursor_at, excluded.cursor_at)`. |
| F16 | `lib/reconcile/reconcile.ts:139-159` | Two concurrent reconciles: tx A has not seen tx B's newly arrived ticket. B resolves the `payment_without_ticket`, then A's upsert re-opens it after B commits. | A stale open exception persists until the next reconcile. **SUSPECTED**: 40 concurrent ingest+reconcile transactions ([probe P11]) produced 0 deadlocks/failures, but I did not construct the interleaving. | Serialise reconcile with `pg_advisory_xact_lock`. It is cheap, and reconcile is already global. |

### LOW

| # | Where | Issue |
|---|---|---|
| F20 | `app/api/health/route.ts:16` | Unauthenticated endpoint returns the raw DB error message (host/port/auth details). It contradicts the "never leaked" policy in `lib/http.ts:6`. |
| F21 | `app/api/exceptions/[id]/actions/route.ts:29` | `Number("abc")` → `NaN` → pg `invalid input syntax for type bigint` → 500 instead of 400/404. The page version validates (`app/exceptions/[id]/page.tsx:17-18`); the API does not. |
| F22 | `components/ReplayPanel.tsx:93` | The mapper dropdown always says `calls@{v}`, even for crm/web/d2d quarantine groups. |
| F23 | `components/Bridge.tsx:154`; `scorecard.ts:282-285` | "N claimed conversions never arrived as a lead record". Claimed covers mapped campaigns only, while paid leads include unmapped-campaign leads and a different day boundary. The causal wording is unsupported. |
| F24 | `lib/period.ts:352` | "October 2026" ends at `2026-10-31T00:00Z`, so Oct 31 is excluded under a label that implies the full month. |
| F25 | `lib/ingest/project.ts:130-134` | `ad_campaigns` upsert takes the **oldest** name in the batch and never updates `channel_code`. Renames regress, with no version guard. |
| F26 | `lib/queries.ts:179-185` via `app/exceptions/[id]/page.tsx` | A partner viewing an in-branch `branch_mismatch` sees the other branch's lead ids, branch and channel. This is a minor cross-branch disclosure; arguably needed as evidence. |
| F27 | `app/integrations/page.tsx` "Failed runs" | Raw driver error strings (e.g. `value "1000…" is out of range`) are rendered to users. Company roles only. |
| F28 | `lib/queries.ts:83` | The weekly series hardcodes `2026-08-31..2026-10-26`. |

### Test-quality findings (feed the −3)

| # | Where | Issue |
|---|---|---|
| F17 | `tests/integration/scenario.test.ts:68-70` | "Bridge buckets add up" is true by construction: a single `CASE` assigns each prospect exactly one bucket. It cannot fail, and it does not test bucket semantics (e.g. a prospect that is an existing customer and also credited). |
| F18 | `tests/integration/scenario.test.ts:56` | The revenue ground truth keys by `paymentID:status` and reuses `wallTimeToInstant` and the same UTC boundaries, so it mirrors the implementation. It would also count a since-voided successful version, the same bug as F2. It is not independent. There is no spend ground-truth test at all, which is why F3 went unnoticed. |
| F19 | `tests/unit/adapters.test.ts:16`; `tests/integration/invariants.test.ts:169-173`; `tests/e2e/golden-path.spec.ts:53-61` | The redaction test asserts that free text stays unredacted and never tests a phone inside text (F4). The authorization tests only exercise `resolveScope()` and a cookie-set partner. No test covers the missing-cookie path (F6) or route handlers on another branch's exception id. The "older version never overwrites" test uses distinct timestamps only, never equal ones (F2). |

---

## 3. Claims verified true

| Claim | Evidence |
|---|---|
| Re-delivery of the same version is absorbed: delivery_count++, no re-projection | `invariants.test.ts` "same batch three times" passes. Code path at `ingest.ts:186-211`. |
| An older version with an older `dateUpdated` never overwrites a newer one | Guarded upserts at `project.ts:46…146`; test passes. Holds only for strictly ordered clocks (see F2). |
| A failed run does not advance the cursor, and the next run re-reads the window | `ingest.ts:266-286`; test passes. |
| Replay: same key run concurrently executes once | Unique-key insert inside the tx blocks the second caller, which then reads the stored row (`replay.ts:257-265`); 4-way race test passes. |
| Replay: different keys never double-claim a record | Conditional `update … where status = 'quarantined'` (`replay.ts:268-273`); 4-way race test passes. |
| Dry run changes nothing | `withRollback` (`db.ts:49-58`); test confirms 0 `replays` rows and unchanged metrics. |
| Branch scope is applied in SQL; a partner asking for another branch gets 403, not filtered data | `resolveScope` (`viewer.ts:315-323`); used by `/api/metrics`, `/exceptions`, `/branches/[id]`. Detail page, replays API and actions API use `canSeeBranch` and answer 404 (no existence leak). `/integrations` is refused for scoped viewers. All correct **given** a Viewer (see F6 for how the Viewer is obtained). |
| Role permissions enforced server-side | Replays API checks `can.replay`; actions API checks `can.decide` / `can.closeConflicts` (`actions/route.ts:38-49`). |
| No fan-out in the scorecard | Each CTE in `branchRows` is grouped to one row per branch. `v_acquisitions` is one row per customer (`distinct on` first subscription, `distinct on` initial appointment, lateral `limit 1`, unique `crm_office_id`). `v_leads` joins overrides on a unique key. |
| Distinct prospect counts are not summed across branches | Recomputed globally in `totals()` (`scorecard.ts:137-143`). |
| Bridge buckets are mutually exclusive | Single `CASE` per prospect (`scorecard.ts:267-280`). Exclusive by construction. |
| First-touch-with-evidence, 60-day lookback, "unknown never upgraded" | `0002_attribution_views.sql:68-83`; ordered by `(evidence = 'none'), occurred_at, id`; test passes. |
| `channel_conflict` only fires for an evidenced non-D2D first touch | Reasoned from the lateral order: any D2D lead inside the window has evidence and would otherwise win. |
| Money is integer cents end to end; micros parsed exactly | `primitives.ts:308-322` (BigInt); unit tests pass. |
| Wall-time → instant handles Phoenix (no DST) and Chicago DST | `primitives.ts:403-411`; unit tests pass. |
| Route handlers do not leak internal errors | `lib/http.ts` returns "Internal error" for unknown errors (except F20/F27). |
| Reconciliation is idempotent on re-run | Fingerprint upsert; test passes. |
| Auto-resolve keeps a human resolution text only if the condition actually cleared | `reconcile.ts:148` wipes `resolution` when re-detected; `:155` keeps it when resolved. |
| Quarantined raw payloads contain no raw phone/email **in structured contact fields** | Probe and unit test confirm. Not true for free text (F4). |

---

## 4. Could not verify

- **Performance** of `v_acquisitions` and the detectors at full demo scale. I did not seed (instructions); F14 is SUSPECTED.
- **Real FieldRoutes/CallRail API semantics** (filter fields, whether calls are updated in place). F9 and F15 rely on the code's own comments and public API knowledge.
- **Concurrent reconcile re-open race (F16).** 40 concurrent push transactions produced no deadlocks; the exact interleaving was not constructed.
- **Playwright e2e** and **`scenario.test.ts`**: not run per instructions. I read them only.
- **Next.js 16 / `cacheComponents` caching across roles.** No `"use cache"` appears anywhere, and pages read `cookies()`, so they should be dynamic. Not exercised in a running server.
- **Whether the shared demo DB already exhibits F3.** I did not touch `revenue_signal`. Its numbers are produced on this same Chicago-zoned server, so October spend there should include Sep 30 and exclude Oct 30.
