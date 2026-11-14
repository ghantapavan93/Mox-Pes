# Performance: measured, on one machine

Every number below was measured on 2026-11-11 on one laptop. It is evidence for this machine and
this code. It is not a capacity guarantee.

- **Machine:** AMD Ryzen 9 5900HX (16 threads), 15.8 GB RAM, Windows 11, Node 22.14.0,
  PostgreSQL 17.8 on the same machine and disk.
- **Two isolated Postgres instances,** never the shared test database:
  - **durable** (port 54334): `fsync=on`, `synchronous_commit=on`, `full_page_writes=on`,
    `wal_level=replica`, `shared_buffers=128MB` (the defaults).
  - **fast** (port 54333, its own `bench_nofsync` database): `fsync=off`, `synchronous_commit=off`.
    This is how the test suite runs. **Its numbers are not production numbers.**

## 1. Onboarding upload, up to the 50,000-row limit (`npm run bench:onboarding -- --ingest`)

One upload is parsed, profiled, given suggestions, compiled and validated by the mapper, then
published in **one** transaction.

| Rows | Parse | Profile | Assistant | Compile + mapper | Publish (fast) | Publish (durable) |
|---|---|---|---|---|---|---|
| 1,000 | 8 ms | 25 ms | 18 ms | 0.17 s | 0.14 s (7,117 rows/s) | 0.15 s (6,878 rows/s) |
| 10,000 | 32 ms | 172 ms | 29 ms | 1.1 s | 1.1 s (9,023 rows/s) | 1.2 s (8,197 rows/s) |
| 50,000 | 156 ms | 834 ms | 164 ms | 4.75 s | 5.3 s (9,354 rows/s) | 6.2 s (8,035 rows/s) |

The 50,000-row dry run (profile + compile) takes about 6 s, which reproduces the earlier
"about 7 s". Durability costs about 15% here: one publication is one commit, so one WAL flush.

## 2. Bulk backfill, 1,000,000 rows (`scripts/bench-backfill.ts`)

This is not a product feature. It is an operator-side test that uses the product's compiler,
mapper validation and `ingestRecords` on a generated 82 MB call export: 2,000-row batches, one
transaction per batch. Every 50th row repeats an earlier call exactly, so the correct answer is
known: 980,000 leads.

| | durable | fast (`fsync=off`) |
|---|---|---|
| Load time | **178.4 s** | 148.5 s |
| Throughput | **5,604 rows/s** | 6,733 rows/s |
| Batch latency p50 / p95 / p99 / max | **339 / 439 / 627 / 1,311 ms** | 289 / 337 / 425 / 1,589 ms |
| Peak RSS (loader process) | **199 MB** | 186 MB |
| CPU, loader (user / system) | 76.4 s / 3.1 s | 76.5 s / 2.4 s |
| WAL written | **1,981 MB** | 1,997 MB |
| Database growth | **1,173 MB** | 1,173 MB |
| Leads = distinct ids = expected (980,000) | **true** | true |
| Raw ledger rows | 980,000 | 980,000 |
| Lead lookup by source id | 1.8 ms | 1.6 ms |
| Raw ledger lookup by external id prefix | 2.2 ms | 1.7 ms |
| Leads grouped by branch × channel (980k rows) | 165 ms | 141 ms |

Evidence: `docs/agent-work/evidence/backfill-1m-durable.json` and `backfill-1m-fsync-off.json`.

What this shows:

- **Throughput is flat.** Progress lines read 5,546 rows/s at 100k and 5,613 rows/s at 900k.
  Nothing degraded as the tables and indexes grew to about 1 GB.
- **Memory is bounded.** RSS went from 191 MB to 199 MB over the run, because the file is
  streamed and only one batch is held.
- **The loader is CPU-bound in Node.** The same 76 s of user CPU in both modes is the compiler
  and mapper. Durability added about 20% wall time (one WAL flush per batch commit).
- **WAL is about 1.7× the data growth** (index updates and full-page images after checkpoints).
  A real backfill needs disk and replica headroom for that.

What this does **not** show:

- **Re-delivery across batches.** Batches are 2,000 rows and repeats are 25 rows back, so every
  repeat in this file is caught inside its own batch by the compiler (`duplicateInFile` 20,000).
  The raw ledger's cross-batch deduplication is exercised by the restart test below.
- **Reconciliation at scale.** `reconcileSeconds` 0.1 is meaningless here: reconciliation works
  on CRM customers and attribution, and this database has no CRM data.
