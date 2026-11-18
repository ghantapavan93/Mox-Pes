# From a budget hold to the same decision after correction (2026-11-16)

One workflow, finished: a marketing lead goes from the Overview to a budget hold, opens the exact
records behind it, and comes back to the same decision after the source corrects itself. An
engineer verifies the numbers and the source delivery from the same journey.

Started from the accepted local synthetic demo checkpoint `d431e9b` (recorded by `91f253b`).
Synthetic data only. Nothing pushed or deployed.

**Status: candidate, not promoted.**
- **Code:** `718e4aa`, build `ks0842o0526Xv-eQimWYE`.
- **Passed:** the B09 acceptance runner, 177 of 177, from a fresh worktree; full vitest; the
  affected browser specs; typecheck; lint.
- **Not run:** the full release regression (the five frozen eval packs and the whole browser
  suite in one run), so `d431e9b` stays the accepted checkpoint (`RELEASE-CANDIDATE.md` §9).
- **Redrawn since (§9):** the B09 decision view, `6ed9066` (build `ekfY8a8woILuSdmtlccf8`). Same
  logic, new first screen; also not promoted.
- **Hardened since (§10, 2026-11-18):** six defects found by a fresh-eyes review of this record.
  Each was reproduced by a test that failed on `c445311`, then fixed in the working tree. Not
  committed and not promoted: B09 stays unpromoted until the final candidate passes the full
  release regression.

## 1. Expected outcomes, written before any code changed

This section was written and committed before any product code was changed. Later sections
report what happened against it; this one is not edited afterwards.

### 1.1 Four facts kept apart

| Fact | Question it answers | Where it lives |
|---|---|---|
| Accepted ledger value | What amount does the ledger count for this campaign-day? | `ad_spend_daily`, the newest accepted version |
| Evidence completeness | Is the source's newest statement about each campaign-day the one the ledger counts? | the source records (`raw_events`) and their versions |
| Decision readiness | May a person review a budget move on this evidence? | the budget gate and Decision Lab |
| Measured effectiveness | Did the spend cause customers? | a randomized experiment only |

A clearance of one is never shown as another. "Coverage hold cleared" is not "ready", "ready for
review" is not "approved", and nothing in this workflow approves a budget change.

### 1.2 The invariant

A branch's budget decision for a period may read as not held by incomplete evidence only when, for
every campaign-day the decision reads (a campaign mapped to that branch, a date in that period),
the newest revision the source sent, by the source's own revision clock, is the revision the ledger
counts. When a newer revision was refused at intake, the ledger keeps the last accepted amount, the
decision is held for that branch and period, and the hold says which revision was refused and which
amount stands. It lifts only when a newer revision is accepted, or the refused revision itself is
accepted, and then it names the delivery that resolved it.

Identity comes from the record's own identifiers (platform, campaign id, date), its revision order
from the source clock (the parsed fetch time), and its branch from the campaign's mapping. Never
from a campaign's display name, an ad account shared with other campaigns, or the order of arrival.

### 1.3 The failure class

| Member | Case | Must |
|---|---|---|
| Original | R-54 case 2 (`BIVE-ACCEPTANCE.md` §5): a newer revision refused for fractional conversions | hold |
| Variant | the same with another refusal code (another currency, a schema failure) | hold |
| Boundary | a refused revision on the first or last date of the period; at the same instant as the accepted one; older than it | hold; no hold (not newer); no hold (older) |
| Boundary | an accepted revision that arrives between the accepted one and the refused one | changes the accepted amount, keeps the hold |
| Control | a refused revision of another branch's campaign in a shared ad account | no hold here |
| Control | a refused revision dated outside the period | no hold for this period |
| Control | an exact duplicate of the refused revision; an older accepted revision; a re-send of the accepted one | no change, no second blocker, no clearance |
| Adversarial | a refused record whose campaign name says "B09" but whose id is another branch's campaign | no hold at B09 |
| Ambiguous | a refused record that names no campaign the ledger maps to a branch, or cannot be identified | no branch guessed; say what cannot be checked |

### 1.4 Scenarios on the isolated B09 fixture

