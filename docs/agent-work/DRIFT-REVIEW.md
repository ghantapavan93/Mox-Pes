# Drift review: deciding a post-release drift on its case (2026-11-13)

Synthetic data only, local only. Nothing is pushed or deployed. It extends the existing incident
case. There is no new dashboard, notification channel, attribution rule or Decision Lab change.
R-39, R-46 and the FI-4 ruling (R-36/R-50) stay open.

**Done means:** a reviewer can find and understand one case, and save a decision that survives a
reload. Repeat evidence leaves that decision alone. Materially new evidence reopens the same case
and says why. The case history explains every transition. No business record changes.

## 1. Baseline (HEAD `d5242c2`, production build, isolated database)

The fixture was built through the product's own paths on a fresh synthetic seed:
`revenue_signal_drift`. ChangeGuard proposed and released `lsa-B44-x` → B44, a different person
approved it, and the real worker ran every check. Facts checked in the stored check (run #2):

| Fact | Stored value |
|---|---|
| At release | 10 of 10 leads at B44 (`verification.releaseEvidence`, verdict `agrees`) |
| Latest check | 9 at B44, 1 at B39 (verdict `split`) |
| What moved | call `CAL00017269`, B44 → B39, its two stored versions (raw #142876, raw #200015) |
| Mapping | still B44, mapping version 2 |

**What a reviewer had to do before they could explain it** (recorded by Playwright; screenshots
`screens/baseline_*`):

| Step | Page |
|---|---|
| 1. Open Incidents, then click the drift type | queue |
| 2. Click the case | case page: "1 lead(s) … arrive outside the evidence"; B39 not named. Raw evidence keys (`Run id`, reason codes). The decision panel said "No manual action — clears when the data agrees", which is wrong for this kind: monitoring never clears it, and there was no way to record a decision |
| 3. Click "Open check #2 of change #1" | check evidence page: B39 first named here |
| 4. Click the change in the breadcrumb | ChangeGuard decision summary |
| 5. Click "Review the changed lead" | customer journey, at the lead's row |
| 6. Click `raw #…` | drawer: the current version (B39) |
| 7. Click the older version | drawer: the version at release (B44) |

So: 4 pages, 7 clicks, and the two versions one at a time. The case itself could not hold a decision.

## 2. References, opened, and what was taken from each

All eight pages were fetched on 2026-11-13. These are design input; no component library was added.

| Reference | Borrowed | Where |
|---|---|---|
| Linear, UI redesign | Less chrome; meta properties moved aside; content above navigation and metadata | The business sentence is the page's largest text; ids, raw rows, exact times, lineage and audit rows sit in "Technical history", collapsed |
| Sentry, Issue Details | A header with status and owner; one representative event explains the issue | Status chip and owner in the header; the changed lead is "the event". The event-volume chart was left out |
| Stripe Radar, reviews | A review is a manual layer over automated scoring; "approve" closes the review and changes nothing on the payment | "Reviewed — no mapping change" closes the case and changes nothing on the mapping. The flag (system finding) and the disposition are separate lines |
| IBM Carbon, data tables | Expandable rows for extra detail, or a side panel when it is cramped. (The page gives no number-alignment rule) | Before/after columns in the drawer, changed fields first, unchanged fields behind a disclosure |
| Elastic, alert flyout | Details open in context over the list; status actions in the flyout footer | The versions drawer opens over the case. The decision is NOT in the drawer: it stays on the case |
| Fluent 2, Drawer | Overlay drawers are modal and dismissed with a close control; avoid stacked overlays. (Escape and focus are not covered) | One modal drawer, Close button and Esc, focus returned to the trigger (WCAG below) |
| Grafana, alert state history | An event appears "each time an alert instance changes its state" | The case history lists transitions and decisions only; repeated checks are in technical history ("Same evidence") |
| W3C WCAG 2.2 | 1.4.10 Reflow, 2.1.1/2.1.2 Keyboard, 2.4.3 Focus Order, 2.4.7 Focus Visible, 2.4.11 Focus Not Obscured, 3.3.1 Error Identification, 4.1.3 Status Messages | 320 px reflow test; keyboard order and focus checks in the browser spec; errors in text with `role="alert"`; the save result as `role="status"`. **Not a conformance claim** for this slice |

## 3. Two previews, one choice

Two read-only, runnable HTML previews used the same fixture and the product's tokens. They were
kept out of the repository: their screenshots are `screens/prototype-*`.

| | A: decision brief | B: evidence-first workbench |
|---|---|---|
| Desktop 1440 × 900 | headline, comparison, action at y = 589 | field table first, decision panel beside it, action at y = 465 |
| Phone 390 × 844 | action at y = 795 (above the fold) | action at y = 1,133, after the raw field table; the business sentence comes after `branch_tag` / `agent_note` |

**Chosen: A.** B gave raw field names and raw-event ids the most prominent place. On a phone it
pushed both the conclusion and the action below the fold. B's aligned before/after table moved
into A's evidence drawer. (The figures are for the previews, without the app shell. In the
product, the shell's header pushes everything down by about 220 px on a phone.)

## 4. What was built

**Case page** (`app/exceptions/[id]` → `components/incidents/DriftReview.tsx`, only for
`mapping_drift`). In order:

1. **What changed and what did not:** "One lead changed branches. The mapping stayed at B44." It is
   built from the stored case (`lib/changeguard/brief.ts`), with nothing about the fixture coded in.
2. **The proof:** "At release 10 of 10" beside "Latest check 9 of 10". Then each changed lead,
   "At release B44 → now B39 · moved at the source Nov 1, 7:05 PM UTC". Its two stored versions
   open in a drawer, field by field (`EvidenceDrawer.tsx`).
3. **Three separate lines:**
   - **System finding:** the check confirmed a change and changed nothing. It links to the
     check's evidence.
   - **Decision:** the human disposition.
   - **Business outcome:** no revenue impact was measured; the spend at stake is not a loss; a
     revision does not show the mapping is wrong.
4. **What to do next:** one primary action, "Record a decision", for roles that may decide; a
   read-only reason for the others; nothing on a reviewed case.

A reviewed case leads with the decision, who made it and why. A reopened case leads with what is
new since that review, links to its versions, and keeps the earlier review under "Decisions on
this case". The case history lists every transition in words. Checks and audit rows are in
"Technical history", collapsed. ChangeGuard only points here: on a reviewed drift its summary's
next step is "Read the review" (not primary).

**Decisions** (`lib/changeguard/review.ts`, `POST /api/exceptions/:id/review`, migration 0028):

| Disposition | Case | Exception | Recorded |
|---|---|---|---|
| Reviewed — no mapping change | → `closed_acknowledged` (the existing "a person accepted it" exit) | `acknowledged`, resolution names the review and check, and says the mapping was not re-verified | `case_reviews` row: actor subject and role, business time, disposition, rationale, the check read (`run_id`), its material facts and their key. Transition with the review id. `drift_review` audit row |
| Needs investigation | → `investigating` (or stays), owner role set | stays `open` | the same row, plus owner (required, an existing owner role) and "what needs checking"; `owner_assigned` event (the existing assignment convention) |

`case_reviews` is append-only (trigger, like `audit_log`). The generic "assign" and "close without
a fix" refuse drift cases (409). Without that refusal, they would skip the owner statement and the
evidence binding.

## 5. Recurrence: facts, not check ids

A drift's **material facts** (`lib/changeguard/facts.ts`):

| Fact | When |
|---|---|
| `lead\|source\|source lead id\|branch` | a contradicting lead, named by its source id, never by the raw event of its current version |
| `mapping\|branch` | the live mapping moved without a release |
| `verdict\|value` | the coverage verdict worsened, and to what |
| `withdrawn` | the leads the release relied on were excluded |

Recurrence compares the newest check's facts with the facts the latest "reviewed — no mapping
change" saw, under the mapping lock every check takes (`upsertReviewItem` in `monitor.ts`).

| Case | Result | Proven by |
|---|---|---|
| Duplicate delivery of the revision | stays reviewed | integration test, browser spec, live walkthrough |
| Edit to a field the check does not judge (agent note) | stays reviewed; "moved at" stays the first move | integration test, live walkthrough |
| Two workers on one slot, plus a manual re-check (new check ids) | one conclusion per slot; no reopen, nothing created | integration test |
| Rows in another order, later timestamps, `FEED_STALE` beside the drift | the same facts, the same key | unit test, integration test |
| A failing feed (latest run 503) | drift with the same facts plus `FEED_STALE`: stays reviewed | integration test |
| A check that errors, a late or overdue slot, an ambiguous id (R-46) | not a contradiction: concludes nothing, or `insufficient_evidence`; the case is not touched | integration test (error); the R-30 monitoring tests (overdue, ambiguity) |
| **A second distinct lead outside the approved branches** | **the same case reopens once**: `closed_acknowledged → detected`, `reopen_count + 1`, the transition names the check and the review it outdates; the review is kept | integration test (with two workers and a manual check racing), browser spec, live walkthrough |
| The same new evidence again | no second reopen | integration test |

**Covered by the same rule, unit-tested only:** the same lead moving to another outside branch,
the mapping moving after a review, the verdict worsening again. Each is a new fact, so each reopens.

**Out of scope (no policy invented):**
- A contradiction that shrinks or disappears after a review: the case stays reviewed, with no
  automatic close or resolve.
- New evidence on a case under investigation: it is open already; the page marks leads new
  against the last closing review or the check the reviewer read.
- Escalation after repeated reopens.
- Checks after the 14-day monitoring window.
- Recurrence for other incident kinds.

## 6. Stale decisions

The save names the check the reviewer read and that check's evidence key. Under the mapping lock,
`recordDriftReview` refuses with 409 `StaleEvidenceError` when the newest check carries a fact
that the reviewed check does not. In that case it writes no review, no event and no status. A
newer check with the same facts does not block the save.

The page keeps the draft (component state, plus `sessionStorage` for a reload in the same tab). It
moves focus to the alert and reloads the case with `?since=<check>`, so the new lead is marked
"New" and a callout names it. The race between a save and a check is tested both ways: whichever
commits first, a closed case never has facts its review did not see.

## 7. Permission and scope

| Viewer | Reads | Decides |
|---|---|---|
| Marketing analyst, integration engineer | everything | yes |
| Revenue ops approver, guest | everything | no (403 on the API, read-only reason on the page) |
| Brand lead (B40–B44) | the case. B39's lead is counted, never named: no id, no versions, no record link, absent from the client props. Any review note about evidence outside the scope is withheld whole | no (403) |
| A decider whose scope misses part of the evidence | as above | no (403: a reviewer closes only evidence they can read in full) |
| B20 partner | nothing: the page reads as missing. Next's not-found streams inside a 200, as on every incident page; no case data is in the HTML | no |

The case history and the exception row are branch-free. Transition reasons give counts and check
ids, never branches; the rationale and the facts live on the review, which is read through scope.

## 8. Business invariants

Reviews and recurrence wrote only `case_reviews`, `cases`, `case_events`, `audit_log` and the
exception's status and resolution. The integration test hashes, before and after:
`campaign_branch_map`, `campaign_mapping_versions`, `ad_spend_daily`, `raw_events`, `leads`,
`overrides`, `v_acquisitions`, `crm_payments`, and the change's status, release verification,
`verified_at` and `last_verified_at`. Every earlier check row stays byte-identical.

**Incident counts, reported apart from money (HO-45 / R-50):** on every branch's scorecard, a
review moves only B44's open-incident count (−1 when it closes the case, +1 when a reopen opens
it). Spend, customers, CAC, collected and revenue at risk do not move. The frozen held-out
baseline was not edited (results in §10).

## 9. Live walkthrough and critique

**How it was walked.** The steps were done by hand in the desktop app's built-in browser, on the
production build and the isolated database. The pane was hidden, so its screenshots timed out and
React's streamed reveals stalled after some client navigations. The walk therefore used DOM reads
and clicks: open from Incidents, read the brief, open and Esc the drawer, save, reload, replay the
same evidence, a second lead to B41, "needs investigation" with and without an owner, a stale save,
and direct API calls as guest, brand and partner. Claude in Chrome reached the server, but its
screenshots timed out too. The images were taken by the Playwright spec (headless Chromium), and I
inspected them. **This is not a usability study.**

**Found by walking it, and fixed:**
1. After "Needs investigation" on a reopened case, the page still said "Reopened" and hid the
   decision (the state order in `briefState`).
2. A lead's "revised at" moved to a later note edit; it is now "moved at the source", the first
   version at its current branch.
3. On a reopened case, the "new since the check you were reading" callout was hidden behind the
   review callout.
4. After a save, a `?since=` link could still show that callout; it now shows only on open cases.
5. `role="dialog"` on `<aside>` (axe `aria-allowed-role`).
6. The live-mapping sentence was said twice; it now appears once.
7. "1 audit rows".
8. The demo's earlier spec rewinds the business clock, so a review was dated before the drift it
   reviewed. The spec now moves the clock past the evidence first and asserts time order. The
   product does not invent times.

**Independent review.** A separate read-only agent read the diff and the screenshots. It confirmed
8 problems: 4 blockers and 4 minor. All were checked in the code, fixed, and given a test that fails
without the fix:

| # | Finding | Fix | Test (mutation turned it red) |
|---|---|---|---|
| 1 | **Blocker:** the review's audit row carried the free-text note. The AI tools' `getAuditHistory` returns a case's audit rows to anyone who can read the case, so it leaked to the brand lead | The audit row and case events carry ids, disposition and owner only. The note is read from `case_reviews`, through scope | the case's audit rows contain no note and no B39 |
| 2 | **Blocker:** the verdict was compared by exact value, so an improvement reopened the case. With a worse verdict, a re-delivered or edited pre-release lead at an *approved* branch became a new fact | Leads are facts only at branches the approval never saw. The verdict counts only when worse than any verdict reviewed | split-release world: a duplicate and a note-only edit at B43 do not reopen; a worse verdict does |
| 3 | **Blocker:** the version at release (its branch and payload) was not redacted. In a split release, a scoped viewer saw the other branch | The version at release is withheld when its branch is outside the viewer's scope. A note is withheld if the reviewed check names any branch the viewer cannot see. The same rule now gates who may decide | a viewer scoped to B41/B44 never sees B43 |
| 4 | **Blocker:** after a compensating release, the page said "No ChangeGuard release made this move" | It names the change that replaced the mapping. The decision form says this review changes nothing further | unit test |
| 5 | "New" meant two things | "New since the last review" and "New since check #N" are separate badges | integration + browser |
| 6 | "No source revisions do not show…"; arrivals called revisions | Separate wordings; a share sentence when no lead is outside the approved branches | unit test |
| 7 | The evidence key reached read-only viewers and the exception row | Only a viewer who can decide receives it; it is removed from the exception | — |
| 8 | ChangeGuard's note still said "acknowledge the incident" | Its note names the incident and the two decisions | — |

**Before → after**, from Incidents to the explanation and both versions:

| | Baseline | Now |
|---|---|---|
| Pages | 4 + drawer | 1 + drawer |
| Clicks until both versions are seen | 7 (one version at a time) | 3 (type, case, compare: both side by side) |
| B39 named, mapping B44 stated, 10/10 vs 9/10 | from the 2nd page on | on the case's first screen at 1440 × 900, no click |
| Record a decision | not possible | one primary action |

These counts are observed steps against the stated baseline. No time saving is claimed.

## 10. Verification

**Targeted, as built:**
- `tests/unit/drift-facts.test.ts`: 16 tests.
- `tests/integration/drift-review.test.ts`: 16 tests on the real paths. ChangeGuard releases the
  mapping, the polling ingestion delivers records, the worker's own loop runs checks, and the
  business clock moves.
- Nine mutations each turned the suite red, and the restored code passed:
  - the reopen;
  - the stale check;
  - facts keyed by raw event;
  - the reviewer scope check;
  - the note scope;
  - approved-branch leads as facts;
  - the exact verdict compare;
  - the at-release withholding;
  - the note in the audit row.

**Browser** (`next start`, isolated database):
- `zzz-changeguard`, `zzzzz-post-release-monitoring` and `zzzzzz-drift-review`: 9 passed.
- The run was repeated after each fix.

**One incident in the process.** The first full regression was stopped through the task tool, but
its script kept running and overlapped the second. Both were killed: the scripts, the browser
runner, the vitest workers and the server on port 3000. The targeted suites were then rerun on a
quiet machine (40 files, 472 tests passed), and one clean full regression followed.

**Full production regression** (`C:/Temp/final-regression-drift.sh`, main checkout, against the
R-30 baseline outputs in `C:/Temp/*-r30-final.json`):

| Check | Before | Now |
|---|---|---|
| Disk preflight, typecheck, lint | pass | pass |
| Vitest | 828 passed + 2 expected fails, 69 files | **860 passed + 2 expected fails, 71 files** (+16 unit, +16 integration) |
| AI evaluation | 15/15 | 15/15 |
| Investigator held-out | 61 of 62 (IV-16 by design) | identical, case by case |
| ChangeGuard held-out | 30 pass; HO-45's FI-4 finding (R-50) | identical, scenario by scenario: findings, final mappings and statuses |
| VP acceptance | 509 checks, 16 failed, 11 critical | identical findings |
| Shadow acceptance | 320/320 | 320/320, identical |
| Build | pass | pass |
| Browser suite (`next start`) | 114 passed, 1 skipped | **119 passed, 1 skipped, 0 failed** (24.6 min) |

R-39 and R-46 are untouched. No held-out baseline was edited.

## 11. Screenshots (`screens/`, JPEG, labelled state_viewport_role_build)

Baseline (`_d5242c2`): `baseline_case-open`, `baseline_check-evidence`, `baseline_change-summary`,
`baseline_lead-drawer-current`, `baseline_lead-drawer-previous`, each at `desktop-1440` and
`phone-390`, marketing.

Previews: `prototype-A-decision-brief_*`, `prototype-B-evidence-workbench_*` (desktop and phone).

Final (`_on-d5242c2`: the uncommitted build on top of `d5242c2`, the build this commit contains):
`final_case-open` (desktop, phone), `final_evidence-versions` (desktop, phone),
`final_case-reviewed` (desktop and phone as marketing; desktop as guest and as the brand lead),
`final_case-reopened` (desktop, phone-390, phone-320), `final_case-investigating_phone-390`,
`final_stale-conflict_desktop-1440`. They are written by `DRIFT_SCREENS=<dir>
tests/e2e/zzzzzz-drift-review.spec.ts`. Traces are not committed.

## 12. Limitations

- One campaign, one kind of contradiction, synthetic data, no real reviewer.
- A free-text note that touches out-of-scope evidence is withheld whole. Notes are not sanitised.
- Overdue checks still notify no one (notifications ruled out, R-30).
- The fact rule treats any new lead outside the approved branches as material. Natural spillover
  would reopen cases (R-50).
- R-39 (shared-phone credit) and R-46 (campaign ids without a platform) stay open. This work
  neither reads nor changes them.
