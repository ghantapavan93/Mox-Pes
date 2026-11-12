# Verification log

Every result here was produced by a run in this session (2026-11-11), on Windows 11, Node 22.14,
Postgres 17.8 (local, `fsync=off`), against synthetic data only.

## Baseline (before any change)

| Check | Result |
|---|---|
| Durable backup | `Desktop/Moxie-backups/worktree-2026-11-11/`: `worktree.tar.gz` (80 MB, without `node_modules`/`.next`), `uncommitted.diff`, `untracked.txt` |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `vitest run` | **332 / 332**, 30 files |

## Red proofs (the defect was real on the code as found)

The adversarial cases marked "was FAIL" were run against the `HEAD` versions of the seven
changed source files (swapped in, run, restored):

| Case | Result on `HEAD` |
|---|---|
| ADV-12, 13, 15, 19, 24, 25, 35 | **7 failed** |
| ADV-42 | did not finish: hung past the 280 s limit (quadratic redaction of a 3 MB note) |
| ADV-46 | measured directly: redaction of 200 KB took 36.5 s (`x` × 200,000) |

After the fixes: **36 / 36**. Redacting 3 MB now takes 0.8 s.

The 21 independent-review findings were reproduced by the reviewers (pure-function scripts and
timings in their reports; the publication race was argued from the code). Each now has a
regression test using their input.

## Evaluation (schema assistant)

| Set | First contact (held out at the time) | After fixes (development) |
|---|---|---|
| v1 (69 cases) | 6 wrong / 362 suggested | 0 / 361 |
| v2 (59 cases) | 7 / 277 | 1 / 300 |
| v3 (56 cases, never tuned on) | **6 / 269 (2.2%)**; naive baseline 21 / 300 (7.0%) | — |

Raw reports: `evidence/mapping-eval-v{1,2,3}-first-contact.json`.

## Browser verification (built-in browser, dev server)

Walked as the marketing analyst then the approver: upload of the call sample → profile (phones
shown only as masked shapes) → suggested mapping with evidence → the two questions → dry run
(6 new, 5 needing correction, 1 duplicate, 12 of 12 rows accounted for) → disabled approve and
publish controls with reasons for the analyst → approval and publication by the approver → 6
rows published, each linked to its raw event. The walk found two defects (dead rail anchors;
future-dated records accepted); both were fixed and tested.

`tests/e2e/z-onboarding.spec.ts`: **4 / 4** (analyst → approver workflow; payments compared to the
cent and never publishable; scoped and read-only roles refused; a file fitting no dataset not
guessed).

## Performance (`evidence/bench-onboarding.txt`)

50,000-row export: parse 0.2 s, profile 1.0 s, assistant 0.25 s, compile + mapper 5.6 s (about
8,900 rows/s), publication 6.5 s (about 7,700 rows/s; upper bound, `fsync=off`).

## Final runs

See [PROGRESS.md](PROGRESS.md) § Final results.

## Marketing ChangeGuard runs (2026-11-11, later)

| Run | Commit | Result |
|---|---|---|
| Typecheck, lint | 0d76a4f | pass |
| `vitest run` (unit + integration) | 0d76a4f | **548 / 548**, 45 files, 287 s |
| `npm run build` | 0d76a4f | pass |
| Playwright, production server, `VISUAL=1` | 120bee4 | 68 passed, 1 skipped, 0 failed (pixel baselines unchanged by the new nav item) |
| Playwright, production server, `VISUAL=1` | 0d76a4f | **67 passed, 1 skipped, 1 failed**: the B09 four-minute path |
| B09 path alone, production server | 0d76a4f | failed, passed, passed (3 runs) |
| B09 path alone, production server, after waiting for the dry-run response | fdd7b79 | passed, failed (2 runs) |
| Clean checkout of fdd7b79 (isolated worktree and databases) | fdd7b79 | see `FINAL-EVIDENCE.md` |