- **Concurrency.** One loader. Live webhooks during a backfill would share the lead-write lock
  (`LEAD_WRITE_LOCK`, shared mode), and a publication would wait for it.

## 3. Crash and restart (durable, 100,000 rows)

| Step | Result |
|---|---|
| Load with `--crash-after=20` (the process exits with 137 after 20 committed batches) | 39,200 leads (20 × 1,960) |
| Resume with `--no-reset`, then kill the process with `Stop-Process -Force` mid-run | 58,800 leads: exactly 30 whole batches, no partial batch |
| Resume with `--no-reset` over the whole file | inserted 39,200, **duplicates 58,800**, leads 98,000 = distinct ids = expected |

A resume is just a re-run. Every committed row comes back as a duplicate through the raw
ledger's content hash, and nothing is double-counted. Evidence:
`docs/agent-work/evidence/backfill-100k-crash-restart.txt`.

## 4. Why 10,000,000 rows was not run

At the measured flat rate, 10M would take about 30 minutes, about 12 GB of database and about
20 GB of WAL on this laptop's disk. The 1M curve showed no degradation, so 10M is expected to
show the same. The real risk at that size is index and checkpoint behaviour once data exceeds
RAM. That would need a server-class machine with production-like `shared_buffers`, separate WAL
storage, and a replica, to be meaningful. A 10M run on a laptop would not settle it.

## 5. Overview: time until the B09 decision hold is usable (R-34, 2026-11-13)

**Setup.** Production build (`next start`), demo world, marketing role. Postgres 17 in its fast
test mode (`fsync=off`). Background CPU from other desktop apps was 14–24% and could not be
stopped. The clock runs from navigation (or the click, for the guide) until the B09 hold is
visible in the browser, not until HTTP 200.

Each "fresh" sample is the first load after its own `npm run db:seed`; "warm" samples follow it.
Every seed's `ANALYZE` was confirmed: `last_analyze` was set and none of the 64 tables with rows
was left unanalyzed. Tools: `scripts/measure-overview.ts` (layers `db`, `server`, `direct`,
`guide`), driven by `C:/Temp/r34/measure.sh` (outside the repository: 8 seeds per run).

| Layer | n | Before | After |
|---|---|---|---|
| Browser, `goto("/")`, fresh seed | 3 | 4,841–5,989 ms (median 5,891) | 1,686–1,856 ms (median 1,789) |
| Browser, `goto("/")`, warm | 9 | 4,160–5,809 ms (median 4,690) | 1,327–2,324 ms (median 1,423) |
| B09 guide "Start" (client navigation), fresh | 3 | 3,466–4,014 ms | 1,151–1,434 ms |
| B09 guide "Start", warm | 9 | 3,312–4,231 ms | 1,236–1,383 ms |
| Server: the streamed chunk that carries the holds | 3 | 3,074–3,420 ms | 1,217–1,279 ms |
| Database: the page's reads, in the page's order (critical path) | 3 | 2,514–2,548 ms | 928–1,075 ms |

**Where the time went.**

- **First byte arrived in 5–50 ms.** The layout streams at once. The holds sit inside the page's
  one Suspense boundary, which waits for every read.
- **The browser revealed the hold 40–100 ms after its chunk arrived.** The reveal was never the
  problem.
- **Sampled `pg_stat_activity`:** about 10 backends were busy for the first ~0.9 s (the page's
  parallel reads). After that only 2–3 stayed busy for another ~2 s.
- **That tail was `brandRows`.** It computed each brand's totals in turn, and with no rows given,
  each `totals()` re-ran the whole 44-branch scorecard query. That is three full scorecards in a
  row: 2.3–2.5 s alone, 2.5 s inside the page, about 75% of the page's database time.

**The fix (one function, one call site).**

- A branch's scorecard row does not depend on which other branches are in scope: every aggregate
  in `branchRows` covers all branches, and the scope only selects rows. So `brandRows` takes the
  branch rows the Overview already has, and the Overview starts the brand lines as soon as those
  rows are ready.
- `brandRows` alone dropped from 2,023–2,065 ms to 60–62 ms. The slowest remaining read is
  September's totals (0.9–1.05 s).
- **Exact by construction, and checked:**
  - deep-equal brand lines on the demo world for 3 periods × company, one brand and one branch
    scope (9/9);
  - an integration test for the company, a partial scope, and a branch set missing one branch
    (that brand is then computed in full).

