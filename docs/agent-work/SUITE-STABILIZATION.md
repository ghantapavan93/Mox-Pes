# Browser-suite stabilization: the two timing failures (2026-11-16)

**Verdict: promoted. `d431e9b` (build `cVimzqQcl7kG4UNywLQfF`) is the accepted local synthetic
demo checkpoint.** It passed the full regression in one run; its browser suite had 125 passed, 1
skipped and 0 failed. The acceptances of `28e498b` and `91ef06f` stand as recorded
(`RELEASE-CANDIDATE.md` §4, §8).

The full browser suite failed twice on `60cb483`, the bring-your-own-file candidate
(`BYOF-WORKFLOW.md` §7). Each failure was a different test. This pass found one cause for each and
reproduced it before fixing it:

| Failure | What was wrong | Cause | Fix |
|---|---|---|---|
| The drift review's "stale save": the conflict notice was shown but not focused | The app lost the focus | Focus was requested in a frame callback right after `setConflict`. When the frame came before React put the notice on the page, the callback found nothing to focus | `f372aca`: the notice takes focus in an effect, after it is on the page |
| The replay panel's dry run: no result within 5 s | The test waited on the wrong event | The test allowed a fixed 5 s for a request that takes 3.1 to 3.5 s. A slower answer failed the test, though the page still showed the result | `d431e9b`, test only: each click waits for its own dry-run request, as R-20 made every other dry-run click do |

The candidate is now `d431e9b`: `60cb483`'s upload change plus these two fixes. Nothing else
changed in code.

## 1. What was kept from each attempt

- **Run 1** (`60cb483`, full suite): the failing test's trace is kept in `stabilization/run1/`,
  with its timeline as text.
- **Run 2** (`60cb483`, full suite): its traces were cleared by the next run before this pass. Only
  the logged errors remain (`byof/verify-60cb483.txt`).
- **This pass:** every attempt wrote to its own output folder (`C:/Temp/stab/<attempt>/`), so none
  cleared another. a1 kept all 125 traces (271 MB, left in `C:/Temp`). The summaries are in
  `stabilization/runs.txt`.
- **Diagnostics** (`stabilization/harness/diag-init.js`) were injected in the verification worktree
  only, never committed (`harness/diag-with-delay.patch`). They logged:
  - every `focus()` call, with its caller;
  - frame callbacks that move focus: when each was requested and run, and whether the notice
    existed then;
  - insertion and removal of the notice, the form, the replay panel and its result;
  - `document.hasFocus()`;
  - the two API calls' timing;
  - whether React was attached to a clicked button.

## 2. The stale-save focus: the app lost it

**Run 1's trace** (`stabilization/run1/timeline.txt`), in seconds from the test's first action:

| Time | What happened |
|---|---|
| 4.637 | The save is refused: 409, in 19 ms |
| 4.660 | The `?since=4` refresh starts |
| by 4.675 | The notice is on the page ("Not saved: newer evidence arrived") |
| 4.709 | The first focus check: "inactive". Every check for the next 5 s says the same |
| about 4.75 | The refresh returns, after the first check |

So the notice was never focused, and the refresh did not take focus away from it. Playwright's
"inactive" means another element is active, or the document lacks focus; the trace alone cannot
say which.

**Reproduced** with `harness/focus-race.cjs`. It runs the shipped component on the candidate build,
repeating the refused save in a fresh browser context each time. The 409 comes from a route
handler, with the server's conflict body, so no stored state moves.

| Browser CPU | Before the fix (`60cb483`) | After (`f372aca`) |
|---|---|---|
| Normal | 0 of 40 lost focus | 0 of 40 |
| 4× slower | **35 of 40 lost focus** | 0 of 40 |
| 6× slower | — | 0 of 40 |

**Every loss had the same sequence** (`stabilization/focus-race-before.jsonl`):
- the callback ran while the notice was not yet in the DOM;
- no `focus()` call reached the notice;
- focus stayed on the page body.

In one loss, at 4× slower:
- the response arrived;
- 43.7 ms later, the callback was requested;
- 4.7 ms after that, it ran and found no notice;
- 23.6 ms after that, the notice was inserted.

When focus was kept, the notice was inserted first and the callback then focused it.

**Why the frame could come first.** `setConflict` runs after an `await`, outside any React event,
so React renders it in a task it schedules. The frame callback is requested at the same moment.
Whichever runs first wins, and a slower machine gives React's render less chance to finish first.

The "Record a decision" button uses the same pattern, but its update happens inside a click, which
React commits before the next frame. In all six uses in v1 and a1, the form was inserted before
its callback ran, and the first field took focus. That path was not stress-tested.

