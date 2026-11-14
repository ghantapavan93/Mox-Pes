# B09: one operational handoff (2026-11-14)

An analyst with no run ID starts from the B09 incident (#2455). From it they must:
1. find who owns the investigation;
2. trace the source delivery that changed the evidence, through its accepted revision, to the
   verification result;
3. see what remains for a person to review.

The cross-view design (`B09-CROSS-VIEW.md`) is accepted as it is; R-52 was not reopened.

## Synthetic setup

The world is the isolated `revenue_signal_b09` database (demo seed) on a production build
(`next start`, demo roles, port 3400). The harness is `C:/Temp/b09h.ts`.

1. **Triage.** The incident is detected Oct 16; its case is #161. The analyst who triaged it hands
   the case to the integration engineer, from the incident's own Owner control: "Integration
   engineer", then Assign. The case records two events, each with an audit row:
   - `owner_assigned` (marketing, unassigned → engineer);
   - Detected → Investigating, "Owned by engineer".
2. **Deliveries.** The source re-sends through the ads feed (`C:/Temp/b09-correct.ts`):

   | Run | What it sent |
   |---|---|
   | #676 | Oct 26–30 |
   | #677 | Oct 13–25 |
   | #678 | An identical re-send of #677: 13 duplicates |
   | #679 | An older revision of Oct 20, $50 higher, fetched before #677's |

3. **Verification.** After #677, reconciliation verifies the window. It resolves the incident and
   the case: Investigating → Resolved, "Verified: all 18 required dates…".

**Totals.** B09's paid spend stayed at 1,664,923¢ throughout. Local Services went from 148,767¢ to
361,119¢, and Search from 1,230,039¢ to 1,017,687¢. Runs #678 and #679 changed nothing.

## Inventory: what already existed

| What the analyst needs | Where it already was | Reachable from the incident? |
|---|---|---|
| The incident itself, without a run or incident id | Overview → B09 → "Open incident #2455"; the Incidents list; Decision Lab's cleared hold | Yes |
| Who owns it | Incident → Fix & approval → Workflow: state, owner (a role), opened. The Incidents list's case queue has an owner column and filter | Yes |
| Who assigned it, and when | The case timeline ("Owner assigned · marketing · unassigned → engineer"), the case's audit rows (`case_assign`), Audit & Health (`case:161`) | Yes |
| The runs the verification rests on | Incident → Verification details → a table of run, mapper (`ads@1.2`), source revision (fetched), dates and spend | Text only |
| The delivery itself: stream, window, fetched, new, duplicates, status | Integrations → Ingestion pipeline → "Latest scheduled ingestion runs", the latest 27 | **No**: no link from the incident, and rows had no anchor |
| The accepted revision | The runs table's "Source revision (fetched)" for each run | Yes |
| The verification result | The recovery panel's conclusion; Verification details (four statements); Evidence → Resolution; the case timeline (Investigating → Resolved, with the rule it met) | Yes |
| What remains for a person | The incident's next action, then Decision Lab: "Ready for review", the cleared hold, and "Other checks need review: 2 of 4 channels", with each channel's reason | Yes |

The incident's Records section also lists stored spend records, superseded or projected, but only
its first 14 rows from three days before the gap.

## The walk as it was

Build `lFV-pAN0TP9t3eIb0LzBN` is the code at `0e7d36d`. The handoff could be completed: **32/32
checks pass**. Its cost:

- **Clicks:** 11 at desktop, 12 at phone (the phone needs the menu).
- **Context re-entered:** run #677. The reviewer read it on the incident, then looked it up by
  number in a 27-row table on Integrations → Ingestion pipeline.
- **Repeated work:** Back from Integrations reached `/exceptions/2455?period=oct#action-center`, but
  the page still showed Integrations. One more Back was needed.

**Why Back failed.** The incident's section links ("Evidence", "Fix & approval", …) were plain
`#` anchors. The browser keeps their history entries, but the app's router does not own them. Once
the reviewer had left the page, Back to such an entry changed the address and nothing else.

## The change

Two changes, each the smallest that removes what the walk found. No new timeline, owner system,
dashboard or chart.

1. **The missing link.**
   - **What it does.** On the incident's verification, each delivery run's number now links to its
     row on Integrations → Ingestion pipeline (`/integrations?view=pipeline&run=677#run-677`).
   - **How the row is shown.** It is marked in words ("the run you followed") and in colour, and
     scrolled into view.
   - **Older runs.** The row is listed even when the run is older than the latest 27:
     `recentRuns(db, limit, include)`.
   - **Who sees it.** Only company-wide roles get the link, because only they may open the pipeline.
     Everyone else sees the number as before.
2. **Back.** `SectionNav` now uses router links instead of plain anchors. A section jump becomes a
   router history entry, so Back from another page returns to the incident. The same nav is on
   Decision Lab and Audit & Health.

## The walk now

Build `XR4Bib0xUk8aLTRhj-X_x`: **32/32 checks pass**.

**Clicks, the same at desktop and at 390 px:**
1. Choose B09 in the What changed branch list.
2. Show.
3. Open incident #2455.
4. Fix & approval.
5. Verification details.
6. Ingestion run #677.
7. Back.
8. Open Decision Lab.

| | Before | After |
|---|---|---|
| Clicks, desktop / phone | 11 / 12 | 8 / 8 |
| Context re-entered | Run #677, looked up by number on another page | None |
| Repeated work | One extra Back, with the wrong page under the incident's address | None; Verification details is still open after Back |

**Time savings: not claimed.** Both walks are scripted. Their wall-clock times measure page loads,
not a person searching a table, so they are no comparable baseline. Only clicks, re-entered context
and repeated work are reported.

## What the reviewer reads at each step

| Step | Shown |
|---|---|
| Incident | "Coverage hold cleared: all 18 dates in the decision window (Oct 13–Oct 30) have Google Local Services spend at B09, verified …", then "Reclassified, not added: the $2,123.52 first filed as Google Search is now filed as Google Local Services." |
| Owner | Workflow, case #161. State: Resolved. Owner: Integration engineer · all branches. The timeline shows Owner assigned (marketing, unassigned → engineer); Detected → Investigating (marketing, "Owned by engineer"); Investigating → Resolved (reconcile, "Verified: all 18 required dates…") |
| Runs | Run #677: `ads@1.2`, fetched Oct 31, 1:10 PM UTC, Oct 13–Oct 25, $1,526.35. Run #676: `ads@1.2`, fetched 1:00 PM UTC, Oct 26–Oct 30, $597.17. Neither the duplicate (#678) nor the older revision (#679) is among them |
| Delivery | Run #677: `ads`, `ads@1.2`, window Oct 31 1:05–1:15 PM UTC, 13 fetched, 13 new, 0 duplicates, succeeded. Beside it, #678 shows 13 duplicates and #679 shows 1 new |
| What remains | "Ready for review" and "Nothing here approves a budget change." "Coverage hold cleared, incident #2455." "Other checks need review: 2 of 4 channels": Google Local Services (#970, an unmapped B44 Local Services campaign) and Google Search (5 door-to-door conflicts) |

Screenshots of each step are in `b09-handoff/before/` and `b09-handoff/after/`, at 1280 and 390.
The results, with every click and URL, are in `walk-before.json`, `walk-after.json`,
`roles-after.json` and `assign.json`.

## Roles

| Viewer | Context | Result |
|---|---|---|
| Owner (integration engineer) | Same incident | Sees the case as theirs, and the run link |
| Branch partner (B20) | Fresh browser context | No B09 evidence |
| Brand viewer (B40–B44) | Fresh browser context | No B09 evidence |

The partner and brand viewer requested four URLs each: the incident, the run's pipeline page, the
owner-filtered incident list, and the case API. There are 10 checks in all.

**Not production-ready access isolation.**
- Demo roles are a cookie (R-2).
- A role switch in the same tab keeps earlier routes' hidden DOM, as `B09-CROSS-VIEW.md` recorded:
  the visible page, Back and direct links show nothing, but what a tab already received stays in it.

## Tests

- **`tests/integration/b09-recovery.test.ts`:** a linked run is listed however many runs came after
  it (`recentRuns`).
- **`tests/e2e/zz-b09-four-minute-path.spec.ts`:** added after the timed walk, so the four-minute
  check is unchanged. It covers the section jump, the run link to its marked row, and one Back to
  the incident.
- **Earlier browser checks, rerun on the new build:** cross-view verified state 80/80, keyboard
  13/13, restricted viewers and same-tab switch 28/28.
- **Regression** (`C:/Temp/regression-b09h.sh`, one sequential run on this change):

  | Step | Result |
  |---|---|
  | Typecheck, lint | Pass |
  | Vitest | 77 files: 916 passed, plus the 1 known expected failure (R-39) |
  | The five frozen eval packs | Identical to the cross-view run, except a process id in a warning and the recorded base commit |
  | Build | Pass |
  | Full browser suite, with pixel comparisons | 125 passed, 1 skipped (the opt-in demo-video recording), 0 failed, in one run (24.0 min) |

  The browser suite includes the B09 path's new handoff steps. No pixel baseline changed.

## What remains, unchanged

- **Owners are roles,** such as "Integration engineer", not named people. That is the existing model.
- **The case resolves itself** when its incident verifies; no one is asked to confirm. What remains
  for a person is Decision Lab's review of two channels, and the budget decision itself.
- **"New" counts versions stored, not versions accepted.** Run #679's older revision shows "New 1"
  although it changed nothing (R-51). The incident's run table is the authority on what the
  verification rests on.
- **Stored spend records:** the incident's list shows only the first 14 rows from three days before
  the gap, so it cannot show every date's accepted revision.
- **R-46:** the 45 Local Services calls carrying a Performance Max id stay unresolved.
- **Demo roles:** the same-tab cache limitation (R-2) still applies, as above.
