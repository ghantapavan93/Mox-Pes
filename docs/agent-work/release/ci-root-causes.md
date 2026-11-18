# Linux CI failures: reproduction and causes (WP-I)

GitHub's `ci / verify` job has failed on `main` since `1814616` (2026-11-17), with seven Playwright
spec files red on its Linux runner while they pass on Windows locally.

## Baseline reproduction (2026-11-18)

- **Mirror:** `docs/agent-work/release/harness/linux-ci-repro.sh c445311 C:/Temp/rso-ci-out/before 2`:
  the committed tree of `c445311` in Docker, Node 22 (`node:22-slim`), Postgres 17 listening on
  `127.0.0.1:54333` in the run container's network namespace (as CI's service is reached),
  `CI=true` (so the suite runs `next start` on port 3000 against a production build), two CPUs and
  6 GB for the run container. The first attempt reached Postgres by a host name, which the app
  counts as a remote database (TLS and a three-connection pool, `lib/db.ts`); the mirror was
  corrected before this run.
- **Scope:** the seven failing spec files only: `os-modules`, `z-a11y-regressions`,
  `z-quality-gates`, `z-trace`, `zy-evidence-journey`, `zy-overview-movement`,
  `zz-b09-four-minute-path`.
- **Result:** 12 failed, 47 passed, 59.8 minutes. `os-modules` passed in this run.

## The twelve failures

| # | Test | What failed | Class |
|---|---|---|---|
| 1 | `z-a11y-regressions:75` proposal card status region | `getByTestId('proposal').first()` not found in 5 s on the B09 gap incident | Precondition: the proposal is created by `golden-path.spec.ts`, which this subset did not run. Decided by the full-suite run |
| 2 | `z-a11y-regressions:129` `?period=` falls back | `page.goto('/?period=…')` hit the 60 s test timeout on the third of three Overview loads | Slow rendering |
| 3 | `z-quality-gates:139` CLS at 1440 px | `/decisions?branch=B09&period=oct`: CLS 0.161 (0.155 from the section `section.min-w-0 scroll-mt-20 rounded-xl bg-surface`, 0.006 from the header actions) | Layout shift (real defect) |
| 4 | `z-quality-gates:178` hydration as a non-guest role | 240 s test timeout while visiting every page | Slow rendering |
| 5–8 | `z-quality-gates:237` hostile inputs: `/` and `/decisions` and `/api/metrics` as marketing, `/` as partner | 240 s test timeouts, each test fetching a page once per hostile value | Slow rendering |
| 9 | `z-trace:9` trace opens | `h1` "Where does $…" not visible in 5 s on `/branches/B09/trace` | Slow rendering |
| 10 | `zy-evidence-journey:20` | `trace-reproduced` not visible in 5 s on `/branches/B44/trace` | Slow rendering |
| 11 | `zy-overview-movement:160` | the movement section's `data-scope` not set in 5 s after choosing B09 | Slow rendering |
| 12 | `zz-b09-four-minute-path:52` | the B09 hold line in `decision-holds` not visible in 5 s on the Overview | Slow rendering |

## Causes

1. **Slow server rendering (10 of 12).** Every document request runs a request-time prerender
   that executes all of the page's database reads and discards them, then the dynamic render runs
   them again (`measurements/steps.md`, step 0). On two CPUs the doubled scorecard query alone
   holds the database for several seconds per load, so 5-second expectations and the long
   page-loop tests time out. Fix: §5.10 steps 1–3 (WP-G): `connection()` in `getViewer()`, the
   verdict waiting only for its own reads, the scorecard query's set-based rewrite. No timeout is
   raised.
2. **The Decision Lab layout shift (1 of 12).** A real defect, larger on slower machines because
   the section's content arrives later. The other session's uncommitted fix to
   `app/decisions/page.tsx` targets it; WP-0 verifies it with `z-quality-gates` before committing it.
3. **A missing precondition (1 of 12).** A subset artefact; the full suite in the mirror (WP-I
   step 4) decides whether it fails on Linux at all.

## After the fixes

**Step 3, the seven files** (`linux-ci-repro.sh 7d38ad7 C:/Temp/rso-ci-out/after 2`, the same
mirror): 62 passed, 2 failed, 12.9 minutes (59.8 before). The ten slow-rendering failures pass:
the hostile-input tests take 0.2–19 s instead of timing out at 240 s, and the trace, the evidence
journey, the Overview's movement and the B09 path pass inside their 5-second expectations. The
Decision Lab's layout shift is gone (CLS checks pass at 1440 and 390 px).

| # | Test | Result | Cause and fix |
|---|---|---|---|
| 1 | `z-a11y-regressions:75` proposal card | Failed again | The subset's missing precondition (no `golden-path.spec.ts`); the full suite decides it |
| 2 | `z-quality-gates:109` axe at 390 px | New failure | `scrollable-region-focusable` on `/onboarding/[id]`: the mapping value table's scroll wrapper, added in `3a47f0d` for 320 px, held only disabled selects after a dry run. It is now a named, focusable region, as `TableWrap` is (`91acac5`) |

**Step 4, the full suite** (`linux-ci-repro.sh 91acac5 C:/Temp/rso-ci-out/full 2 tests/e2e`): 138
passed, 3 failed, 3 skipped, 27.8 minutes. The proposal-card test (#1 above) passes once
`golden-path.spec.ts` runs before it, and axe at 390 px passes with `91acac5`. The three failures
were the tests' own:

| Test | What failed | Cause | Fix |
|---|---|---|---|
| `release-controls:115` and `:127`, the 409 and dropped-connection states | "no open incident offered case controls to the marketing analyst" | The helper scanned the first 40 open incidents for one with a case; in the full Linux run none had one yet (a case comes with reconciliation) | The helper makes its own: B07's replayable quarantine, reconciled, as J3 makes it |
| `release-journeys:291`, J2 | The data times before and after differed | Read with `innerText` before React revealed the block: a hidden block's innerText has no line breaks, so the same times compared unequal | Read once visible, compared as words |

No assertion was weakened and no timeout raised.