**Ruled out:**

| Suspect | Evidence |
|---|---|
| A missing ANALYZE, or the old query-plan stall (R-20) | ANALYZE ran in all 16 seeds; the longest statement sampled during a load was 1.3 s (the scorecard), not the 20+ s of R-20 |
| Next's route prefetches competing for the pool | Warm loads took 3,435–3,537 ms with the 24 prefetch requests allowed and 3,440–3,478 ms with them blocked, 3 runs each |
| A slow reveal behind the skeleton | 40–100 ms from chunk to visible |

**Residual.**

- **Fresh-seed loads are still a little slower than warm ones** (median 1,789 vs 1,423 ms
  direct). After a seed, autovacuum was still working on `identity_links` and `identities`
  (42,002 and 27,607 rows) about 35 s later, overlapping the first loads.
- **Not changed:** caches, timeouts, sleeps, query plans, the Decision Lab's load time.

## 6. Decision Lab: time until the B09 hold and the verified verdict are usable (R-34, 2026-11-13)

**Setup.**
- **Build and data:** production build (`next start`, port 3200) on its own synthetic database
  (`revenue_signal_lab`). Marketing role, B09, October. Postgres 17 in its fast test mode.
- **Samples:** each "fresh" sample is the first request after its own `npm run db:seed`;
  "warm" samples follow it. Every seed's ANALYZE was confirmed: no table with rows was left
  unanalyzed.
- **Browser:** headless Chromium, a new context per run, after one local warm-up page (see
  "Observed").
- **Tools:**
  - the harness `scripts/measure-decision-lab.ts`, with layers `db`, `server`, `direct` and
    `nav`, plus `snapshot` and `decision` for the comparison below;
  - its driver, `C:/Temp/lab-measure.sh`, kept outside the repository: 8 seeds per run.
- **Evidence:** raw samples, journeys, decisions and screenshots are in
  `docs/agent-work/decision-lab/`.

**"Usable".** All three of the following hold at one moment in the visible document. Neither
the hidden streamed segment nor the skeleton counts.
1. The hold: the readiness summary's "Not ready".
2. Its reason: "Blocking incident #2455: Google Local Services spend at B09 stopped…".
3. Its evidence link: "open incident →", whose `href` is `/exceptions/2455` and which no other
   element covers.

The verified-readiness verdict (each channel's state and first reason) is timed separately. It
is the page's second decision, and the slow one.

**The lead did not hold.** R-34 said the page took "about 4.3 s to load (the A/A self-check
recomputes on each load)". Measured:
- **The hold was never slow:** 0.34–0.49 s, in every run.
- **The A/A self-check takes 56–96 ms alone** and 98–221 ms beside the page's other reads. Its
  card appears with the hold.
- **The 4.3 s was the whole HTTP response.** The response ends only when the Verified readiness
  card is done, and that card is what was slow.

| Median (range, n), ms | Before | After | Final build (committed) |
|---|---|---|---|
| **Hold usable**, `goto`, 1280 px, fresh | 371 (342–423, 3) | 366 (365–375, 3) | 438 (419–465, 3) |
| **Hold usable**, `goto`, 1280 px, warm | 427 (370–460, 9) | 371 (357–451, 9) | 430 (353–458, 9) |
| **Hold usable**, branch page link (client navigation), fresh / warm | 392 (2) / 367 (361–392, 6) | 405 (2) / 380 (359–395, 6) | 370 (2) / 371 (362–400, 6) |
| **Hold usable**, `goto`, 390 px, fresh / warm | 355 (1) / 436 (377–438, 3) | 371 (1) / 383 (380–436, 3) | 353 (1) / 439 (437–488, 3) |
| **Verified verdict visible**, `goto`, 1280 px, fresh | 3,612 (3,509–3,727, 3) | 1,426 (1,375–1,452, 3) | 1,430 (1,424–1,468, 3) |
| **Verified verdict visible**, `goto`, 1280 px, warm | 3,471 (3,326–3,553, 9) | 1,801 (1,718–2,312, 9) | 1,335 (1,239–1,609, 9) |
| **Verified verdict visible**, client navigation, fresh / warm | 4,596 (2) / 5,130 (4,645–5,620, 6) | 1,338 (2) / 1,692 (1,616–1,897, 6) | 1,284 (2) / 1,314 (1,260–1,371, 6) |
| **Verified verdict visible**, `goto`, 390 px, fresh / warm | 3,450 (1) / 3,551 (3,418–3,571, 3) | 1,359 (1) / 1,855 (1,804–1,880, 3) | 1,352 (1) / 1,347 (1,288–1,631, 3) |
| Server: the hold's chunk, fresh / warm | 298 (1) / 214 (206–262, 4) | 306 (1) / 234 (216–241, 4) | 259 (1) / 166 (157–183, 4) |
| Server: end of the response, fresh / warm | 3,730 (1) / 4,835 (4,674–5,007, 4) | 1,422 (1) / 1,839 (1,666–1,925, 4) | 1,329 (1) / 1,337 (1,257–1,399, 4) |
| Database: the verified-readiness snapshot, alone | 3,312–4,052 (3) | 1,235–1,498 (3) | 1,100–1,187 (3) |

