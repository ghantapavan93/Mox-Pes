# A campaign id is matched on the platform the lead names (R-46), 2026-11-13

**The rule.** A bare campaign id does not identify an ad campaign: Google and Meta campaign ids are
unique only within their own platform. A lead's campaign is the campaign with its id **on the ad
platform the lead's own record names**, and nothing else.

- **What names a platform**, read only from the record's explicit fields, by source contract:

  | Source | Field | Names |
  |---|---|---|
  | calls | call-tracking source label | "Google Ads" → Google Ads; "Google LSA" → Google Local Services; "Facebook" → Meta; "Bing" → Microsoft Ads. "Google My Business" and "Direct" name no ad platform |
  | calls | `gclid` | Google Ads (Google's click id) |
  | web | `gclid` | Google Ads |
  | web | `utm_source` with a paid `utm_medium` (cpc, paid, ppc, paid_social) | google → Google Ads; facebook, meta, instagram → Meta; bing → Microsoft Ads |
  | door-to-door | — | none |

- **One platform named:** matched on (platform, id), the store's own unique key for a campaign, so
  the platform also fixes the ad account. Leads name no account and none is guessed.
- **None named, or two:** unresolved. Nothing is chosen between campaigns, and "the only campaign
  with this id today" is never taken as the answer.
- **When unresolved:** the lead, its customer and every amount stay as they are. The customer is
  counted as a customer whose lead carries no campaign id is: no campaign's mapping or held spend
  is applied to it. The evidence says why.
- **Where the rule lives:** migration `0029_campaign_platform_match.sql`, the functions
  `lead_campaign_platforms()` (and its parts) and the view `v_lead_campaigns` (one row per lead
  that carries an id: `platforms`, `platform`, `campaign_id`, `status`). The twin's reference
  writes the same contract out again in TypeScript (`namedPlatforms`, `lib/twin/oracle.ts`): it
  shares no code with the product.

## 1. Where the bare id was used (traced before editing)

| Use | Where | What the bare id did | Changed |
|---|---|---|---|
| Paid customers: unmapped, held, partly held | `lib/metrics/scorecard.ts` (`branchRows`) | Any campaign with the id, on any platform, could put a customer out of paid CAC | **Yes** |
| The paid-CAC trace: customer flags, held-spend evidence, unmapped campaigns with leads here | `lib/lineage/trace.ts` | Same as the scorecard; listed another platform's unmapped campaign, and its spend, under this branch's leads | **Yes**, plus a `campaign_unresolved` line |
| Decision gate: which branches an unmapped campaign's spend affects | `lib/metrics/decision.ts` | Customers of any campaign with the id | **Yes**: the exception's own campaign |
| CAC inquiry H3: this branch's campaigns' customers serviced elsewhere | `lib/inquiry/cac-change.ts` | Customers of any campaign with the id | **Yes** |
| Customer journey: the credited campaign's name | `lib/identity/journey.ts` | The lowest-numbered campaign with the id, on any platform and for any branch | **Yes**, plus why when unmatched |
| The twin's reference | `lib/twin/oracle.ts` | Unmapped and held sets keyed by id alone | **Yes**: keyed by platform and id |
| ChangeGuard: preflight lead evidence, monitor's conflicting leads, release sources | `lib/changeguard/{preflight,monitor,service}.ts` | A campaign's leads counted by id alone; the monitor refuses to certify a shared id | **Yes**, in a second change the same day (§6) |
| Spend side: ingest, held spend, AI tools, onboarding ledger, shadow snapshot, coverage gap, "What changed" | various | Already (platform, id) or by campaign id | No |
| Eval and fixture scripts | `scripts/eval-*.ts` | Pick fixture rows by id in their own worlds | No (frozen packs) |

## 2. The fixture, and what it should give (written by hand first)

`tests/integration/campaign-platform-match.test.ts`. Three ids, each used by a Google Ads campaign
and a Meta campaign in different accounts; seven October customers, $149.00 collected from each.

| Id | Google Ads campaign | Meta campaign |
|---|---|---|
| 123 | "G 123 search" (ACC-G) → B12, $100.00 | "M 123 prospecting" (ACC-M) → no branch, $30.00 |
| 456 | "G 456 search" (ACC-G2) → B13, $40.00 | "M 456 prospecting" (ACC-M) → B20, $60.00 |
| 789 | "G 789 search" (ACC-G) → B13, $25.00 | "M 789 prospecting" (ACC-M2): all spend held (CAD), $70.00 |

| Customer | Lead | Names | Expected campaign |
|---|---|---|---|
| c1, B12 | call "Google Ads", gclid, id 123 | Google Ads | G 123 search |
| c2, B12 | web form: gclid **and** utm facebook / paid_social, id 123 | Google Ads and Meta | unresolved (conflicting) |
| c3, B12 | call "Direct", id 123 | nothing | unresolved (no platform) |
| c4, B12 | call "Facebook", id 123 | Meta | M 123 prospecting |
| c5, B13 | call "Google Ads", id 456 | Google Ads | G 456 search |
| c6, B20 | call "Facebook", id 456 | Meta | M 456 prospecting |
| c7, B13 | call "Google Ads", id 789 | Google Ads | G 789 search |

| Branch | Paid spend | Acquired | Paid customers: expected | Old code (id alone) |
|---|---|---|---|---|
| B12 | $100.00 | 4 | **2** (c1; c2 unresolved, counted); c4 out (M 123 unmapped); c3 not paid | **0**: c1, c2 and c4 all fell to the unmapped M 123. Paid CAC blank |
| B13 | $65.00 | 2 | **2** (c5, c7) | **1**: c7 fell to M 789's held spend |
| B20 | $60.00 | 1 | **1** (c6) | 1 |

- **Spend:** $255.00 counted. Branch paid spend ($225.00) plus unallocated M 123 ($30.00) is
  $255.00; M 789's $70.00 is held and in no figure.
- **Cash:** $596.00, $298.00 and $149.00. Each branch's cash trace reproduces it.
- **The B12 trace:** lists c1 and c2; leaves out c4, "campaign mapped to no branch"; names M 123
  (Meta) as an unmapped campaign with one lead at B12; explains both unresolved ids.
  - The old trace said "Campaign 123 has 4 lead(s) at B12": all four leads, Google and Direct
    included.
- **Decision gate:** the unmapped M 123 holds B12's budget signal, and no other branch's.
- **Scope:** a viewer scoped to B20 sees c6 credited to "M 456 prospecting".
  - Nothing of B12, B13 or a Google account appears in B20's journey or trace.
  - B12's trace and B13's customer are refused to that viewer.
  - With the id alone, c6's journey showed **B13's "G 456 search"**, to the B20 viewer too.
- **The twin's reference:** counts B12 2, B13 2, B20 1, the same as the product.
  - With the id alone it counted 0 / 1 / 1, the same error as the product.

## 3. Results

**The fixture:** all eight checks pass. On the old code, five failed exactly where the table above
says the old code is wrong. Each figure in the "old code" column was printed from the old code on
the fixture, not inferred. The three that passed (spend and cash, the decision gate, the B20 trace
and its refusals) never depended on the id. **R-46's pinned case** (`twin-review-regressions`) now
passes, for the right reason: its call names "Google Ads", so the Meta campaign with the same id is
another campaign. Its `it.fails` was removed; R-39's pin is unchanged.

**The demo world, before and after on the same seed:**

| | Changed? |
|---|---|
| Branch scorecard rows: 44 branches × October, September, both | **No** (identical) |
| Company totals per period: paid-media spend ($460,585.84 / $512,706.06 / $973,291.90), acquired, paid customers (1,724 / 1,910 / 3,634), unknown, collected, refunds | **No** |
| Decision holds (3), budget signals and their blockers (44 branches) | **No** |
| Paid-CAC trace values; cash traces | **No** |
| Campaign attribution: 13,321 leads matched (155 ids); their 4,689 customers show the same campaign as before | **No** |
| **45 B09 calls labelled "Google LSA" carrying `pmax-lsa-B09`, a Google Ads campaign's id** | **Yes: unresolved.** The label names Google Local Services, and no Local Services campaign has that id. Their 15 customers' journeys no longer show "B09 Coral \| Local Services (Performance Max, pay-per-lead)"; they say why. B09's October trace explains it in one line ("…12 paid customer(s) they credit are counted…"). Counts unchanged |
| Every other line of the traces, including the unmapped-campaign lines the AI investigator quotes | **No**: their wording was kept, so the investigator's text does not move |

These 45 leads are the coverage-gap incident's own evidence: Local Services leads arriving under
the Google Ads campaign that replaced the Local Services one. The coverage-gap detection reads
spend and leads by channel, not by campaign id, so it is unaffected.

**Time** (the lab database, five warm runs, medians):

| Query | Before | After |
|---|---|---|
| Scorecard, all branches | 666 ms | 685 ms |
| Scorecard, one branch | 658 ms | 682 ms |
| Budget signal (B09) | 98 ms | 98 ms |
| Decision holds | 428 ms | 442 ms |
| Paid-CAC trace (B09) | 819 ms | 842 ms |

The first working version was much slower (scorecard 887 ms, decision holds 3,872 ms). Three plan
causes were found and fixed without changing a result:
- the platform function ran five or six times a row (fenced with `offset 0`);
- a union-and-aggregate function body could not be inlined (rewritten as expressions: 169 → 70 ms
  over 13,366 leads, identical results on every lead);
- the new join reordered the scorecard so every customer's first touch was credited before the
  period filter (the period's customers are now materialized first, as `channelRows` already
  does).

**The evidence surface.** In the production build, B09 customer 414913's attribution reads:
campaign `pmax-lsa-B09`, "Not matched: no Google Local Services campaign has this id." Its channel
(Google Local Services) and every amount are unchanged
(`campaign-platform-match/customer-414913-unresolved.png`). A matched customer, 407104, shows its
campaign as before. The paid-CAC trace lists the same explanation under "What the number cannot
see".

**Regression** (one clean full run on the final code, every step exit 0):

| Step | Result |
|---|---|
| Typecheck, lint, build | pass |
| Unit and integration tests | 74 files: 885 passed, 1 expected failure. Was 876 + 2 expected failures (R-39 and R-46): 8 new fixture tests, R-46's pin removed |
| Frozen eval packs: AI (15/15), investigator held-out, ChangeGuard held-out, VP acceptance (`--twice`), Shadow acceptance (`--twice`) | **Identical** to the previous regression, line for line (timings, run ids and process ids aside), including the existing FAIL/CRIT lines VP-01/05/06/09/10/12 |
| Browser suite, with pixel baselines | 125 passed, 1 skipped (the demo video), 0 failed |

- **An earlier full run failed one test.** `metric-trace.test.ts` expected the unmapped-campaign
  line's old wording, which I had changed to name the platform.
- **Why that wording matters:** the AI investigator quotes that line word for word, so changing
  it would have moved investigator output.
- **What changed back:** the wording was restored, and the fixture now identifies the campaign by
  its evidence id instead. The run above is the rerun.

## 4. What stayed invariant

- **Source totals:** spend, held spend, cash, refunds, leads, customers acquired, and the channel
  each customer is credited to.
- **Records:** no record or amount is dropped. An unresolved customer stays counted, as one whose
  lead carries no campaign id always was.
- **The channel rules (mappers), R-39 and FI-4/R-50:** not touched.
- **The frozen eval packs:** their outputs are identical; no pack or baseline was edited.

## 5. What remains unresolved

- ~~**ChangeGuard still counts a campaign's leads by id alone.**~~ Done in a second change the
  same day (§6). The frozen ChangeGuard held-out pack's output did not move.
- **Local Services after Google's migration.** A call labelled "Google LSA" whose id belongs to a
  Google Ads Performance Max campaign stays unresolved.
  - Tying it to that campaign needs a contract saying Local Services leads can belong to a
    Performance Max campaign with local services enabled.
  - That typing is read by `ads@1.1` (staged), not recorded by the active `ads@1.0`.
  - This is a decision for Moxie, not made here.
- **A web form with a gclid and a non-Google paid utm_source** is unresolved for its campaign. Its
  channel credit still follows the web mapper (the gclid wins: Google Search). The channel rules
  are out of scope.

## 6. ChangeGuard reads the same match (second change, 2026-11-13)

**The rule in ChangeGuard.** A campaign's lead evidence is its own leads: those whose record names
its platform, read from `v_lead_campaigns`. There is no second resolver. This holds in the
preflight, in the evidence recorded at release, and in every scheduled check.

- **Another platform's lead** with the same id is that platform's campaign's. It never supports,
  contradicts or drifts this one.
- **An unresolved lead** (no platform named, two, or one with no campaign of the id) is kept
  apart. It is neither support nor drift.
- **When unresolved leads could change an answer,** the answer is not certified, and the check
  says why.
  - "Could change" is read twice: with the unresolved leads at the proposed branch counted and
    none elsewhere (best), then the reverse (worst).
  - Leads at the branch only improve the coverage verdict; leads elsewhere only worsen it. Every
    other way the unresolved leads could turn out lies between the two (`unresolvedBounds`).
  - "All counted or none" is not enough: two at B13 and two at B20 can leave a split a split when
    all four count, and make it a disagreement when only the two at B20 do (tested).
- **The shared-id guard is unchanged.** While another platform's campaign uses the id, monitoring
  certifies nothing, neither "current" nor "drift".

### 6.1 Where a bare id selected leads (traced before editing)

| Surface | Where | Before | Now |
|---|---|---|---|
| Preflight coverage, brand check, approval hash | `readCampaignBase` (`preflight.ts`) | every lead with the id | own leads; unresolved and other campaigns' leads counted apart |
| Release evidence and its sources | `releaseChange` (`service.ts`) | every lead with the id | own leads; unresolved recorded apart (`releaseEvidence.unresolved`) |
| Monitor: contradicting leads | `conflictingLeads` (`monitor.ts`) | every lead with the id | own leads |
| Monitor: delivered since release | `sinceRelease` | every lead with the id | own leads |
| Monitor: feeds that must be current | `evaluate` | every lead's source | own and unresolved leads' sources; never another campaign's |
| Monitor: the shared-id guard | `evaluate` (`sharedId`) | campaigns with the id | unchanged |

### 6.2 The fixture (expected results written by hand first)

`tests/integration/changeguard-campaign-platform.test.ts`, synthetic.

- **World A:** Google ("G777 search") and Meta ("M777 leads") share id 777.
  - 6 "Google Ads" calls at B12 and 8 "Facebook" calls at B20.
  - Two unresolved leads at B12: a "Direct" call, and a web form with a gclid and utm
    facebook / paid_social.
  - One customer per campaign, $149.00 collected from each.
- **World B:** Google alone uses 888, with 5 "Google Ads" calls at B13.

### 6.3 What each surface saw, before and after

The "before" column was printed from the old code on this fixture, not inferred.

| Surface | Before (id alone) | After (own leads) |
|---|---|---|
| Preflight G777 → B20 (wrong) | **ready for review**: "8 of 16 lead(s) … arrived at B20". Meta's 8 counted as support | **preflight failed**: `LEAD_EVIDENCE_DISAGREES`, 6 at B12 |
| Preflight G777 → B12 (right) | **preflight failed**: the wrong change was in review (`COMPETING_CHANGE`); coverage split | **ready for review**: pass. The 2 unresolved are noted: "counted or not, they would not change this" |
| Preflight M777 → B20 | warn: split, 8 of 16 | warn: `LEAD_EVIDENCE_UNRESOLVED`. Its own 8 agree; the 2 unresolved could make it split |
| Release evidence, M777 | B12 8, B20 8, split; sources calls and web | B20 8, agrees; sources calls; unresolved 2 at B12 |
| Release evidence, G777 | never released | B12 6, agrees; sources calls; unresolved 2 at B12 |
| Check after a "Facebook" lead with 777 lands at B05: M777 | insufficient evidence (guard); now B12 8, B20 8, B05 1; "they may be the other campaign's" | insufficient evidence (guard); now B20 8, B05 1: its own lead, at a branch the approval never saw |
| The same check: G777 | — | insufficient evidence (guard); now B12 6; no contradicting lead |
| The B20 partner reads M777's check | the Google campaign's name, "G777 search", shown | B20 rows only; "a campaign outside your scope" |
| World B: a "Direct" call with 888 lands at B05 | **drift**: one review item; the change goes to recovery required | **insufficient evidence** (`LEADS_UNRESOLVED`); no review item; still verified |
| World B: then a "Google Ads" call with 888 at B05 | — | **drift** (`LEAD_OUTSIDE_APPROVED_EVIDENCE`, `EVIDENCE_VERDICT_WORSENED`); the contradicting record is that call alone |

- **Money:** company spend, customers and cash are identical before and after every release and
  check. Each release moved exactly its campaign's spend. No check changed a mapping.

### 6.4 The change

- **`preflight.ts`:**
  - `readCampaignBase` reads own, unresolved and other-campaign leads through `v_lead_campaigns`.
  - `unresolvedBounds` and `unresolvedVerdicts` say what the unresolved leads could make of it.
  - New warn code `LEAD_EVIDENCE_UNRESOLVED`.
  - The approval hash gains a key only when unresolved leads could change the verdict.
- **`service.ts`:** release sources from own leads; `releaseEvidence.unresolved` when any.
- **`monitor.ts`:**
  - The three lead queries.
  - `LEADS_UNRESOLVED`, after the guard and before drift.
  - The guard's and the evidence check's wording, and two limitation lines.
  - The scope.
  - Redaction of unresolved rows, and of another campaign's name outside the viewer's scope.
- **`summary.ts`, `review.ts`, the change and check pages:**
  - The decision summary's lines.
  - The branches a check names include its unresolved rows.
  - The change page withholds a finding or a correction that names a branch outside the viewer's
    scope, as the check page already did. Its impact list, impact table and "other branches"
    line count such branches instead of naming them.
  - Question 1 names the campaign's platform.
- **Without unresolved leads or a shared id,** every sentence, evidence object and hash reads as
  before.

### 6.5 Expectations that changed

- **`post-release-monitoring.test.ts`, "an ambiguous campaign id":** two expectations encoded the
  bare-id rule.
  - The test's B05 lead is labelled "Facebook", so it is the Meta campaign's lead.
  - The detail no longer says "may be the other campaign's".
  - The scope is B12, not B05 and B12.
  - Unchanged: outcome, reason, check states, both campaigns in scope, no review item, the mapping.
  - Not a regression. The comment in the test says so.
- **The new fixture:** one hand-written expectation listed only `LEAD_OUTSIDE_APPROVED_EVIDENCE` for
  World B's drift.
  - The existing rule also gives `EVIDENCE_VERDICT_WORSENED`: 5 of 5 at B13 becomes 5 of 6.
  - The old code gave both reasons for the same lead.
  - Corrected in the test, with a note.

### 6.6 Results

| Check | Result |
|---|---|
| The new fixture | 8 tests pass: World A (4), the bounds and the approval hash (2), World B (2) |
| ChangeGuard, monitoring, drift-review and review suites (9 files) | 123 passed, 1 expected failure (R-39's pin) |
| Frozen ChangeGuard held-out pack, unchanged | **Identical** to its baseline: the 50 scenario lines and the 4,637-line JSON report, timings aside, including the existing FAIL lines |
| Demo world: every campaign's ChangeGuard evidence, by id alone against own leads | 155 of 156 identical. `pmax-lsa-B09` differs: its 45 "Google LSA" calls are unresolved. A preflight on it now warns (`LEAD_EVIDENCE_UNRESOLVED`: they could make it agree) instead of passing; a check on a release of it would say `LEADS_UNRESOLVED`, not drift. No id is shared in the demo world |
| Full regression, one clean run, every step exit 0 | Typecheck, lint, build. Vitest: 75 files, 893 passed and 1 expected failure (was 885 + 1: the 8 new tests). The five frozen eval packs (AI, investigator held-out, ChangeGuard held-out, VP and Shadow acceptance `--twice`) identical to the R-46 run, line for line and report for report; only timings, a Node process id and the recorded commit differ, and the existing FAIL/CRIT lines are the same. Browser suite: 125 passed, 1 skipped, as before |
| After the regression: one more display change, the change page's impact lines scoped to the viewer | Typecheck, lint and build again; the two browser specs that open change pages (`zzz-changeguard`, `zzzzz-post-release-monitoring`, which reads a change as the brand lead) on a fresh seed: 4 passed |
| Production-browser journey (`next start`, synthetic database, both viewers in fresh browser contexts) | 20 of 20 checks pass. Screenshots below |

**The journey.** Both worlds in one synthetic database, the production build, screenshots in
`campaign-platform-match/`.

- **Marketing analyst:** the change list → change #3 (M777 → B20) → its decision summary → "Read
  the shared-id evidence" → the check.
  - Question 1 names the campaign: Meta, "M777 leads".
  - "Approved on 8 at B20 (agrees), not counting 2 lead(s) with the id that match no one campaign."
  - The check: insufficient evidence (the guard). Its own leads are 8 at B20 and 1 at B05; the 2
    unresolved are at B12; "google_ads · G777 search · mapped to B12".
  - Change #4 (G888 → B13) → "Read the unresolved leads": `LEADS_UNRESOLVED`, no review item.
  - `changeguard-marketing-change.png`, `changeguard-marketing-check.png`,
    `changeguard-marketing-unresolved-check.png`.
- **B20 partner, the same path:**
  - The coverage finding is withheld. The check shows B20 rows only, and "a campaign outside your
    scope".
  - Neither page's HTML nor its payload carries "G777 search", B12, B05, the Google account, or an
    unresolved or out-of-scope record's id.
  - Change #1, the wrong G777 → B20, is in the partner's scope. It failed. The branch its leads
    land at is counted, not named, and no correction is offered. The campaign's own name is shown:
    it is the change's subject, and the change's exception line named it before this change too.
  - Change #2 (G777 → B12): refused.
  - `changeguard-partner-change.png`, `changeguard-partner-check.png`,
    `changeguard-partner-wrong-change.png`.
- **Money on that database:** source spend $1,200.00, 2 customers, $298.00 collected. The reported
  paid spend, customers and cash match, before and after the releases and the check. Each mapping
  is at version 2, set by its release; the check moved none.

### 6.7 Recorded evidence and approvals

- **Nothing stored is rewritten.** Preflights, approvals, release evidence and checks stay as
  recorded. A check run before this change keeps its bare-id evidence and wording.
- **Older releases:** their bare-id evidence is still what later checks compare with. Its extra
  approved branches only widen what a check accepts; they never create a contradiction.
- **Pending approvals:** one made before this change stays valid at release when the campaign's own
  leads give the same branches, verdict and majority, and no unresolved lead could change the
  verdict.
  - Otherwise the release finds the evidence moved and sends the change back to draft, as it does
    for any evidence change.
  - Such an approval rested on another campaign's leads, or on leads that decide its answer.

### 6.8 What remains

- **A shared id is never certified** by monitoring, by design. The guard was not weakened.
- **The 45 B09 Local Services calls stay unresolved.** No contract ties Local Services leads to a
  Performance Max campaign (`ads@1.1` typing is staged, not active). ChangeGuard now says so for
  `pmax-lsa-B09` instead of counting them.
- **Change titles name a campaign by id alone** ("777: unmapped → B20"). Two campaigns that share
  an id read the same in the change list. The change page names the platform. Titles are stored
  at creation and were not rewritten.
- **R-39 and FI-4/R-50:** untouched.
- **Seen, not changed:**
  - The check page's two evidence tables keep their lead counts in a horizontally scrolled column
    at desktop widths. The drift-review screenshots taken before this change show the same.
  - A refusal names the branch outside the viewer's scope ("B12 is outside your branches"). That is
    ChangeGuard's general refusal message.
  - Switching roles in one browser tab keeps pages rendered for the previous role in the client's
    route cache: demo mode's role cookie (R-2). A fresh load as the restricted viewer carries
    nothing outside its scope.
