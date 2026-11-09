# Testing and performance

All results below were produced on 2026-11-01 on the author's machine (Windows 11, Node 22.14,
PostgreSQL 17 local install, `fsync=off` for speed). Re-run them; don't trust them.

## Suites

| Suite | Command | Tests | What it proves |
|---|---|---|---|
| Unit | `npx vitest run tests/unit` | 35 | money parsing without floats; phone/email normalisation; zone-less CRM time in Phoenix (no DST) and Chicago, including the ambiguous fall-back hour; redaction; mapper versions (the incident and its fix); CRM rules (unknown status codes rejected, refunds must reference originals); simulator determinism; synthetic CPLs inside the researched ranges; attention flags |
| Invariants (Postgres) | `npx vitest run tests/integration/invariants.test.ts` | 14 | exactly-once ingestion; retried payments; payload conflicts; quarantine without PII; out-of-order arrival and self-resolution; late older versions; reconcile idempotency; failed run → cursor kept → recovery; unknown stays unknown; add-on ≠ acquisition; revenue = payments − refunds; branch override; branch scoping |
| Replay (Postgres) | `npx vitest run tests/integration/replay.test.ts` | 8 | incident visible; dry run changes nothing; replay restores attribution and leaves spend/revenue unchanged; same key → stored result; new key after success → no-op; **4 concurrent replays claim each record once**; **4 concurrent same-key requests run once**; old mapper keeps records held |
| Review regressions | `npx vitest run tests/integration/review-regressions.test.ts` | 17 | one test per finding from the two independent review rounds (F1–F11, R2-*), each reproducing the reviewer's input — including an override racing five reconciles (no deadlock) |
| ChangeGuard (Postgres) | `npx vitest run tests/integration/changeguard.test.ts` | 12 | ads@1.0 files a migrated Local Services campaign as Search, ads@1.1 does not; ambiguous typing is refused; the coverage gap is detected with predecessor/successor evidence; the budget signal is blocked while open and sound after; re-map moves spend between channels and duplicates nothing; idempotency (same key, new key, reused key → 409); **4 concurrent re-maps claim once**; dry run changes nothing; **injected failure mid-replay rolls back, then the same request succeeds**; an unreadable record keeps its projection; a post-migration re-pull deletes nothing; spend continuous after re-map |
| Full scenario | `npx vitest run tests/integration/scenario.test.ts` | 7 | seeds the whole demo (~110 s) and checks: duplicates absorbed; the outage run recovered; quarantine count equals generated truth; **October collected revenue equals generated payment truth to the cent**; bridge buckets add up; replay brings the incident branch back in line; **ChangeGuard: exactly one coverage gap, re-mapped with spend, customers, invoices, payments, leads and raw records unchanged across all 44 branches, and 60 continuous days of Local Services spend** |
| OS golden path (e2e) | `npx playwright test os-golden-path` | 11 | reseeds, then B09 with role switching: overview hold + blocked signal → Decision Lab "not ready" linked to the incident → incident evidence (campaign, spend, leads, CRM outcomes) → AI investigator scoped to it cites evidence and creates a pending `remap_channel` proposal → engineer dry run (server, rolled back, 5 ledger rows conserved) → approver approves (proposer and engineer refused) → application executes once (repeat = stored result) → audit rows for proposer, dry run, approver, execution → overview/branch/Decision Lab updated; then B20 as a `replay_quarantine` proposal |
| OS modules (e2e) | `npx playwright test os-modules` | 7 | Customer 360 search → timeline → stored-payload drawer (Esc returns focus); partner 403; Integration Studio: rate_limit fault → sync → retry → succeeded, 429 then 200 in the call trace, fault cleared, health on /audit; identity review: guest/approver/partner refused (UI and API), marketing accepts (sibling auto-rejected), engineer rejects; ⌘K finds B09 and its incident |
| End to end | `npm run test:e2e` | 8 | Playwright golden path on a reseeded database: overview → branch → exception → dry run → replay → same request again → overview un-flagged; partner gets 403 on another branch (page and API); replay API refuses non-engineers; **B09 budget signal untrustworthy → engineer re-maps → signal sound** |

`npm test` runs unit + all integration suites (93 tests). See the final verification line at the
end of this file for the last full run. Typecheck and lint are clean. CI (`.github/workflows/ci.yml`) runs all of it against a
Postgres 17 service container — **not yet run on GitHub** (the repository has not been pushed).

The Docker path was verified separately: `docker compose up` (Postgres 17 + test database init
script) → invariants and replay suites passed (22/22) against the container.

## Bugs the tests and reviews caught (kept as regressions)

| Found by | Defect | Fix |
|---|---|---|
| Scenario seed | Generator emitted `soldBy: "rep-123"`; the CRM mapper (correctly) quarantined 5,438 subscriptions | Generator fixed to numeric employee ids; validation was right |
| Unit test | Zone-less CRM wall time is ambiguous in the fall-back hour | Documented rule: earlier instant, deterministic |
| Profiling | Branch-scoped channel query 33.5 s | View rewritten with per-customer `LATERAL` lookups (below) |
| Independent review round 1 (53/100) | 1 critical, 5 high, 10 medium findings | docs/review-response.md |
| Independent review round 2 (68/100) | 2 new high (old version could win inside a batch; replay ignored receipt order), deadlock path, transient errors quarantined | docs/review-response.md (round 2) |