- **After** is the first build with the fix.
- **Final build** is the one committed: the same code, plus code comments that quote this
  section's figures. The full protocol was run on it after the full regression.
- Each column is 32 samples on 8 seeds.
- The 390 px rows are a phone-sized viewport on this laptop's CPU, not a phone. The journey's
  phone run below also emulates touch and a 2× screen.

**Where the time went.**

| Layer | The hold (unchanged) | The verified verdict (before) |
|---|---|---|
| Database | Verdicts and saved scenarios: 95–163 ms alone, 176–309 ms beside the page's other reads | One read-only repeatable-read snapshot: 33 statements in a row, 3.3–4.0 s |
| Server | First byte in 3–8 ms; the hold's chunk at 157–306 ms | Its chunk at 3.7–5.0 s; the response ends 2–4 ms later |
| Browser | The hidden segment arrives at 172–341 ms. React reveals streamed boundaries at most once per 300 ms after its first reveal on the first frame (`$RC` → `$RV`), so the hold shows 60–260 ms later. React attaches to the link 25–60 ms after it shows | Shown within 1–5 ms of its chunk on `goto`; on client navigation, about 0.5 s after the RSC response ended (one run with request timings: 4,622 → 5,093 ms) |

The bottleneck was in verified readiness's snapshot. Four of its statements were the same
scorecard query for B09:
- the paid-CAC trace,
- the cash trace,
- the attribution trace,
- and verified readiness itself.

Each took 698–1,098 ms. Together they were **2.85–3.48 s, 86% of the snapshot.** The scorecard
aggregates all 44 branches and then selects one row. One branch's row therefore costs as much as
all 44.

**The fix: verified readiness reads the row once.**
- **When:** after the verdicts' scope check.
- **How:** it gives that row to the three traces as an optional argument.
- **Why exact by construction:** the same query, with the same arguments, on the same snapshot,
  returns the same row.
- **Guard:** a trace refuses a given row in two cases:
  - when it is called with the pool, because it would then open its own snapshot, which the row
    might not match (review F8);
  - when the row is for another branch.
- **Other callers:** the trace page, the API, the AI tools, the workspaces and the twin pass no
  row and read their own, as before.
- **Not changed:** the scorecard query, caches, timeouts, sleeps, the page's layout and its
  Suspense boundaries.
- **After:** the snapshot is 30 statements, with one scorecard read (655–861 ms).
- **Regression guard:** `verified-readiness.test.ts` counts the scorecard reads in one snapshot:
  4 before (the test fails on the old code), 1 after. In the same snapshot, each trace given the
  row deep-equals the trace that reads its own.

**The decisions are identical.**
- **Method:** the same harness captured each scenario on a fresh seed of the old build, of the new
  build and of the final build:
  - `decision`: the library's verdicts, every verified rule, the live A/A analysis, saved
    scenarios and experiments;
  - `snapshot`: the rendered page with every `<details>` open, every link, the branch choices
    and the scope indicator.
- **Control:** two seeds of the old build were first compared with each other, and matched, so
  the comparison itself is deterministic.

