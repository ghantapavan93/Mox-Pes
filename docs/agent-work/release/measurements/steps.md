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

## Steps 1 and 2: results (2026-11-18)

`measure-cold.sh` on the same seeded data each time; milliseconds to a usable verdict (the
`elementtiming="verdict"` element), warm = median of three loads after the first.

| Run | Overview cold | Overview warm | Decision Lab B20 warm | Decision Lab B09 warm | Upload, first result |
|---|---|---|---|---|---|
| `before.json` | 3,054 | 1,925 | 906 | 905 | 1,166 |
| `after-g1.json` (step 1, `connection()`) | 2,027 | 1,420 | 407 | 895 | 911 |
| `after-g2.json` (step 2, the verdict's own reads) | 2,138 | 1,396 | 412 | 879 | 937 |

The Overview's warm verdict stayed above the 1,000 ms goal, so step 3 ran.

## Step 3: v_acquisitions in sets (2026-11-18)

**Where the time went.** The verdict's four reads, timed on the seeded measurement database
(three warm runs each, then all four at once, as the page runs them):

| Read | Before | Migration 0038 alone | 0038 and the four statements |
|---|---|---|---|
| `branchRows` (October, all branches) | 691–730 ms | 418 ms | 186–204 ms |
| `conversionBridge` | 412–419 ms | 394 ms | 154–156 ms |
| `decisionHolds` | 443–454 ms | 225–234 ms | 9–10 ms |
| `evidenceHolds` | 336–343 ms | 130 ms | 130–134 ms |
| All four at once | 740–783 ms | 441–486 ms | 198–235 ms |

Every plan had the same two costs (`explain-query.ts`): `v_acquisitions` decided each customer's
first subscription and initial appointment for all 17,111 customers, one `LIMIT 1` lookup each
(the subscription's also re-scanned the 44 branches per customer: `Hash Right Join … loops=17111`,
about 190 ms per read), before any read kept its period; and the bridge and the unmapped-spend
hold credited the first touch of every customer (17,111 and 9,477 of them) to keep a few.

**What changed** (release design, WP-G implementation notes 2–4): migration
`0038_set_based_acquisitions.sql` writes both firsts as "no row orders before this one", so a
period or a customer is kept first; the scorecard's `sold` count reads the first subscriptions
without the first touch; the scorecard's `period_acq` takes the period as parameters (read from
the `p` CTE, the planner kept the period only after crediting 9,477 customers); the bridge and the
unmapped-spend hold name their candidate customers first, as an array. After:
`explain-branchRows-after.txt`, 204 ms execution (1,201 ms before, `explain-branchRows-before.txt`).
`tests/integration/scorecard-equality.test.ts` shows every result unchanged.

**The page.** `after-g3.json` (harness as in steps 1–2): Overview cold 1,638 ms, warm 875 ms;
Decision Lab B20 877 / 887 ms, B09 413 / 868 ms; upload first 1,720 ms, median 1,568 ms (runs
1,720, 753 and 1,568).

**The upload's clock.** Its runs fell either side of 700 ms or 1,500 ms in every measurement
(`before.json` 1,166–1,375; `after-g2.json` 757–1,243). The cause was the harness: its clock started
before Playwright waited for the sample button, and React reveals streamed sections in batches at
least 300 ms apart (React 19's `$RC`/`$RV`), so the button stayed hidden for up to a second after
the load event. A request timeline showed every request under 110 ms and no statement over 80 ms.
The harness now starts the clock when the button can be clicked, records that wait apart
(`readyRuns`), and runs the upload five times. Both builds again, the same way:

| | Baseline build `QqL3Kc7yocI0X4uYh3RQT` (`before-v2.json`) | Release (`after-g3-v2.json`) |
|---|---|---|
| Overview cold / warm | 2,034 / 1,434 ms | 1,786 / 867 ms |
| Decision Lab B20 cold / warm | 877 / 877 ms | 407 / 414 ms |
| Decision Lab B09 cold / warm | 429 / 876 ms | 398 / 878 ms |
| Decision Lab, phone: verdict / action top | 654 / 850 px: not first screen | 584 / 742 px: **first screen** |
| Upload first / median (5 runs) | 988 / 729 ms | 853 / 730 ms |
| Upload, phone: result top after a reload | 351 px | 351 px |
| CLS, worst page | 0.006 | 0.003 |

On a server that had served nothing before the uploads (`upload-before-v2.json`,
`upload-after-g3-v2.json`): medians 712 and 719 ms, first runs 1,038 and 1,440 ms. The phone
figure after a reload is not the baseline's experience: right after its dry run the old page left
the counts 4,216 px down (`before.json`), and the release scrolls to the result.

The Decision Lab's phone screen fits because the page header's description keeps its first
sentence below 640 px; the section tabs under it name the three questions.

**Against the §4 targets:** Overview warm 867 ms (goal ≤ 1,000: met); cold 1,786 ms (goal ≤ 1,500:
not met, 248 ms faster than the baseline). Decision Lab within 10% of the baseline, verdict and
action on the phone's first screen: met. Upload within 10% and on the phone's first screen: met.
CLS below 0.1: met.