The fixture is the acceptance world (`tests/acceptance/b09/`): the demo seed, then the source's own
corrections through the ads feed's polling path. "Verified" is the world after `partial` and `rest`
(B09's coverage gap verified). The deliveries below are new steps of the same fixture.

| # | Scenario | Delivery | Required behaviour |
|---|---|---|---|
| 1 | A relevant newer campaign-day revision is refused | pmax-lsa-B09, Oct 20, fetched after the accepted revision, fractional conversions and a different amount | The ledger keeps the last accepted amount for Oct 20, still filed as Google Local Services. B09's October decision is held by an incident at B09 that names the refused revision and the amount that stands. Overview, daily evidence, incident and Decision Lab all say the decision is held, and none says the refused amount was counted or that Oct 20 is $0. |
| 2a | A different branch shares the ad account | a refused newer revision of B10's Search campaign (the shared GA-SOUTHWEST account) | B10's October decision is held. B09's verdicts are identical to before, word for word. |
| 2b | The record is outside the decision window | a refused newer revision of a B09 campaign-day in September | B09's September decision is held; its October decision is unchanged. |
| 3 | An exact duplicate or older delivery arrives while the issue is open | the refused revision again; an older accepted-format revision of Oct 20; the accepted revision again | No change to accepted spend. The same incident, with the same records, no second blocker. The hold stays. |
| 4 | An authoritative correction arrives | a newer accepted revision of Oct 20; a second refused revision on another date stays uncorrected | The Oct 20 blocker clears and names the correcting delivery run. The other blocker stays visible and still holds the decision. |
| 5 | Scope is genuinely ambiguous | a refused record of a campaign the ledger maps to no branch (one whose name says B09), and one with no campaign id | No branch's decision changes. The company-level incident says which branch they affect cannot be verified. A branch-scoped viewer sees neither the incident nor its records. Whether such records should hold a decision is stated as undecided, not invented. |
| 6 | An accepted correction changes the amount, not just its classification | the correction in 4 ($120.91 becomes a different amount) | The incident and Decision Lab show before and after. "Reclassified, not added" is never shown unless every corrected day keeps its amount. |
| 7 | A previously verified date becomes unsupported | a newer accepted revision that files Oct 20 as Google Search again | The same coverage-gap incident reopens (existing policy, inside 60 days). It shows the current hold and keeps the earlier verification as history. Where the policy does not reopen (outside 60 days), the historical verification is never shown as a current clearance. |

### 1.5 B09's three states, as a reader must see them

Every value comes from server evidence. No component carries B09's dates or amounts.

| State | Headline | The reason, in plain words | The one next action |
|---|---|---|---|
| Missing | Hold the budget decision | A required Google Local Services spend record is missing at B09: none of the 18 dates in the decision window (Oct 13–Oct 30) has one | Open the records for the first missing dates |
| Partial | Still on hold · 5 of 18 days verified | Oct 26–Oct 30 are covered, but the decision window (Oct 13–Oct 30) is not: Oct 13–Oct 25 still have no record | Open the records for the remaining dates |
| Verified | Coverage hold cleared · 18 of 18 days verified | $2,123.52 moved from Google Search to Google Local Services, and B09's total October spend stayed $16,649.23 | Open decision readiness, with every check still open. No budget change was approved |

Per surface:
- **Overview** answers what to look at first: the decision and its reason, one link to the right
  scope.
- **Daily evidence** answers which dates have no record, which recorded $0.00 and which are covered,
  with the selected week and the full decision window told apart.
- **Incident** answers what changed, what stayed the same and what still needs review. The outcome
  comes before workflow history, raw payloads and AI. Source records and the correcting delivery
  are one click away where the viewer may open them.
- **Decision Lab** answers what can be reviewed now and what still prevents a decision. Full reasons
  are readable without hovering. Evidence clearance, budget approval and effectiveness never share
  one green label.

Also required:
- branch, channel, period and selected week survive deep links and Back;
- pending, empty, stale and unavailable evidence are said as such;
- a loading state never shows "ready" or missing money as $0.00;
- a viewer who may not open a record gets no dead primary action and no detail of it;
- focus is visible and returns to where it was when evidence closes;
- the changed path holds at 200% zoom and at 320 px.

### 1.6 N1, checked separately

N1 (book, chapter 16 §10): "held spend never blocks a budget decision". A held day has no accepted
version at all: the ledger counts nothing for it. A refused newer revision leaves an older accepted
amount in place. They are different paths. Each readiness check (budget gate, Decision Lab
readiness, verified readiness, the scorecard, the metric trace) is checked against a held day on
its own. What each does is reported, not assumed.

### 1.7 What fails this workflow

- a refused amount shown as counted, or a refused or held day shown as $0.00;
- a hold on another branch, or another period, than the record's own;
- a hold cleared by a duplicate, an older revision or a re-send;
- "Reclassified, not added" beside a changed amount;
- "Coverage hold cleared" read as ready, or "ready for review" read as approved;
- two surfaces implying different decisions for the same scope and evidence.

## 2. The refused-revision case, reproduced before any fix

**World:** the B09 acceptance fixture on its own database (`revenue_signal_acceptance_r54`):
- seeded, then `partial` and `rest`, so B09 is verified;
- then `refused`: pmax-lsa-B09's Oct 20, fetched 1:20 PM, 2.5 conversions and $400.00, sent through
  the ads feed's polling path (`tests/acceptance/b09/advance.ts`).

**Build:** the accepted checkpoint's own, `d431e9b` (`cVimzqQcl7kG4UNywLQfF`), from
`C:/Temp/rso-rc`. Captures are in `hold-to-decision/before/`.

| What | Value |
|---|---|
| Accepted amount, Oct 20 | 12,091¢ ($120.91), Google Local Services; raw event #200027, fetched 1:10 PM, run #677 |
| Refused revision | raw event #200033, run #678, `FRACTIONAL_CONVERSIONS`, fetched 1:20 PM, $400.00, never counted |
| Its incident | #5540, quarantined source records, **no branch**, "1 records from ads quarantined (FRACTIONAL_CONVERSIONS)" |

What each surface said (`before/refused-marketing-1440.json`, `before/probe-refused.json`):

| Surface | Verdict | Reason shown |
|---|---|---|
| Budget gate (`budgetSignal`) | trustworthy, no blockers | none |
| Overview | B09 not in the holds list (only B44 #970 and B20 #1063) | "Coverage hold cleared … Reclassified, not added …" |
| Daily evidence, Oct 19–25 | "All 7 days have a spend record: $803.38 in all." | Oct 20 shows $120.91; nothing about the refused revision |
| Incident #5540 | "Budget decisions: **On hold while open**" | its "why" speaks of customers' lead records; **false**: with no branch it held no decision |
| Incident #2455 | "Coverage hold cleared …" | "Next: See in Decision Lab whether the budget decision can go to a person for review." |
| Decision Lab | **Ready for review** | "no open incident holds the decision"; verified readiness: needs review only for #970 and door-to-door conflicts |

So the source's newest word on Oct 20 had been refused, and every view told a reader the decision
was free. One view, the incident, also claimed a hold that did not exist.

### N1, checked on its own path

> **Out of date since `350fb45` (2026-11-17).** A held day now holds its channel's decision through
> eligibility (`product-audit/BUSINESS-FIT.md` §10). The table below is the measurement at
> `718e4aa`, kept as history; §10.2 tests the hand-off from a refused revision to held spend on the
> current tree.

**World:** a second copy of the verified world (`revenue_signal_acceptance_r54_n1`), with one held
day. `heldDay` sends lsa-B09's Oct 20, a day that campaign never spent, billed in CAD. Intake
refuses it, and the ledger counts no revision of that campaign-day.

| Check | Sees the held day? | What it says |
|---|---|---|
| Budget gate | No | trustworthy, no blockers |
| Decision Lab readiness | No | every channel "ready" (by its own rules) |
| Verified readiness, `complete` rule | **Yes**, every channel | "18 paid customer(s) are counted while some of their campaign's spend is held at intake, so the CAC is understated." It forces READY_WITH_LIMITATIONS; for Local Services and Search, NEEDS_REVIEW from #970 is stronger |
| Scorecard | **Yes** | `partlyHeldAcquired: 18` |
| Metric trace | **Yes** | lists the held record against B09 through its campaign's mapping |
| Its incident | No branch | company level, like the refused revision before the fix |

N1 is partly true, and it is not the R-54 path:
- A **held day** has no accepted amount. Two readiness checks see it and call it a limitation, by a
  rule chosen earlier (definition v3).
- A **refused newer revision** leaves an older amount counted. Before this change no check saw it,
  because the day is not held.

The two are kept apart below. Whether a held day should hold the decision, rather than limit it, is
a policy decision for Moxie, not a defect to patch (§7).

## 3. The fix: one shared rule, read by every view

**BUG:** a newer spend revision that intake refuses leaves the older amount counted. Its incident
had no branch, so no decision was held: Decision Lab read "Ready for review" on an amount the source
had since revised.

**ROOT INVARIANT:** a branch's budget decision for a period may read as free of incomplete evidence
only when the newest revision of every campaign-day it reads is the counted one. Identity is the
platform, the campaign id and the date. Order is the source's clock.

**FAILURE CLASS:** every refusal code (fractional conversions, another currency, ambiguous typing);
the period's first and last dates; same-instant and older refusals; an accepted revision between
the counted one and the refused one; a shared ad account; a campaign name that names another
branch; an unmapped or unidentifiable campaign; duplicates, older revisions and re-sends while
held. All of these are in `tests/integration/refused-revision.test.ts`.

*Narrowed on 2026-11-18 (§10):* the tests cover three refusal codes, and their "unmapped" case is
a campaign id the ledger has never counted. A campaign the ledger counts but maps to no branch is
untested. Separate fetches of one campaign-day, a branch key in the payload and lifts that are not
corrections were outside this class; §10 adds them.

**GENERAL FIX:** migration 0034 adds two views.
- `v_refused_spend_revisions` sets each refused ad spend record against the revision counted for
  the same campaign-day. Each is newer, superseded or at the same instant.
- `v_quarantine_holds` lists the quarantined records that still hold something, each with its
  branch: the branch its payload names, or, for a newer refused revision, its campaign's mapped
  branch. Since migration 0036 (§10), ad spend takes its campaign's branch only, whatever branch
  key its payload carries.

Readers of the shared rule:
- Reconciliation's rule 1 groups those records into the branch's existing quarantine incident. No
  new incident kind. The incident's evidence lists each held campaign-day, its dates and channels,
  and the refused revision beside the counted one.
- Rule 1a records how each held campaign-day was lifted, and by which delivery. When none is left,
  that becomes the resolution. Since §10 it compares campaign-days, not refused records, and only an
  accepted revision is called a correction.
- The budget gate holds a period only if a held date falls inside it. Its blocker carries those
  revisions, and Decision Lab, the Overview and the incident read them from it.

**SHARED PRIMITIVE:**
- the two views, one SQL definition, read by rule 1, `quarantineGroupIds` (the incident's records
  and the replay plan) and the AI investigator's tool;
- `lib/reconcile/refused-revisions.ts`, the one place their evidence is parsed and phrased.

**SPECIAL CASES REMOVED:**
- the group rule had three copies: rule 1, `quarantineGroupIds` and the investigator's tool. All
  now read the view.
- Decision Lab linked a spend refusal from its *lead-records* line. That line is now lead sources
  only.

**RULE TESTS** (hand-written examples, not generated inputs): `refused-revision.test.ts`, 11 tests
at the time, 22 since §10:
- every refusal code holds B09's October decision, with the counted amount unchanged;
- a September date holds September only, and B09's October verdicts are identical, word for word;
- another branch in the shared ad account, or a name that says B09, holds that branch only;
- a duplicate, an older revision or a re-send moves nothing and clears nothing;
- a correction lifts only its own campaign-day and names the run;
- no campaign, or an unmapped one, holds no branch;
- older and same-instant refusals hold nothing.

**CONTROL TEST:** the neighbouring suites, unchanged:
- decision lab, B09 recovery, currency rules, replay, run effect, verified readiness, metric trace,
  invariants and the AI investigator: 117 tests passing after the rule change;
- the demo world has no ads quarantine, so its holds and verdicts cannot move.

**COMPLEXITY:**
- one indexed lookup per quarantined ads record: `raw_events_entity_idx` (source, entity, entity_id),
  plus `ad_campaigns` (platform, id) and the spend day's primary key;
- the gate's period filter reads the incident's own evidence;
- rule 1a reads only open incidents that hold revisions.

**FILES:**
- `database/migrations/0034_refused_spend_revisions.sql`
- `lib/reconcile/reconcile.ts`
- `lib/reconcile/refused-revisions.ts`
- `lib/metrics/decision.ts`
- `lib/decision/verdicts.ts`
- `lib/ingest/replay.ts`
- `lib/ai/tools.ts`

**Not changed, on purpose:**
- a held day (N1) kept its rule, a limitation, not a hold (since `350fb45` it holds its channel);
- a currency-unstated newer revision still removes the older row ("the newest observation decides",
  `currency-rules.test.ts`). That is an existing, tested policy. The day then has no counted record, never $0, and the metric
  trace lists the held record.

### Scenario 6: "reclassified, not added" needs every day's amount

Before, the claim rested on two facts: the window carried exactly the original finding's total, and
nothing was misfiled. Two days restated in opposite directions passed that test.

Now `gapCoverage` also reads, for each covered date, the amount of the revision the counted one
replaced. That is the newest earlier accepted revision, unless the record was re-mapped in place,
which cannot change an amount. If any covered date changed amount, the incident shows before and
after, day by day, and never "reclassified, not added".

When a correction restates money after verification (Oct 20, $120.91 to $400.00), the coverage hold
stays cleared, and the incident says "Amounts changed: Oct 20: $120.91 became $400.00."

**Known conservative edge:** a date restated to $0 and then back, before verification, is reported
as changed.

## 4. The surfaces: one meaning, a different question each

Every view quotes the same facts, and none computes the verdict itself:
- the incident's own status (`gapStatus`);
- the gate's blockers (`budgetSignal`, with each refused revision dated in the period);
- the ledger (`ad_spend_daily`).

| View | The question it answers | What changed |
|---|---|---|
| **Overview** | What should I look at first? | At one branch the status line leads with the decision: "Hold the budget decision. Incident #N holds it: …", in the holding incident's own words, then any coverage hold that cleared. The holds list names a refused revision ("Spend revision refused") and links to its decision panel. Holds are read for the selected period |
| **Daily evidence** | Which dates have no record, which recorded $0.00, which are covered? | A day whose newer revision was refused shows the counted amount, marked "counted · newer revision refused". The refused revision appears as "Refused, not counted", with its fetch time, the amount it said, why it was refused and its raw event. One primary action: the hold. The trace's held-records card now says it filters by each record's own time |
| **Incident** | What changed, what stayed the same, what still needs review? | Right after the title: the decision headline, why, and one next action. On a phone that is the first thing in reading and focus order. What was detected, the kind's explanation and the secondary actions (AI, branch, readiness) follow. Revision details open one click away: each refused revision beside the counted one, the runs that delivered them (linked for company-wide roles), and the correcting delivery once lifted. A company-level group of refused spend records says what cannot be verified and that no rule decides it |
| **Decision Lab** | What can I review now, and what still prevents a decision? | A refused revision's blocker gives the whole reason in the period. The channel it touches fails integrity ("not confirmed", not "known to be wrong"); other channels' integrity is untouched. "Other checks need review" gives each channel's whole reason (R-56: it was cut at 140 characters) |

B09's three states, as rendered on build `nQcxhPYqwZXfT91nSHH7Y` (`captures/`):

| State | Incident headline | Above the fold at 1440 × 900 | First on a 390 px phone |
|---|---|---|---|
| Missing | **Hold the budget decision**. "A required Google Local Services spend record is missing at B09: none of the 18 dates in the decision window (Oct 13–Oct 30) has one." | Headline at 168 px; **Open the records for Oct 12–Oct 18** ends at 400 px | Headline at 377 px; the action at 731 px, before the impact tiles (1,300 px) |
| Partial | **Still on hold · 5 of 18 days verified**. "Oct 26–Oct 30 are covered, but the decision window (Oct 13–Oct 30) is not: Oct 13–Oct 25 still have no Google Local Services record." | Same; the action opens Oct 12–Oct 18, the first remaining dates | Headline 377 px; action 755 px |
| Verified | **Coverage hold cleared · 18 of 18 days verified**. "$2,123.52 moved from Google Search to Google Local Services, and no amount changed: reclassified, not added. B09's paid media spend in Oct 1–30, 2026 (UTC) stayed $16,649.23." Next: decision readiness; "No budget change was approved." | Headline 168 px; **Open decision readiness** ends at 404 px | Headline 377 px; action 723 px |
| Refused (R-54) | **Hold the budget decision**. "A newer revision of Oct 20's Google Local Services spend (pmax-lsa-B09) was refused: it reports 2.5 conversions and the ledger stores whole numbers only. The ledger still counts the earlier $120.91, so Oct 20 is not confirmed. B09's October budget decision is held until a newer revision is accepted." | Headline 168 px; **Open the records for Oct 19–Oct 25** ends at 364 px | Headline 377 px; action 719 px |

In all four states:
- **Keyboard:** Tab reaches the primary action with a visible focus outline. The details open and
  close with Enter, and focus stays on their summary.
- **Overflow:** no page-level sideways scroll at 1440, 390, 320 or 200% zoom, on the Overview, the
  daily evidence, the incident or Decision Lab (`captures/<state>-checks.json`). Wide tables scroll
  inside their own regions.

**What a reviewer sees first, and clicks next:**
- **Missing and partial:** the headline and the dates still open, then **Open the records for
  Oct 12–Oct 18**.
- **Verified:** "Coverage hold cleared", the moved amount and the unchanged total, then **Open
  decision readiness**.
- **Refused:** "Hold the budget decision" and the Oct 20 sentence, then **Open the records for
  Oct 19–Oct 25**, where Oct 20 is marked.

## 5. Verification

| Check | Result | Where |
|---|---|---|
| Typecheck, lint | Clean | `npm run typecheck`, `npm run lint` |
| Rule tests | 11 of 11 | `tests/integration/refused-revision.test.ts` |
| Full vitest | **951 passed, 1 expected failure** (940 + 1 at `d431e9b`) | `hold-to-decision/acceptance/vitest.log` |
| B09 acceptance runner, from a fresh worktree at `718e4aa` (no tracked changes) | **177 of 177 checks**, 0 console or page errors (`hold-to-decision/acceptance/results-718e4aa.json`). The first green run, on the working tree before the commits, was also 177 of 177 (`results-candidate.json`). Missing, partial and verified on all four views; replays; the independent ledger; scope (61 routes, 31 proving, 62 paired denials, 0 leaks); and the new steps: refused, while held, a second refusal, corrected (with a page refreshed across the delivery), Back, ambiguous records, paired scope (15 checks) | `hold-to-decision/acceptance/` |
| States at four widths | All pass (above) | `hold-to-decision/captures/` |
| Focused browser specs (golden path, layout and visual, trace, accessibility, evidence journey, Overview movement, B09 four-minute path), on `revenue_signal_rc` | 34 passed; 2 pixel baselines failed as intended (the incident page, 3% and 7% of pixels), were updated on purpose, then passed 2 of 2 | `9b052dc` |

## 6. N1, in short

*Out of date since `350fb45`: a held day now holds its channel's decision (§2, §10).*

N1 ("held spend never blocks a budget decision") is partly true, and it is not R-54's path.
- A held day has no accepted amount. Verified readiness's `complete` rule and the scorecard see it,
  and call it a limitation.
- The budget gate and Decision Lab readiness do not see it.
- R-54's refused newer revision kept an older amount counted, and no check saw it at all. It now
  holds the decision.

Whether a held day should hold the decision too is a policy question (§7). Measurements are in §2.

## 7. Open edges, stated

- **F2 (R-54, case 1), tested on 2026-11-18 (§10.4).** A successor that started before the stop
  leaves its overlap days misfiled outside the window; the verification proves the window only.
  Not fixed.
- **F8 (R-54, case 3).** A re-send of the same instant written another way (`.000Z`) is stored as a
  new version. A refused record at the same instant as the counted revision holds nothing (neither
  is newer). It stays visible at company level.
- **Held days (N1)** hold their channel's decision since `350fb45`. A newer revision with no stated
  currency still removes the older row; the refused-revision hold then hands off to held spend
  (§10), never $0.
- **Unattributable refused records** (an unmapped campaign, no campaign id) hold no branch. Their
  incident says so, and says no rule decides it. A company-wide viewer sees it; a scoped viewer does
  not.
- **The incident page lists at most 50 held campaign-days.** Since §10 the incident stores every
  one (one entry per campaign-day, every refused delivery kept), rule 1a and the gate read them
  all, and the page says how many more it holds.
- **"Reclassified, not added" is conservative.** A date restated to $0 and back before verification
  reads as changed.
- **The trace's held-records card** filters by each record's own time (for spend, the fetch time).
  It is labelled so, and was not changed: the AI evaluation packs read it.
- **No person has tried the reviewer task.** `REVIEWER-TASK.md` and its separate answer key are
  ready. A scripted check is not that evidence.

## 8. Run it, show it

- Local guide, simulated deliveries only: `hold-to-decision/GUIDE.md`.
- 90-second walkthrough: `hold-to-decision/WALKTHROUGH.md`. The B20 opening line is optional; B09 at
  5 of 18 is the first thing clicked. The Google wording is checked against Google Ads Help 17213585
  and 18550592.
- Reviewer task: `hold-to-decision/REVIEWER-TASK.md`. Answer key, kept apart:
  `hold-to-decision/REVIEWER-ANSWER-KEY.md`.
- **Three state captures, first screen, desktop and phone:**
  - `captures/state-1-hold-{1440,390}.jpg`;
  - `captures/state-2-still-on-hold-{1440,390}.jpg`;
  - `captures/state-3-cleared-{1440,390}.jpg`.
- **Also captured:**
  - the refused state on the Overview, the daily evidence and Decision Lab
    (`refused-*-1440.jpg`);
  - one open evidence state per state (`*-incident-390-evidence-open.jpg`);
  - the 320 px and 200% zoom checks.
- **Full-page captures** of every view are kept locally (`C:/Temp/hold-captures-full`), not in
  git.

## 9. The decision view, redrawn (2026-11-16)

The same workflow, redrawn so the B09 incident's first screen reads as one verdict over its
evidence, not as an incident form. **No decision logic changed.** Every sentence is the one §4
lists, from the same functions; the new strip only selects among facts the server computed.

**The brief:**
- a quiet scope line, one strong verdict, a continuous 18-day evidence strip, one primary action;
- at 5 of 18, "Selected week covered" and "Decision window incomplete" close enough to compare
  without narration;
- a missing date opens through the existing evidence view;
- at 18 of 18, the same composition, with the emphasis on the reclassification and the unchanged
  total;
- "Coverage hold cleared" never looks like budget approval.

Patterns came in and dependencies did not:
- **UI/UX Pro Max:** its design-system search was run once, from a read-only clone; the plugin
  was not installed. Kept: the Swiss, minimal dashboard style, 4.5:1 text, visible focus, reduced
  motion and 150–300 ms transitions. Rejected: its Outfit and Work Sans fonts (Geist stays), its
  pink accent, and its landing-page "hero and call to action" layout.
- **The shadcn-fintech template:** a read-only clone of `abderrahimghazali/shadcn-fintech`, remote
  checked, nothing installed. Kept: its hairline card frame, its title weight and its legends that
  carry values.
- **Others:** Linear for the verdict, OpenStatus for the strip, Knock for one event, GitHub's diff
  and Midday's type for the money, and Sentry for the default selection.
- **Unchanged:** the light theme, the tokens, Geist, Lucide, and the existing evidence view.

### 9.1 What changed

| Part | Before (`718e4aa`) | After |
|---|---|---|
| Title block | "Channel coverage gap" at 22 px over a bordered panel | `PageHeader quiet`: the type and its badges become a 14 px line, then the scope line "B09 Coral · Google Local Services · decision window Oct 13–Oct 30" |
| Verdict | The panel's 18 px title, with a red or green edge | One `h2` at 26–28 px, always ink. Its reason at 15 px, then "Next:" (with "No budget change was approved." once cleared), and one primary action |
| Decision window | Dates only in sentences | `DecisionWindow`: 18 dates in one radio group. Each mark has its word, and the legend carries the counts. The picked week is underlined; "Selected week covered" sits beside "Decision window incomplete" |
| One date | None | The first unresolved date opens: what arrived, why it does not count, what clears it, and **Open the records for {week}** on the daily evidence. With none unresolved, none opens |
| What moved | One sentence | The same sentence over three tiles: − out of Google Search, + into Google Local Services, = B09's October paid media spend, "unchanged" only with the proof. Amounts are ink; only the signs are coloured |
| Every panel | `border` and `shadow-raised`, 13 px titles | `ring-1 ring-text/10`, `rounded-xl`, no shadow at rest, 15 px titles |
| A refused revision's hold | Bordered panel | The same composition: verdict, reason, one action, details one click away |

**Files:**
- new: `components/incidents/DecisionWindow.tsx` and `lib/reconcile/gap-days.ts` (pure);
- changed: `lib/reconcile/gap-coverage.ts` (`days`), `components/incidents/GapRecovery.tsx`,
  `components/incidents/RevisionHold.tsx`, `components/ui.tsx` and
  `app/exceptions/[id]/page.tsx`;
- `docs/design-system.md`: behaviour rules 9–12 and the new components.

### 9.2 Review of the rendered screens

The first after-captures were reviewed for hierarchy, contrast, keyboard focus and clipping. Five
problems were found and fixed before the final captures.

| Found | Fixed |
|---|---|
| A selected missing date drew its ring inset, in the mark's red: the selection barely showed | The marks' outlines became borders, so the ring belongs to the selection alone. Under keyboard focus the button's outline replaces the ring, so focus never shows two |
| At 18 of 18, what moved began at 818 px of a 900 px screen | No date opens when none is unresolved, and what moved became three tiles. It now ends at 876 px |
| At 320 px a date was 23 px wide (WCAG 2.2 AA asks 24) | 4 px gaps below `sm`: 25 × 70 px |
| Before anything moved, a tile read "Into Google Local Services $0.00", which looks like recorded zero spend | No out-and-in pair before anything moves, only what is still filed elsewhere |
| The refused hold's action floated to the far right at 1440 px, while the gap's sat under its reason (and would have floated too on a wider screen) | Both verdict blocks stack: the action sits under its reason at every width |

Measured in the rendered pages (`hold-to-decision/polish/checks.json`, from `harness/polish.cjs`):
- **Text contrast:** 5.89:1 or more on every measured line (AA 4.5:1). The lowest is a fact's detail
  line on its red tint.
- **Marks and focus:** the cross 4.87:1 on its hatch, the check 5.37:1, the 0 5.84:1, the focus
  outline and selection ring 5.67:1 (AA 3:1). A missing date's own outline is 2.11:1: a second
  cue only, since the cross and the word carry the state.
- **Clipping:** no sideways page scroll at 1440, 390 or 320 px, or at 200% zoom.
- **Keyboard:**
  - the strip is one tab stop;
  - arrows, Home and End move the date and its evidence together;
  - Tab leaves to the date's records link, and Shift+Tab returns to the date;
  - at 18 of 18, Tab lands on Oct 13 unopened, and Space opens it.
- **Verdict colour:** ink, `rgb(18, 24, 38)`, in both states at every width.
- **First screen:**
  - at 5 of 18 the two facts sit side by side, at 527–587 px;
  - at 18 of 18, "No budget change was approved." is at 271 px and what moved ends at 876 px.
- **The existing evidence view:** Oct 20's link opens the daily evidence for Oct 19–Oct 25. All
  seven rows read "no spend record", never $0.00.

### 9.3 Evidence

All in `hold-to-decision/polish/`.
- **The same frame, before and after:**
  - 1440 × 900, the first screen, the same URL and database; only the build differs;
  - `before-5of18-1440.jpg` and `after-5of18-1440.jpg`;
  - `before-18of18-1440.jpg` and `after-18of18-1440.jpg`.
- **The phone, evidence open:**
  - `after-5of18-390-evidence.jpg` (Oct 20 tapped) and `after-5of18-390-records.jpg` (its records);
  - also the 390 and 320 px first screens, 200% zoom, `after-18of18-390-moved.jpg`, and the
    keyboard capture `after-5of18-focus-1440.jpg`.
- **The refused revision's hold** (#5540, in its own world) in the same composition:
  `after-refused-{1440,390}.jpg`.
- **The three-page PDF, `B09-decision-view.pdf`:**
  - printed by `harness/polish-pdf.cjs`, from those captures only;
  - its pages: before and after; 5 of 18 against 18 of 18; the phone beside the checks;
  - every number on page 3 is read from `checks.json`.

**To re-run:**
1. Build two state databases as `GUIDE.md` says: prepare, then `advance.ts partial`; a second one
   advanced through `rest`.
2. Serve each twice in demo mode: from a `718e4aa` worktree on ports 3999 and 4000, and from this
   build on 3996 and 3997.
3. Run `node docs/agent-work/hold-to-decision/harness/polish.cjs docs/agent-work/hold-to-decision/polish`.
4. Run `node docs/agent-work/hold-to-decision/harness/polish-pdf.cjs`.

### 9.4 Verification

Code: `6ed9066`, build `ekfY8a8woILuSdmtlccf8`.

| Check | Result |
|---|---|
| Typecheck, lint | Clean |
| Unit tests | 379 of 379 (36 files), with `gap-days.test.ts` new. One expectation changed on purpose: with no unresolved date, no date is selected by default (rule 11), where the first date used to be |
| Integration tests on the B09 path | `b09-recovery` and `refused-revision`: 27 of 27 |
| Browser specs that open incidents, on `revenue_signal_rc` (build `BlhUwlGz4Gr681fx7XKCe`) | 67 passed: the golden path, accessibility regressions, the quality gates (zero axe violations, WCAG 2.2 AA, on every page at 1440, 1280, 768 and 390 px), the B09 four-minute path, twin rollout, post-release monitoring and drift review. `zy-overview-movement` stopped in its setup: it needs B09's gap open, and this subset left out `z-onboarding`, whose reseed runs before it in the full suite. Run alone after a reseed on the final build: 6 of 6. The final build differs from `BlhUwlGz…` only in the two verdict blocks' layout and the scope line of a lifted hold |
| Pixel baselines (final build) | Re-generated on purpose, since the panel frame changed on every page and the incident's composition changed; then checked against: 8 of 8. The same spec finds no sideways scroll on any page at 1440, 1280, 768 or 390 px |
| B09 acceptance runner at `6ed9066`, from the clean worktree `C:/Temp/rso-hold` (no tracked changes; its own build `1YtM3m5k-65AfCnBQh3a_`) | **177 of 177 checks**, 0 console or page errors: every state on all four views, the replays, the ledger, scope, and the refused-revision steps through correction, read against the new layout (`hold-to-decision/acceptance/results-6ed9066.json`, `run-6ed9066.log`) |

### 9.5 Not done

- **The spec's other scenes:** the Overview's headline counter, B20's receipt, the incident queue,
  Decision Lab's factor rows and the right rail. Since done, in `PREMIUM-POLISH.md`.
- **Other raised elements:** tiles, drawers and KPI cards keep the soft shadow; only `Card` moved
  to the ring. Since then the tiles and KPI cards have moved to the ring too (`PREMIUM-POLISH.md`).
  Drawers, buttons and segmented controls keep the shadow.
- **The phone shell:** at 390 px the top bar and menu take about 445 px before the breadcrumb.
  That is the app shell, outside this slice.
- **Target size:** a date is 33 × 70 px on a phone. That passes AA's 24 px, not the 44 px
  touch-target aim.

## 10. Hardened after a fresh-eyes review (2026-11-18)

An EGM review found defects in the code this record describes. EGM is the Elephant-Goldfish Model:
reviewers read this record and the code with no conversation history. Its report is
`egm/hold-to-decision/consolidated_review_report.md`. The order of work: reproduce each defect on
the current tree with a test that fails, then fix it, then rerun.

- **Tree:** `c445311` plus this pass, uncommitted.
- **Policy unchanged:** a refused newer revision still holds its branch's decision for the period
  it falls in, and held spend still holds its channel (`350fb45`).

### 10.1 Reproduced first

Each test below failed on `c445311` before any product file changed
(`hold-to-decision/hardening/repro-before.txt`: 11 failed).

| | Defect | Test | What `c445311` did |
|---|---|---|---|
| K1 | Separate fetches of one refused campaign-day | three fetches, each refused | Stored 3 entries for 1 campaign-day, so the incident summed the counted $207.40 three times |
| K1 | A held day past the 50-row display limit | re-fetches that would push a held day past row 50 | Stored Oct 21, still refused, as "Already corrected" |
| K1 | More than 50 held campaign-days | 60 held campaign-days | Kept 50 of 60 |
| K5 | A branch key in a refused spend payload | a branch named in the payload | Held B10 and left B09 free |
| K2 | The ledger stops counting a held day | the ledger stops counting a held day | "Corrected. Oct 20: the ledger no longer counts a revision of this campaign-day." |
| K2 | The campaign is mapped to another branch | the campaign is mapped to another branch | "Corrected. Oct 20: the counted revision or the campaign's mapping changed" |
| K4 | The ingestion tool | groups the record where the incident does | Listed no B09 group |
| K4 | The investigator, without a model | names the refused revision | "Paid CAC at B09 is overstated: a customer whose only lead record is quarantined…" |
| K4 | The CAC inquiry | the earlier amount still counts | "October spend missing would lower October CAC" |
| K4 | The suggested question | does not assume the CAC is too high | "Why is B09's paid CAC so high?" |
| K6 | A replay through an older mapper | skips the check that refused a record | Accepted an ambiguous Performance Max record through ads@1.0, which files it as Google Search |

### 10.2 Fixed

- **One entry per campaign-day (K1).**
  - Rule 1 stores each held campaign-day once: its newest refused revision beside the counted
    one, and every refused delivery of that day (`refusedRawEventIds`).
  - The list is bounded by campaign-days, not by deliveries, and is not cut. Rule 1a compares
    campaign-days, not refused records.
  - The incident, its tiles and the daily evidence count the accepted amount once per day
    (`holdMoney`).
  - Every refused delivery stays in the incident's records, and each links to the hold from the
    daily evidence. The page lists the first 50 days and says how many more the incident holds.
  - Evidence stored before this change reads the same way: `revisionsOf` merges the entries of one
    day.
- **The campaign's branch, never the payload's (K5).** Migration 0036 adds `raw_event_branch`: ad
  spend belongs to the branch its campaign is mapped to, and any other record to the branch its
  payload names. `v_quarantine_holds`, the investigator's tools, the metric trace and the shadow
  snapshot all use it.
- **"Corrected" only when a revision was accepted (K2).**
  - A newer accepted revision, or the refused one itself, is a correction.
  - A day the ledger stops counting reads "the $207.40 it counted left the total; the day is held
    spend now, which Decision Lab holds on its own". Never $0.00, never "No amount changed".
  - A campaign mapped elsewhere reads "the hold moved there with it".
  - Either way the incident's headline is "No longer held by this incident".
  - The test also checks the policy: after the hand-off, Decision Lab still holds Local Services
    (`cost_held`).
- **Readers that told the lead-record story (K4).**
  - The ingestion tool groups held records as the incidents do and links the right incident.
  - The investigator quotes the refused revision and the amount that still counts, and says it
    cannot tell which way the CAC would move.
  - The CAC inquiry lists a refused revision as counterevidence: no spend is absent.
  - The suggested question becomes "What holds B09's budget decision?".
- **No unsafe replay (K6).**
  - A held record replays only through a mapper version that applies the check that refused it
    (`REFUSAL_CHECKED_FROM`). `replay()` enforces this for every caller, dry runs included.
  - For a refused spend revision no such version is newer than the deployed one, so the incident
    offers no replay. It says the source has to send a newer revision.

### 10.3 Not changed, on purpose

- **The hold policy**, as above.
- **Decimal conversions: deferred.** A fractional-conversion hold still lifts only through a newer
  accepted revision. The adapter names the fix: a numeric conversions column and a `_v2` reporting
  view.
- **K3: deferred with it.**
  - Scenario 6 still tells a re-map from a delivery by a one-second gap between receipt and
    projection. A replay that accepted a refused revision would pass as a re-map.
  - K6 closes that path today: no shipped mapper may replay these records.
  - The fix, recording the amount a projection overwrites, ships with any mapper that accepts them.
- **Not done from the review:**
  - K7: "stayed $X" is the current total, not a compared one;
  - K8: a refused amount in another currency is printed with "$";
  - K9 and K10.
- **Left alone:**
  - the B03 CAC fix (uncommitted, another session's work);
  - the verified B20 recording build in this folder's `.next`. All builds and browser runs for this
    pass used the worktree `C:/Temp/rso-k1`.

### 10.4 The earlier campaign overlap (F2)

`b09-recovery.test.ts`, "a successor that started three days before the stop", in its own world:
- pmax-lsa-B09 spends from Oct 10, three days before lsa-B09's last day (Oct 12).
- The decision window still starts at the gap, Oct 13.
- Re-sending Oct 13–30 verifies the incident: 18 of 18 days, "$3,743.19 moved from Google Search
  to Google Local Services, and no amount changed: reclassified, not added".
- Oct 10–12 of the same campaign ($612.21) stay filed as Google Search.

So a verified window proves Oct 13–30 and nothing before it. B09's own fixture has no overlap (its
successor starts on Oct 13), so §4's verified claim stands as written. With an overlap, the days
before the window would need their own check. The test passes on `c445311` too: it pins a boundary
and fixes nothing.

### 10.5 Verification

| Check | Result | Where |
|---|---|---|
| Typecheck, lint | Clean (lint on the 16 changed files) | `npm run typecheck`; `npx eslint` |
| Reproduction, before the fixes | 11 failed on `c445311` | `hardening/repro-before.txt` |
| Rule tests | 22 of 22: 11 earlier, 11 new | `tests/integration/refused-revision.test.ts` |
| Rule unit tests | 10 of 10 | `tests/unit/refused-revisions.test.ts` |
| The overlap test (F2) | Passes | `tests/integration/b09-recovery.test.ts` |
| Full vitest | 1,008 passed, 1 expected failure (1,009 tests, 87 files). Run in this folder, which also holds another session's uncommitted B03 fix | `hardening/vitest-full.txt` |
| Full browser suite on `revenue_signal_rc`, worktree build `ZwLMQtykCZaA47OuUlnWr` | 122 passed. 3 skipped by design: two pixel tests without `VISUAL=1`, and the demo video. 1 failed: Integration Studio's retry test, because its mock CRM address defaults to port 3000 and this run served 3989. With `FIELDROUTES_MOCK_BASE_URL` set to the test server: 7 of 7 | `hardening/e2e-full.txt`, `hardening/e2e-os-modules-rerun.txt` |
| Pixel baselines, `VISUAL=1` | 8 of 8 against the committed baselines; none regenerated | `hardening/e2e-z-layout-visual.txt` |
| B09 acceptance runner, worktree at `c445311` with this pass's changes (listed as tracked changes), its own build `QqL3Kc7yocI0X4uYh3RQT` | **177 of 177 checks**, 0 console or page errors | `hardening/acceptance-results.json`, `hardening/acceptance-b09.txt` |

Two defects came from this pass itself, and the checks caught both:
- The first full vitest run failed 3 Overview movement tests: an extra parenthesis in the daily
  evidence query. It is fixed, and the re-fetch test now checks the daily evidence as well.
- The first acceptance run failed 1 check: this pass had reworded the corrected hold's total
  sentence. The accepted-correction sentence is restored word for word; only the hand-off cases
  use new words. The check was not changed.

The browser suite ran on build `ZwLMQtykCZaA47OuUlnWr`, before that sentence was restored. The
acceptance runner ran on the restored code. Between the two builds only that one sentence differs.

### 10.6 Status

- **Candidate:** `c445311` plus this pass, uncommitted. Nothing committed, pushed or deployed.
- **Accepted checkpoint:** still `d431e9b`. B09 stays unpromoted until the final candidate passes
  the full release regression: the five frozen eval packs and the whole browser suite, in one run.
- **The demo database** needs `npm run db:migrate` before this code runs against it. Migration 0036
  adds one function and replaces one view, with no data change. It was not touched in this pass.
