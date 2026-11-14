# B09: one reading order across four views (2026-11-14)

A focused design pass on the B09 journey after the verified recovery (`B09-RECOVERY.md`, commit
`2755e13`): Overview → daily evidence → incident → Decision Lab. Same design system, routes and
recovery logic. Not a redesign and not a backend change.

## The rule

Every view reads **conclusion → reason → next action**, with one primary action per state, labels
that read without colour, and the same branch, channel, period and week on return.

**The status has one source.** `lib/reconcile/gap-status.ts` turns what the incident already stores
into words:

- its status (open or resolved, which reconciliation sets);
- its original finding (the successor's spend and the channel it was filed under);
- any stored verification;
- its window as the accepted records cover it now (`gapCoverage`, unchanged).

Every view quotes those words. None computes a verdict of its own, keeps a status store, or names
B09 in its copy. Decision Lab's readiness reasons use the same clause through `stillMissing`.

**Two scopes are named apart everywhere.**

| Term | Meaning |
|---|---|
| Decision window | The dates the incident requires (its verification scope): Oct 13–Oct 30 for B09 |
| Selected week | A viewing filter from the Overview's chart, never the decision rule |
| No record | A required date with no spend record |
| Recorded $0.00 | A required date whose only record says $0.00; named apart from "no record" |

## What changed, view by view

| View | Before | After |
|---|---|---|
| Overview ("What changed") | "Investigate before acting", then a link to the bare incident. In the partial state, the headline said spend "changed from Oct 13", and the detail repeated the original finding ($2,123.52 filed as Search) as if nothing had moved. The selected week's panel never mentioned the decision window, and called the chart's own range "the window". | One decision status: the incident's label ("Decision held", "Decision still held", "Coverage hold cleared"), why, and **Open incident #N** at its recovery. The detail is the before/after fact. The selected point's panel adds how the week stands against the decision window, in a bordered note. "In the window" is now "on the chart". The chart is unchanged. |
| Daily evidence | Led with "Where does $16,649 come from?" (the branch's trace). The week's records followed. The incident callout repeated the stored finding: "filed as Google Search", even after recovery. | The page heading is the selected dates ("Google Local Services · Oct 26–Oct 30"). The card leads with this week's records and the decision window's state, side by side. Then the daily rows, still telling "no spend record" from "recorded zero". Then one primary action, **Open incident #N**. The trace follows under its own heading, with its actions secondary. |
| Incident | A large panel: four statements, a runs table, a long "Next" paragraph, two buttons and two links. | A short conclusion, the most useful before/after fact, and one next action: open the records still missing, or Decision Lab once verified. **Verification details** keeps the scopes, the four statements, the original finding and the delivery runs one click away. "Investigate with AI" is secondary on this kind, so the panel's action is the page's one primary. |
| Decision Lab | Green **Ready**: "Every paid channel at B09 passes the readiness checks". Nothing said the coverage hold had been lifted, or that two channels still needed review; those sat far below. | **Ready for review**, with "Nothing here approves a budget change." Then two lines together: "Coverage hold cleared, incident #2455", what was verified and that it was reclassified, not added. Then "Other checks need review: 2 of 4 channels", with each channel's first reason. One primary action, **Review the 2 channels**. Held states keep **Not ready** and the blocking incident, which is now a button to the same incident evidence. |

The decision status, the window line and the before/after fact are the same sentences on every
view. The table below gives them for B09.

| State | Conclusion | Before/after |
|---|---|---|
| Missing | Decision held: none of the 18 dates in the decision window (Oct 13–Oct 30) has Google Local Services spend at B09. | Since Oct 13, $2,123.52 has been spent under pmax-lsa-B09, which is filed as Google Search; none of it is filed as Google Local Services. |
| Partial (Oct 26–30 re-fetched) | Decision still held: 5 of 18 dates in the decision window (Oct 13–Oct 30) have Google Local Services spend at B09; Oct 13–Oct 25 still have none. | Originally $2,123.52 was filed as Google Search. Now $597.17 (Oct 26–Oct 30) is filed as Google Local Services; $1,526.35 (Oct 13–Oct 25) is still filed as Google Search. |
| Verified | Coverage hold cleared: all 18 dates in the decision window (Oct 13–Oct 30) have Google Local Services spend at B09, verified Oct 31, 1:15 PM UTC. | Reclassified, not added: the $2,123.52 first filed as Google Search is now filed as Google Local Services. |

**When "not added" is said.** "Reclassified, not added" appears only when three things hold: the
gap is verified, nothing in the window is misfiled, and the window carries exactly the amount the
original finding recorded elsewhere. A source revision that changes the amount is said as two
figures instead. A unit test pins this.

## Browser evidence

**Setup.** Production builds (`next start`, demo roles) ran on the isolated `revenue_signal_b09`
world (demo seed, then `C:/Temp/b09-correct.ts partial | rest`). The browser checks are in
`C:/Temp/b09x.ts`. The world reproduced `B09-RECOVERY.md` exactly at every step:

| Step | Run | B09 Local Services | B09 Search | B09 total | Incident #2455 |
|---|---|---|---|---|---|
| Missing | — | 148,767¢ | 1,230,039¢ | 1,664,923¢ | open |
| Partial | #676 | 208,484¢ | 1,170,322¢ | 1,664,923¢ | open |
| Verified | #677 | 361,119¢ | 1,017,687¢ | 1,664,923¢ | resolved |

**Builds.**
- Before: `9aJhdacGJdo12cjFwZTFb`, the code at `2755e13`.
- After: `bRJreGxXpP4UhmNZmlS6n`, this change.

**Screenshots.** `b09-cross-view/before/` and `b09-cross-view/after/` hold the same 24 shots:
- 3 states × 4 views × desktop 1280 and phone 390;
- each taken where the analyst lands: the Overview and incident at their anchors, the daily
  evidence at its top, Decision Lab at `#readiness`.

The first "before" set hid Decision Lab's summary under its sticky section bar: the harness's own
scroll was at fault. The harness now lands the way a link does (`scrollIntoView`, honouring the
page's scroll margin). The committed code was rebuilt and every "before" shot retaken, so both sets
use one procedure.

| Run on the after build | Checks | Result |
|---|---|---|
| Missing: the walk from the Overview's own controls, desktop and phone | 62 | all pass |
| Partial: the same | 64 | all pass |
| Verified: the same | 80 | all pass |
| Restricted viewers, fresh contexts, and a same-tab downgrade | 28 | all pass |
| Keyboard only | 13 | all pass |
| Brand filter carried through all seven links | 7 | all pass |

**The decisive check (partial, Oct 26–30 complete).** Each view says why October is still held
without opening anything. "Visible" means `innerText`, which leaves out closed details:
- **Overview:** "Decision still held. 5 of 18 dates … Oct 13–Oct 25 still have none." The selected
  point adds: "This week's dates in the decision window are covered, but the window (Oct 13–Oct 30)
  is not…".
- **Daily evidence:** the same window line sits beside "All 5 days have a spend record: $597.17 in
  all." It is on the first screen at 1280 and at 390.
- **Incident:** the conclusion and before/after are shown; the four statements are not.
- **Decision Lab:** "… Oct 13–Oct 25 still have none, so it still holds."

**After recovery.**
- **Incident and Overview:** both say "Reclassified, not added".
- **Decision Lab:** the cleared hold and "Other checks need review: 2 of 4 channels" sit within
  24 px of each other. The review lines are #970's unmapped B44 Local Services campaign (Local
  Services) and five door-to-door conflicts (Search).
- **"Ready":** the label reads "Ready for review". A note says the table's "Ready" is not an
  approval and does not cover those checks.

**One primary action per state.** Counted from rendered styles, not testids:

| View | Primary action |
|---|---|
| Overview panel | Open evidence |
| Daily evidence | Open incident #2455 |
| Incident, held | Open the records for Oct 12–Oct 18, the first week still missing spend |
| Incident, verified | Open Decision Lab |
| Decision Lab, held | Open incident #2455 |
| Decision Lab, ready | Review the 2 channels |

The incident page header has no competing primary action.

**Scope on return.** These links keep `branch`, `period`, `channel`, `week` and `brand`:
- Decision Lab → incident (`?period=oct&channel=google_lsa&week=2026-10-26#recovery`);
- incident → daily evidence (`#selection`);
- daily evidence → Overview (`/?period=oct&branch=B09&channel=google_lsa&week=2026-10-26#movement`),
  where the same selection is restored.

**Restricted viewers.** The branch partner (B20) and the brand viewer (B40–B44) each ran in a fresh
context, on six URLs:
- the Overview with B09 selected, and the B09 daily evidence;
- the incident, and Decision Lab for B09;
- their own Decision Lab and Overview.

Server responses carried no B09 evidence:
- campaign ids, "Coral", "at B09";
- the dollar figures;
- the incident's link or number;
- the window, or the words "decision window".

The rendered pages carried none either.

**Same tab.** A marketing analyst read the verified incident and Decision Lab, then switched to
the partner with the role picker:
- **Shown:** the page, Back and direct navigation show nothing of B09.
- **Retained:** the previous route's hidden DOM still holds B09 text already delivered. It is
  recorded, not counted as a pass (R-2: demo roles are a cookie). A switch does not erase what a
  tab already received.

**Keyboard.** Every new link and the "Verification details" summary are in the tab order, with
visible focus. Enter opens and closes the details. The Decision Lab review action moves to
Verified readiness.

## Tests

**New.**
- `tests/unit/gap-status.test.ts`, 11 tests:
  - the five states;
  - "no record" against "recorded $0.00";
  - spend at another branch counted as misfiled;
  - "reclassified, not added" only on equal amounts;
  - the week against the window;
  - the Overview quoting the status rather than recomputing it.

**Added to existing tests.**
- `b09-recovery.test.ts` now pins the shared status in the missing, partial and verified states.
- It also checks that a September Decision Lab does not show October's cleared hold.

**Updated expectations, each with a comment in the test.**

| Test | Before | Now |
|---|---|---|
| `b09-recovery.test.ts` | "5 of 18 required dates now have…" | The full window clause |
| `overview-movement.test.ts` (integration) | "Investigate before acting" | The incident's status and id |
| `zy-overview-movement.spec.ts` | Daily evidence heading: level 2, "Selected on the Overview: …" | Level 1, the selected dates |
| | Overview status: "Investigate before acting" | "Decision held. None of the 18 dates…", with its evidence link |
| | — | The window line and the incident link are checked on both pages |
| | Partner check: one phrase that no longer exists | Five strings |
| `os-golden-path.spec.ts` | Decision Lab's incident link ended at `?period=oct` | `#recovery` is part of the link |
| | After the fix: `not.toContainText('#id')` | No blocker remains, the cleared hold names the incident, and its link is exact |
| `zz-b09-four-minute-path.spec.ts` | `not.toContain('/exceptions/<id>"')` | Asserts no blocker link to the incident and a cleared-hold link to it |

The `zz-b09` check before this change matched no link once links carried a query (since
`2755e13`). It passed whatever Decision Lab said.

**Pixel baselines.** `incident-1440` and `incident-390` changed, deliberately. Aligned below the
recovery panel, the old and new full-page images match except one anti-aliased row of 6 px at 1440
and three rows at 390, on one badge's edge. The change is the compact panel and the header's
secondary "Investigate with AI". The Overview baselines are unchanged.

**Regression** (`C:/Temp/regression-b09x.sh`, one sequential run on this change):

| Step | Result |
|---|---|
| Typecheck, lint | Pass |
| Vitest | 77 files: 916 passed, plus the 1 known expected failure (R-39) |
| The five frozen eval packs | Identical to the recovery milestone's output, except a process id in a warning and the recorded base commit |
| Build | Pass |
| Full browser suite, with pixel comparisons (`CI=1 VISUAL=1`) | 125 passed, 1 skipped, 0 failed, in one run (26.2 min). The skip is the opt-in demo-video recording. No retries are configured |

This is one fully green full run for this change. The recovery milestone (`2755e13`) never had one:
its three full runs each failed something.

**After the regression.** `scripts/measure-decision-lab.ts` (R-34's timing harness) still looked
for a bare `/exceptions/<id>` link and a "Ready" badge.

- **Stale since `2755e13`.** Links carry a query since then, so the harness could no longer see a
  hold as usable.
- **Fixed.** It accepts the link with its query and `#recovery`, and "Ready for review". It also
  times the page's new read.
- **Rechecked:** typecheck, lint, and the harness itself on the main world (`direct`, three runs
  each):

| Scenario | Hold usable after | Link |
|---|---|---|
| B09 | 357–515 ms | `/exceptions/2455?period=oct#recovery` |
| B40 | 356–454 ms | — |
| B20 | 356–420 ms | `/exceptions/1063?period=oct#recovery` |

R-34's earlier range was 0.34–0.49 s. In the page's batch, the new read (`gapStatusesAt`) finished
at 105 ms, before the verdicts (212 ms) that the hold waits for.

## What remains

- **The Overview's cleared status** says what cleared and that spend was reclassified. It does not
  list Decision Lab's review items: that would need Verified readiness on the Overview (1.2–2.3 s).
  The incident's next action, and Decision Lab, carry them.
- **The verdict matrix** still shows per-channel "Ready" badges. The summary above it says what that
  label means. The matrix was not changed.
- **Missing-state wording:** Decision Lab's blocker reason is the incident's original summary.
  Adding the window clause there would change verdict text that the frozen eval packs read, on an
  untouched incident.
- **Same-tab role switches** keep earlier routes' hidden DOM (R-2), as before.
- **`MovementSkeleton`'s reserved heights** were measured for the company-wide panel. A single
  branch's panel is now one line taller in the held states, so it can still move on arrival there.
  The company-wide hold-jump test is unaffected.
