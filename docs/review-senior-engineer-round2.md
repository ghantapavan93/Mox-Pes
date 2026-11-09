# Revenue Signal — senior engineer review, round 2

Stance: verify, don't trust. Each round-1 finding was re-checked against the code. Where marked
**[R#]**, a probe was run against a private database (`revenue_signal_review`, Postgres 17).

Baseline:
- `tsc --noEmit` clean.
- `vitest run tests/unit tests/integration/invariants.test.ts tests/integration/replay.test.ts tests/integration/review-regressions.test.ts` → **68/68 pass**.
- Not run (per instructions): `scenario.test.ts`, Playwright, `db:seed`.

Probe source (outside the repo):
`C:\Users\Pavan Kalyan\AppData\Local\Temp\claude\C--Users-Pavan-Kalyan-AppData-Local-Claude-Data-claude-pzs8sxrjxfjjc-scratch-workspaces-01235c2f-08d0-43e5-8445-ddd532a5de7a-e5cec287-013d-4aa8-a225-4a1cd8502f23-scratch-2026-11-01-d0b26c\1061515d-1300-4ec4-b2d5-0d9134f49b0e\scratchpad\probes\round2.probe.ts`
(the output is in `out.txt` in the same folder).

---

## 1. Score: 68 / 100 (round 1: 53)

The CRITICAL is gone. The time-zone, at-risk, in-batch-conflict, ingest-key and reconcile-race
fixes are correct. But the new "received clock" versioning has two new HIGH defects: a wrong
winner, and a replay that loses data without telling anyone. The advisory lock also adds a
deadlock. F4 and F5 are only partly fixed.

| Deduction | Points | Reason |
|---|---|---|
| NEW HIGH: an old version that was already seen beats a new one in the same batch | −5 | N1 |
| NEW HIGH: a replay of a clock-less record says "projected" but changes nothing | −5 | N2 |
| F5 residual: some poison records still abort the batch before the raw log | −4 | F5 |
| F4 residual: E.164 or bare-digit phones in free text are kept; some non-PII is hashed | −3 | F4 |
| F2 residual: receipt order has no status precedence, so a late stale delivery still wins | −2 | F2 |
| NEW MEDIUM: the advisory lock is taken after row locks are held, which causes a deadlock | −2 | N3 |
| NEW/aggravated MEDIUM: a global lock plus a full reconcile on every push | −1.5 | N4 / F14 |
| NEW MEDIUM: a transient database error becomes a permanent PROJECTION_FAILED quarantine | −1 | N5 |
| F6 partial (anonymous viewers read all branches; `/api/role` is open; demo) | −1 | F6 |
| F8 / F11 / F15 partial | −2.5 | |
| Test quality: F17 and F18 unchanged; the F2 test hides the stale-wins state; no route-handler auth tests | −3 | §4 |
| LOW residuals (F23, F25–F27, N6, N7) | −2 | |
| **Total** | **68** | |

---

## 2. Round-1 status

| # | Sev | Status | Evidence |
|---|---|---|---|
| F1 | CRIT | **FIXED** | `payload_branch()` returns only known branches (`0001_init.sql:30-37`). It is used by the detector (`reconcile.ts:35`) and by group lookup (`replay.ts:204`). **[R9]** Unknown branches from calls, web and d2d, an unknown officeID, and a non-string `branch_tag` all quarantine with `branch_id = null`, and `reconcile` succeeds. The regression test also passes. |
| F2 | HIGH | **PARTIAL** | Fixed: 1→2→1 (re-observation re-projects, `ingest.ts:119-123`), and amount corrections (content-hash version, `crm-fieldroutes.ts:127-141`). **Not fixed:** the original P3 case. **[R4]** successful@70 → void@71 → successful re-delivered@72 ends `successful`. "Latest observation wins" holds only if every observation is a fresh read of current state. There is no status precedence, so a retry or stale read flips revenue back. The same applies to calls (`marketing.ts:87-91`). The regression test (`review-regressions.test.ts:41-44`) delivers void→successful→void and asserts only the end state. Its middle state is exactly P3. See also N1. |
| F3 | HIGH | **FIXED** | Spend uses `(t at time zone 'UTC')::date` (`scorecard.ts:61`, `:157`, `:219`, `:313`; `queries.ts:84-91`). The pool is pinned to UTC (`db.ts:28`). The regression test passes under the Chicago and +14 time zones. |
| F4 | HIGH | **PARTIAL** | Fixed: a bare 10-digit number is hashed only under a phone-like key, so `costMicros` survives (regression test). Separated phones and emails inside text are scrubbed. **Not fixed [R7]:** `"transferred from +12125550177"`, `"cb 2125550177"`, `"(212)555-0177"`, `"+44 20 7946 0958"` and `"212-5550177"` in free text all pass unchanged (`redact.ts:27` requires separators). `+1XXXXXXXXXX` is the simulator's own call phone format (`world.ts:291-293`). A bare number under keys like `cell` or `alt_contact` is not hashed (`redact.ts:24`). **False positives:** `accountId: "123-456-7890"` (a Google Ads customer-ID format) and `invoiceNumber: "12125550177"` are hashed. That cannot be undone, because the raw log keeps only the hash. |
| F5 | HIGH | **PARTIAL** | Fixed: ids are capped at 15 digits and int4 bounds are checked (`crm-fieldroutes.ts:21`, `marketing.ts:257-259`). A projection failure is isolated by savepoints (`ingest.ts:173-195`); regression test passes. **Not fixed [R5/R6]:** a payload string with `\u0000` (`22P05`) or a valid-ISO year-0 `start_time` (`22008`) fails the raw-event INSERT (`ingest.ts:89-100`), which runs outside any savepoint. The whole batch is rolled back with `raw_events = 0`. On the polling path the cursor never advances, so the stream stalls permanently, which is the same failure mode as round 1. |
| F6 | HIGH | **PARTIAL** | A missing or unknown cookie now gives a read-only `guest` (`viewer.ts:29-34`, `:56-58`; `Object.hasOwn` guards prototype keys). But `guest.branchIds = null`, so an anonymous caller still reads **every branch**. `POST /api/role` still sets `engineer` for anyone (`role/route.ts:9-14`). This is acceptable as a labelled demo; round 1 asked for a 401. |
| F7 | MED | **FIXED** | At-risk is summed over distinct customers (`scorecard.ts:91-97`, `:163-171`). Company-wide exceptions count in totals, and acknowledged exceptions are excluded. The regression test passes (3 exceptions, 14,900). |
| F8 | MED | **PARTIAL** | Server: the key is bound to `source|exceptionId|mapperVersion` and a mismatch returns 409 (`replay.ts:85`, `:179-181`). UI: the key is minted once in `useState` (`ReplayPanel.tsx:63`). After a committed replay, `router.refresh()` keeps that state. If new records join the group, "Replay N records" resends the committed key with the same fingerprint, and the server returns the stored no-op. The fingerprint deliberately leaves out ids, so the server cannot catch this. |
| F9 | MED | **FIXED** | A call is versioned by content hash and ordered by receipt (`marketing.ts:87-91`, `:120`); the regression test passes. This introduces N2 and the F2 residual. |
| F10 | MED | **FIXED** | An in-batch conflict now records `payload_conflict` (`ingest.ts:137-141`); the regression test passes. |
| F11 | MED | **PARTIAL** | `acknowledge` exists for `channel_conflict` (`actions.ts:80-98`, route `:51-54`). Re-detection keeps it acknowledged (`reconcile.ts:162-163`), and it is excluded from open and at-risk. There is still no "accept incoming version" for `payload_conflict`, and no "discard" for permanently invalid quarantine. |
| F12 | MED | **FIXED** (documented-UTC option) | Labels say "(UTC)" (`period.ts:11-13`). `docs/metric-definitions.md` exists and states the policy (`:8`, `:57`). |
| F13 | MED | **FIXED** | Production with no key → `null` → 401 (`ingest/[source]/route.ts:17-18`). An empty-string key also fails closed. |
| F14 | MED | **NOT FIXED, aggravated** | A full reconcile still runs inside every push transaction (`route.ts:40-44`). It is now behind one global advisory lock, so all pushes, replays and decisions run one at a time (N4). |
| F15 | MED | **PARTIAL** | The cursor is now `greatest(...)` (`ingest.ts:243-245`). The mock still filters on the oracle `visibleAt` (`clients.ts:42-58`). |
| F16 | MED | **FIXED, with a regression** | `pg_advisory_xact_lock` serialises reconcile (`reconcile.ts:139`). The lock is taken after other locks are held, which causes N3. |
| F20 | LOW | FIXED | `health/route.ts:15-17` logs the error and returns a generic message. |
| F21 | LOW | FIXED | `actions/route.ts:28` validates the id. |
| F22 | LOW | FIXED | `ReplayPanel.tsx:95-96` uses `{source}@{v}`. |
| F23 | LOW | NOT FIXED | `Bridge.tsx:12` keeps the causal wording "never arrived". |
| F24 | LOW | FIXED | The label is now "Oct 1–30". |
| F25 | LOW | PARTIAL | The newest name in a batch now wins (`project.ts:130-134`). There is still no cross-batch guard, and `channel_code` is never updated. |
| F26 | LOW | NOT FIXED | Accepted as evidence. |
| F27 | LOW | NOT FIXED | `app/integrations/page.tsx:103` renders raw driver errors. |
| F28 | LOW | FIXED | `queries.ts:84-85` derives the range from `PERIODS.all`. |

---

## 3. New findings (ranked)

### HIGH

| # | Where | Failure (verified) | Consequence | Fix |
|---|---|---|---|---|
| N1 | `lib/ingest/ingest.ts:149` (`[...items, ...reobserved]`); `lib/ingest/project.ts:156-159` (tie → last wins) | Every record in one delivery shares one `receivedAt`, and re-observed (already-seen) versions are always appended **after** new ones. **[R3]** A payment `successful` is ingested. Then a batch `[successful (seen), voided (new)]` arrives and the payment ends **`successful`**; collected revenue stays 14,900. | The repo's own client contract says "May repeat records" (`contract.ts:30`). The mock poller returns every version visible in the 72-hour overlap (`clients.ts:42-58`). So the poll that delivers a void within 72 hours of the payment also re-delivers the original, and the void is reverted in the same run. Collected revenue is overstated, which is the F2 bug back through a new path. | Within a batch, order by input position (or by status precedence), not "new before re-observed". Never let a re-observed version beat a version first seen in the same delivery. |
| N2 | `lib/ingest/replay.ts:115` (`mapper.map(..., referenceContext)`, no `receivedAt`); fallbacks `marketing.ts:120` (`?? start_time`), `crm-fieldroutes.ts:261` (`?? paidAt`) | A clock-less record is replayed with `sourceUpdatedAt` = its event time. Every live row carries a receipt time, which is later. **[R2]** Call v1 (Direct) is projected at 16:00. v2 (Google Ads, with gclid, `caller.number` shape) is quarantined `MISSING_FIELD`. Replay with calls@1.1 returns **`projected: 1`** and marks raw event 2 `projected`. The lead is still v1: `channel_code = unknown`, `raw_event_id = 1`. | This is the flagship recovery flow. Replay reports success, the raw log says "projected", and the metric does not move. It hits any call delivered before the account migration and updated after it, and any quarantined later version of a payment. | Pass `receivedAt = raw_events.last_delivered_at` (or `received_at`) into the replay context. Count `projected` from the rows the upsert actually changed, not from mapper successes. |

### MEDIUM

| # | Where | Failure (verified) | Consequence | Fix |
|---|---|---|---|---|
| N3 | `lib/actions.ts:31-34`→`:41`, `:61-64`→`:71`; `lib/ingest/replay.ts:136-143`→`:143`; lock at `reconcile.ts:139` | Map, override and replay first UPDATE the exception row, then request the advisory lock. A concurrent reconcile that holds the lock needs that same row for its `on conflict do update`. **[R1]** Running actions.ts's exact statement order against a concurrent `reconcile()` gives **`40P01 deadlock detected`**, and the concurrent reconcile is aborted. A natural race (replay + 6 pushes, R1b) did not hit the window. | A webhook push or another decision occasionally returns 500. It is retry-safe, but it turns F16's harmless staleness into hard errors. | Take the advisory lock as the first statement of every transaction that will reconcile. |
| N4 | `reconcile.ts:139` + `ingest/[source]/route.ts:40-44` | Every push holds one global lock for a full-table reconcile (`v_acquisitions` materialised plus 5 detectors). | Push throughput is capped at one reconcile at a time, and latency grows with total history (F14 is now strictly worse). Not measured at scale. | Reconcile asynchronously, debounced, or by affected customer. |
| N5 | `lib/ingest/ingest.ts:180-192` | Any batch error (lock timeout, statement timeout, serialization or deadlock in the per-row retry) is caught silently. Each record that fails again is quarantined permanently. **[R8]** With `lock_timeout = 300ms` and another session holding the customer row, a valid customer update becomes `PROJECTION_FAILED: canceling statement due to lock timeout`, and the run "succeeds". `replay.ts:123` has no isolation, so one still-bad record fails the whole replay. | A transient load problem turns into manual replay work and stale projections. Nothing is logged at the batch level. | Isolate only data errors (SQLSTATE classes 22 and 23). Re-throw 40xxx and 57xxx so the run fails and retries. Log the batch error. Use the same isolation in replay. |

### LOW

| # | Where | Issue |
|---|---|---|
| N6 | `lib/adapters/redact.ts:22`, `:24` | False positives. Any `NNN-NNN-NNNN` value (for example a Google Ads customer ID) is hashed whatever its key. Any key containing `number` (`invoiceNumber`, `orderNumber`) hashes 10- or 11-digit values. **[R7]** The raw log keeps only the hash, so replay cannot recover the value. |
| N7 | `lib/ingest/project.ts:4-10`; `lib/queries.ts:58`; `actions/route.ts:35` | The header still says `>=` makes projection order-independent, which is false for received-clock records. `exceptionSummary` counts only open and resolved, so acknowledged exceptions vanish from the summary. The route answers "already resolved" for an acknowledged exception. |

---

## 4. Test quality

| Item | Status |
|---|---|
| F17 (bridge sums are tautological) | Unchanged. |
| F18 (revenue ground truth mirrors the implementation; keys `paymentID:status`, so a since-voided successful version still counts) | Unchanged (`scenario.test.ts:52-65`). A spend-vs-session-zone test now exists (F3 regression), but there is still no spend ground truth from the simulator. |
| F19 | Partial. A free-text test exists, but it covers only a separated phone, never E.164. Authorization is still tested only at `viewerFromRole` / `resolveScope`. No route handler is exercised without a cookie or against another branch's id. |
| Regression suite | One test per finding is good practice. The F2 test is built around the remaining bug: it never checks the state after the late `successful` delivery. No test covers mixed new and re-observed versions in one batch (N1), replay of a clock-less record that already has a live version (N2), the raw-insert poison path (F5 residual), or concurrency between an action and reconcile (N3). |

---

## 5. Not verified

- Real FieldRoutes and CallRail semantics: whether payment polls return only current state (which would make N1 unreachable in production, though still reachable through the repo's own client contract), and webhook retry ordering (the F2 residual for calls).
- N4 and F14 performance at demo scale (not seeded).
- `scenario.test.ts` and Playwright (not run).