**The fix (`f372aca`):** an effect focuses the notice whenever a new conflict is on the page. No
test changed. In the full suite with diagnostics (a1), the effect focused the notice 3.7 ms after
it was inserted.

## 3. The replay dry run: the test gave up early

**What run 2 left:**
- both clicks failed with "replay-result: element(s) not found" after 5 s;
- the four tests after the first did not run;
- no server error was logged near them.

**Measured** with the diagnostics, click to response:

| Run | First click (`golden-path.spec.ts:31`) | Second (`:111`) |
|---|---|---|
| v1: the two specs alone | 3.28 s | 3.24 s |
| a1: full suite | 3.08 s | 3.52 s |

- The result appeared 9 to 25 ms after each response.
- No panel was removed or replaced between a click and its result, and every click reached a
  button React was attached to.
- In a1, the first dry run overlapped an autovacuum of `raw_events`, with total CPU at 30 to 56%.
  It still took 3.08 s (`stabilization/diag/a1-pg-activity.log`, `a1-cpu.log`).
- Run 2's slowdown, at least 1.5 s on both clicks, did not recur and stays unexplained.

**Reproduced** by holding the dry run's response 2.5 s, as a slower server would answer. The hold
was a route handler in the worktree only.

| Attempt | Result |
|---|---|
| The unchanged test (d1) | Both clicks failed with run 2's message, word for word, and the four tests after the first did not run. The trace shows the page's request still open when the test gave up at 5 s; the server had answered in 3.14 s |
| Waiting on the request (d2) | 9 of 9 passed. The responses came at 6.44 s and 5.41 s; the result appeared 23 ms and 9 ms later, complete |

So the app keeps the result and shows it whenever it comes; the fixed window was the defect. In
`d1` the line numbers read `:50` and `:130` because the diagnostics hook sits above them.

R-20 found the same for the other dry-run clicks on 2026-11-11 and made each wait for its own
request (`tests/e2e/action-center.ts`). These two were missed.

**The fix (`d431e9b`, test only):** each click waits for its POST, checks that it returned 200, then
asserts exactly as before. No timeout value, assertion or expected text changed. The wait is
bounded by the test's existing 60 s limit.

## 4. Verification on the candidate, `d431e9b`

| Check | Result |
|---|---|
| The two affected specs, clean (c1) | 14 of 14 (build `LiVl4dgd_L8o9yItqTqL5`) |
| `npm run acceptance:byof`, from a fresh worktree | 54 of 54. Exit 0 in 62 s; the demo database unchanged (`stabilization/byof-d431e9b/`) |
| Full regression, one run, on empty databases | Every step exit 0. Vitest: 940 passed, 1 expected failure. Browser suite: 125 passed, 1 skipped, 0 failed (27.4 min) |

**The full regression:**
- **Where:** the worktree `C:/Temp/rso-rc` at `d431e9b`, build `cVimzqQcl7kG4UNywLQfF`, with
  `revenue_signal_rc`, `_test` and `_eval` recreated empty.
- **How:** the same script as `28e498b`'s (`RELEASE-CANDIDATE.md` §7).
- **Steps:**
  - install, 33 migrations on an empty database, build, typecheck and lint;
  - vitest: 79 files, 940 passed and the 1 known expected failure, as at `60cb483`;
  - the seed: 675 runs, 134,088 raw events;
  - the five frozen eval packs: identical to `28e498b`'s run, except the recorded commit and one
    process id;
  - the browser suite with pixel comparisons: no baseline changed, no tracked file changed.
- **The skipped test:** the opt-in demo-video recording, as at `28e498b`.
- **Server errors:** two, neither affecting a test:
  - the twin's injected CRM outage;
  - once, the identity consumer's "`domain_events` does not exist", during the suite's own reseed.
    This is the known reseed race.
- **Record:** `stabilization/verify-d431e9b.txt`.

## 5. What this does not prove

- **Run 2's trigger.** What slowed run 2's dry runs is unknown, because its traces were gone. The
  fix makes the test independent of it.
- **The focus race's trigger.** It was reproduced by slowing the browser's CPU, not by the full
  suite's own load. Run 1's trace has the same signature; a1 did not lose focus.
- **No performance budget.** The two tests now accept a dry run as slow as the test's 60 s limit,
  and a dry run that slow would no longer fail them. The suite has no performance budget.
- **Other fixed windows.** The other 5 s windows in the suite were not audited (R-41).
- **One clean run.** Promotion rests on one full run, not on a failure rate.