## Performance (measured)

**Dataset:** 44 branches, Aug 18 – Oct 31 simulated, 675 ingestion runs; 134,088 raw events (65,923 duplicate deliveries absorbed); ~18k leads, ~15k CRM customers, ~11k payments, ~13k spend rows.

**Seed:** ~105 s end to end (all runs through the real pipeline, reconciling daily in October).

**Read models** (`npm run profile`, warm, ms):

| Query | All branches | One branch |
|---|---|---|
| branch rows | 293 | 214 |
| totals | 253 | 219 |
| conversion bridge | 267 | 174 |
| channel rows | 123 | 44 |
| weekly series | 148 | 43 |
| feedback summary | 74 | 37 |

**HTTP, production build** (`next start`, 10 sequential requests after one warm-up, curl total time):

| Endpoint | p50 | p90 |
|---|---|---|
| `GET /api/metrics?period=oct` | 501 ms | 512 ms |
| `GET /api/metrics?period=oct&branch=B20` | 405 ms | 408 ms |
| `/` overview | 368 ms | 370 ms |
| `/branches/B20` | 354 ms | 368 ms |
| `/exceptions` | 66 ms | 70 ms |
| `/exceptions/:id` (quarantine group) | 51 ms | 55 ms |
| `/feedback` | 110 ms | 115 ms |
| `/integrations` | 88 ms | 93 ms |

**The 33-second query.** With a branch filter, Postgres pushed the predicate into `v_acquisitions`
and re-ran its `DISTINCT ON` subqueries (first subscription, initial appointment) per outer row:
33,516 ms. Rewriting them as per-customer `LATERAL … ORDER BY … LIMIT 1` lookups on existing indexes
made the same query 44 ms, and the unscoped one unchanged. The bridge query then regressed to 4.7 s
because the new plan shape re-evaluated the view inside a join; materialising the acquisition set once
(`with acq as materialized`) brought it to 267 ms. Both rewrites are covered by the scenario test,
which would catch a changed result.

**Known bottlenecks / when this needs more engineering**
- Attribution is derived on every request (~200–300 ms). At production volume it should be
  materialised per reconciliation run, or computed incrementally for changed customers.
- `reconcile()` scans all history and runs inside the ingest transaction (push API included). Fine at
  this scale; at volume it should run on a schedule or per affected customer (review F14).
- The raw event log grows without bound; partition by month and archive projected payloads.

## Revenue Signal OS integration run (2026-11-01)

Run in this order after integrating the five modules:

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm test` | **234/234 passed**, 19 files (≈ 290 s, includes the full-seed scenario) |
| `npm run test:e2e` | **26 passed**, 1 skipped (demo-video recorder, gated by `RECORD_DEMO`) |
| `npm run build` | succeeded |

Demo database after `npm run db:seed` (+ `scripts/backfill-cases.ts`, `scripts/resolve-identities.ts`,
both no-ops on a fresh seed): 134,088 raw events, 65,923 duplicate deliveries absorbed, 119
quarantined, 675 runs (1 failed: the seeded 503); identity: 17,111 CRM customers, 10,496 prospects,
12,522 of 24,891 leads linked to a CRM customer, 0 pending conflicts (0 phone hashes shared by more
than one CRM customer, 0 leads matching more than one, 0 phone/email disagreements); 187 open
exceptions with 197 cases; B09 coverage gap and B20 quarantine open; no proposals, investigations,
sync jobs or faults.

## Final verification (2026-11-01)

`npm test` → **93/93 passed** (8 files, includes the full-seed scenario and ChangeGuard). `npm run test:e2e`
on a fresh seed → **8 passed** (1 skipped: the demo-video recorder, gated by `RECORD_DEMO`).
`npm run typecheck` and `npm run lint` clean.

## Domain-model pass (2026-11-09)

Run on Windows 11, Node, Postgres 17.8 (local, fsync off). Results as run.

| Check | Result |
|---|---|
| Baseline before changes | 240 of 244 passed. 4 connector tests failed: sync writes were not fenced against a re-claimed job, stale jobs looped past max_attempts, and a sync never triggered reconciliation |
| `npm run typecheck`, `npm run lint` | clean |
| `npm test` (vitest) | **255 passed** of 255 (244 existing, all kept, + 11 in `domain-model.test.ts`) |
| `npm run build` | succeeded |
| Playwright, production build, `CI=1 PORT=3000` | **26 passed**, 1 skipped (demo video, runs only with `RECORD_DEMO`) |
| Demo seed, then `dispatchEvents` | 669 `intake.records_stored` events, all already covered by the seed's own runs: 0 extra reconciles, 60 ms; second dispatch idle in 3 ms |
| Brand sums on the demo world (October) | Moxie + Mission + Joshua's paid spend, acquired customers and collected revenue equal the company line exactly; $4,539 unallocated spend stays company-level |

Two harness mistakes on the way, both mine and both fixed by re-running correctly: `SKIP_SEED=1`
also disables the per-spec reseed, so an earlier spec's fixes leaked into the golden path; and a
server on port 3200 left the mock FieldRoutes host (`localhost:3000`, stored in the connector
config) unreachable.