**Open: the B09 four-minute path is intermittent at HEAD.**
- **Two causes were seen.**
  - (1) The dry-run step asserted with the default 5 s while the dry run measured 4.5 s on the
    dev server. Fixed in fdd7b79: the test waits for the request.
  - (2) The first step: after the client navigation from `/demo`, the Overview sometimes stays
    on its skeleton past 5 s (trace screenshot). The page itself is fine: a direct load renders
    in 1.5 s, and four scripted runs of the same click path on the production build revealed
    in 1.3 s.
- **A suspect, not a proven cause.** Every production page load logs React hydration error
  #418 (text mismatch). It also appeared before ChangeGuard existed (seen on
  `/decisions/opportunities` earlier the same day). Its source was not found, because the
  minified build hides it and the dev build does not raise it.
- **The browser pane's own "stuck on Loading…" is a separate artifact.** Its window is hidden,
  so `requestAnimationFrame` never fires, and React's batched Suspense reveals (`$RB`, waiting
  on `requestAnimationFrame`) never flush.

## R-20 resolved (2026-11-11, evening)

The suspect above was real but not the whole story: three independent causes.

| # | Cause | How it was found | Fix | Proof |
|---|---|---|---|---|
| 1 | **React #418 on every page, for every non-guest role.** `getViewer` returned the guest before calling `cookies()` when demo mode was off. `next build` runs without `DEMO_MODE`, so the viewer touched no request API at build time and was prerendered into every static shell as "Guest · read-only". The request-time payload named the real role: a text mismatch | Role × page matrix on the production build (guest and no cookie: clean; marketing and approver: #418 everywhere). Then a text diff of the server DOM (Next's chunks blocked) against the hydrated DOM: one line differed, `viewer-label`. The prerendered `.next/server/app/*.html` contained the guest label | `cookies()` is read first, demo mode or not | `tests/unit/get-viewer.test.ts` fails on the old order. New production gate `z-quality-gates` "hydration": every page as its role, no hydration error, no guest label in the HTML; **red on all 19 pages before the fix, green after** |
| 2 | **The Overview stalled on its skeleton.** The seed drops and rebuilds the schema and never ran `ANALYZE`. Statistics then arrive table by table from autovacuum, and 8 of 29 filled tables still had none minutes later. Without them the conversion bridge planned badly | A stall reproduced outside the test runner (seed, then click Start at once). `pg_stat_activity` at the stall: two `conversionBridge` queries running 20 s, autovacuum mid-`ANALYZE`. Not the hydration error: the stall recurred with #418 fixed (3 of 10 runs) | The seed ends with `ANALYZE` | Same data, statistics deleted vs present: conversion bridge **27–32 s vs 0.3 s**; every other Overview query equal or faster with statistics. `scenario.test.ts` asserts every filled table was analyzed; **red without the line** (27 tables listed) |
| 3 | **Tests asserted 5 s on 5 s operations.** Dry run and execution each re-project, reconcile and snapshot every branch twice: 4.9–5.4 s over HTTP analyzed, 6.0–6.5 s without statistics. Eight scorecard queries at 0.7–0.9 s each are most of it (statement log at 150 ms). With the stall gone, B09 step 6 failed 5 of 5, and the full suite failed 5 tests, all at a dry run or execution | Trace: the execute POST took 4.8 s, so the refresh that renders the result began after the assertion expired | Every dry-run and execute click waits for its own response (`runProposalAction` in `tests/e2e/action-center.ts`, 8 call sites in 3 specs), as the B09 dry-run step already did (fdd7b79). No assertion timeout was raised | — |

Not a cause: the burst of runtime prefetches `/demo` starts (one per nav link). The router aborts
most within about 50 ms, and the database stayed idle while they ran.

| Run (production server, `CI=1`) | Result |
|---|---|
| B09 path, hydration fix only, 10 runs, each reseeded | 7 passed, 3 failed (all step 1, the stall) |
| B09 path, plus the seed's `ANALYZE` | 4 of 4 failed at step 6 (cause 3), then stopped |
| B09 path, all three fixes, 10 runs, each reseeded | **10 / 10 passed**; the path test took 21.7–23.5 s |
| Full suite, `VISUAL=1`, before the shared helper | 57 passed, 1 skipped, 5 failed (all cause 3, or a test needing that one's executed proposal), 17.5 min |