| Scenario | What it decides | Before vs after vs final build |
|---|---|---|
| **B09**, marketing (44 branches) | Not ready on all 4 channels: incident #2455. Budget signal Search 8.6× Local Services, gated. Verified: all 4 not ready | Identical: decision and page (29 links, 44 branch choices) |
| **B40**, brand lead (Joshua's, 5 branches) | A trusted budget signal: Search costs 1.76× Local Services per customer, gate open. An abstention: Microsoft Ads has 0 customers (needs 5). Verified: 2 need review, 1 ready with limitations, 1 not ready | Identical: decision and page (19 links, 5 branch choices) |
| **B20**, branch partner (B20 only) | Not ready: incident #1063 (quarantined call records) | Identical: decision and page (37 links, 1 branch choice) |

**The journey, Decision Lab → evidence → back** (Playwright on the production build;
screenshots in `decision-lab/screens/`):

| | Desktop 1280 × 800, before → after | Phone 390 × 844 (touch, 2×), before → after |
|---|---|---|
| Hold usable | 443 → 447 ms | 448 → 379 ms |
| Verified verdict visible | 4,073 → 1,623 ms | 4,823 → 1,607 ms |
| "open incident →" to #2455 with its summary, lineage and spend records | 399 → 388 ms | 389 → 392 ms |
| Back: `/decisions?branch=B09&period=oct`, the same hold | 29 → 25 ms | 22 → 19 ms |

The walk was repeated in the app's own browser pane, at desktop size and at 375 px: the hold,
#2455 and its evidence, back to the same branch and period, and no sideways scroll. That pane
was hidden, so its timings are not used: see "Observed".

**Ruled out.**

| Suspect | Evidence |
|---|---|
| The A/A self-check (R-34's guess) | 56–96 ms alone; its card appears with the hold |
| Pool contention behind the hold | Verdicts take 95–163 ms alone and 176–309 ms in the batch: at most about 0.15 s |
| Postgres JIT | The B09 scorecard took 765–784 ms with JIT off and 769–819 ms with it on |
| A slow reveal of the verified card | On `goto`, the card shows within 5 ms of its chunk |

**Observed, not changed.**
- **A just-launched Chromium paints its first page about 1.2 s late,** whatever the page: first
  paint at 1,316 ms, against 120–168 ms on later pages. React reveals the first streamed content
  on that frame. The harness therefore loads a local warm-up page first; without it, run 1 of
  each invocation showed the hold at 1.28 s.
- **A hidden or background tab shows no streamed content until it is shown.** React waits for an
  animation frame, and a hidden tab produces none. The app's browser pane showed this while
  hidden.
- **Back-to-back requests on this laptop are 0.8–1 s slower than requests after a pause.** Before
  the fix: 4.7–4.9 s, against 3.7–4.0 s after an 8–15 s pause. Postgres is not the cause: the
  same scorecard takes the same time on a new connection and a reused one (819 / 769 ms). The
  likely cause is the CPU's boost under sustained load. Before and after used the same protocol.
- **In two of three diagnostic client navigations,** a second prefetch request for the Decision
  Lab's "Revenue opportunities" page stayed open while the RSC response was still streaming. It
  was not separated further.
- **On a 390 px phone, the hold starts about 655 px down,** so its link is one scroll away
  (y ≈ 910 px at 375 px wide). The layout was not changed.
- **A reseed can deadlock with a page that is reading the same database.** It happened once: the
  first final-build run's reseed (`resetSchema`) met the Overview, which the app's browser pane
  had just opened against that database (Postgres 40P01). Nothing was sampled; the run was
  repeated with the pane idle.

**Remaining bottleneck.**
- **The one remaining scorecard read is 655–861 ms, 55–60% of verified readiness.** It costs
  that much because `branchRows` aggregates every branch to return one row. A branch-scoped
  scorecard is the next lever. It needs its own exactness proof, because the Overview, the
  branch pages and every trace share that query.
- **The hold's 0.37 s is about half server and half React's reveal pacing.** No single part is
  worth a change.

## Reproduce

```
npm run bench:onboarding -- --ingest
npx tsx scripts/bench-backfill.ts --db=postgres://postgres@127.0.0.1:54334/bench --rows=1000000
npx tsx scripts/bench-backfill.ts --db=<isolated db> --rows=100000 --crash-after=20
npx tsx scripts/bench-backfill.ts --db=<same db> --rows=100000 --no-reset
RUNS=3 npx tsx scripts/measure-overview.ts direct   # against a running production server
RUNS=3 npx tsx scripts/measure-decision-lab.ts direct   # BASE_URL and DATABASE_URL of that server
SCENARIO=b40 npx tsx scripts/measure-decision-lab.ts snapshot   # what the page decides, for comparison
```

`bench-backfill` **resets the schema of the database it is given**. Point it only at an
isolated database.
