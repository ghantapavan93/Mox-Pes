# Performance steps, each measured (RELEASE-DESIGN.md §5.10)

All on the local measurement database (`revenue_signal_measure`, seeded), `next start`,
`DEMO_MODE=1`, one machine. Times from `curl` are whole-document times for `/`; the harness
numbers (`measure.cjs`) are time to a usable verdict and are the ones the targets use.

## Step 0: why every Overview read ran twice (2026-11-18)

**Observation.** With `log_min_duration_statement = 100`, one load of `/` ran the scorecard query
four times, and the holds query, the paid-leads query, the evidence-holds query and the weekly
series twice each (1.0–1.6 s each, concurrently).

**Diagnosis.** A preload hook (`harness/trace-query.cjs`) printed the caller of each holds query.
The first call of every load raised Next's own error:

> Route "/": Next.js encountered the unstable value `Date.now()` while prerendering.

So each document request ran a request-time prerender of the route as well as its dynamic render.
With `cacheComponents` and `partialPrefetching`, a route that reads `cookies()` gets a
session-specific App Shell (bundled Next docs, `01-getting-started/08-caching.md`, "Prefetching"),
rendered at request time. Next cannot see `pg` queries, so the Overview's reads ran inside that
prerender, their results were thrown away, and the dynamic render ran them all again.

**Experiment** (build mirror only, not committed): `await connection()` in `getViewer()`, right
after `cookies()`. A prerender never passes `connection()`, so it stops before any read; the
dynamic render passes at once.

| | Holds query per load | `/` document time (3 loads) |
|---|---|---|
| Before | 2 | 2.78 s, 1.97 s, 1.81 s |
| With `connection()` in `getViewer()` | 1 | 2.53 s, 1.42 s, 1.64 s |

No "while prerendering" error was logged after the change. This becomes WP-G step 1, ahead of
per-request deduplication (the remaining scorecard pair is October and September: different
arguments, both used).

## Step 2 diagnosis: the scorecard query's plan (2026-11-18)

`harness/explain-query.ts branchRows` on the seeded measurement database, October, all branches:
one statement, 1,201 ms execution, 15.7 ms planning, all buffers already in memory (no disk
reads). Plan: `measurements/explain-branchRows-before.txt`.

- **Where the time goes.** The `period_acq` CTE decides, for **every** CRM customer (17,111
  rows), its first subscription and that subscription's initial appointment, each by a per-row
  `LIMIT 1` sort over an index probe (17,111 loops each, about 136,000 buffer hits), and only then
  keeps the 3,687 whose initial appointment completed in October (≈ 450 ms). The attribution
  lookups for those 3,687 (leads by phone and email, identity-conflict checks) add ≈ 140 ms; the
  remaining joins and aggregates the rest.
- **What to change.** Filter by the period first and work in sets: the initial appointments
  completed in the period, then their subscriptions, kept only when that subscription is its
  customer's first (`distinct on` per customer, in one pass) and the appointment is the one the
  current rule picks. The result must equal the current query's for every branch and period on the
  seeded data (WP-G's equality check), so the rule itself does not change.
