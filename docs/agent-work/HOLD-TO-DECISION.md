# From a budget hold to the same decision after correction (2026-11-16)

One workflow, finished: a marketing lead goes from the Overview to a budget hold, opens the exact
records behind it, and comes back to the same decision after the source corrects itself. An
engineer verifies the numbers and the source delivery from the same journey.

Started from the accepted local synthetic demo checkpoint `d431e9b` (recorded by `91f253b`).
Synthetic data only. Nothing pushed or deployed.

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
