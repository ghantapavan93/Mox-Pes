# Stage 5: initial zoom-out review

- **Target:** `docs/agent-work/HOLD-TO-DECISION.md`, full file (lines 1-504), as of 2026-11-18.
- **Reviewers:** `egm-zoom-out` against `zoom-out-standard.md`; `egm-inventive-catalyst` with no standard.
- **Goldfish context:** 19 files the record names, read from the working tree: `lib/reconcile/{refused-revisions,reconcile,gap-coverage,gap-days}.ts`, `lib/metrics/decision.ts`, `lib/decision/verdicts.ts`, `lib/ingest/replay.ts`, `lib/ai/tools.ts`, `database/migrations/0034_refused_spend_revisions.sql`, `app/exceptions/[id]/page.tsx`, `components/incidents/{RevisionHold,GapRecovery,DecisionWindow}.tsx`, `components/ui.tsx`, `docs/design-system.md`, `tests/integration/refused-revision.test.ts`, `tests/acceptance/b09/advance.ts`, `docs/agent-work/hold-to-decision/{GUIDE,WALKTHROUGH}.md`.
- **Mode:** consolidated (no checkpoints). The findings below are the reviewers' own; the Elephant's assessment is in `consolidated_review_report.md`.

## egm-zoom-out

**Verdict: revise before promotion.** No Blockers, 4 Major, 5 Nit. Severity is in words because the reviewer could not use emoji.

**Coverage.** The reviewer read the persona, the zoom-out standard, the whole target and the supplied context; all were readable. Its persona requires a reuse search, so it also searched the wider codebase; files outside the supplied context are marked "(outside)".

**Context sufficiency: pass.** The objective (a newer spend revision that intake refuses must hold that branch's budget decision for that period, and every view must say so) and the motivation (R-54 case 2, where Decision Lab read "Ready for review", §2 lines 144-156) are both clear. The direction fits the project's model: reconciliation rules in SQL, incidents with evidence, one gate. Folding the three copies of the quarantine group rule into one view (lines 219-221) is a real structural fix.

### Z1. Major: the hold is keyed to the R-54 symptom, not to the invariant the record states

**Scope:** §1.2 lines 38-44; §3 lines 188-190, 209-210, 254-258; §7 lines 343-345.

**Rationale:**

- **What the invariant promises.** The decision may read as free only when the source's newest revision of every campaign-day is the counted one. A hold "lifts only when a newer revision is accepted, or the refused revision itself is accepted."
- **What the code enforces.** A hold exists only while an older accepted row sits beside a newer refused one, because the view inner-joins `ad_spend_daily`.
- **Lifts without a correction.**
  - `correctionsFor` has four outcomes, not two. The extra two, `no_longer_counted` and `other`, both resolve the incident as "Corrected. …", and the page heads it "Hold lifted".
  - One real path: the source sends an even newer revision with no stated currency. The currency gate ("the newest observation decides") deletes the older counted row.
  - The day then falls to the N1 limitation, while the source's newest revision is still not counted.
  - Revoking a currency rule does the same.
- **Not recorded or tested.** This lift path is not in §7, and no test covers `no_longer_counted` or `accepted_itself` (no match under `tests/`).
- **Outcome depends on intake detail.** Whether a condition holds or only limits the decision depends on which intake stage refused the record, and on whether an older row exists. §2 line 171 already notes the held day is left "company level, like the refused revision before the fix".

**Simpler:**

- One rule: "the newest source revision is not the counted revision (the counted one is older, or there is none)". Hold-versus-limit then becomes the single policy switch that §7 hands to Moxie.
- If not that, then: narrow the §3 invariant to what is actually enforced; lift only on `newer_accepted` or `accepted_itself`, or at least stop calling the other outcomes "Corrected"; add the lift-by-removal path to §7.

**Evidence:** `0034_refused_spend_revisions.sql:44`; `lib/reconcile/refused-revisions.ts:52-58, 204, 292-299`; `lib/reconcile/reconcile.ts:353-362`; `components/incidents/RevisionHold.tsx:44-50`; `lib/ingest/project.ts:214-218, 270-279` (outside); `lib/currency/rules.ts:171-179` (outside).

### Z2. Major: "No new incident kind" sent the hold to every reader of the quarantine incident kind, and several now describe it falsely

**Scope:** §3 lines 206-207, 219-223, 234-237.

**Rationale.** In this product, "quarantine" means held lead records whose customers lose attribution (README lines 17-21). Before migration 0034 this incident had no branch, so branch-scoped readers never saw it. Now they do, and they tell the lead-record story:

- **AI investigator (deterministic path).** It makes a "strong" hypothesis: "Paid CAC at B09 is overstated: a customer whose only lead record is quarantined counts as channel unknown…". Its stated cause is "the customers they produced have no paid touch". This is the same false "why" that §2 line 151 found on incident #5540.
- **CAC-change inquiry.** It says "October spend missing would lower October CAC", but no spend is missing. It also takes the month from the fetch time, so a September refusal fetched on Oct 31 is reported as October.
- **Suggested questions.** "Why is B09's paid CAC so high?"
- **Incident page.**
  - The generic records table still has its "CRM customer it would attach to" column.
  - The Fix & approval section offers "Replay held records" while RevisionHold says "Nothing on this page lifts it". A replay through a mapper that accepts the record is one of the two lift paths in §1.2.
- **How the sub-kind is recognised.** By JSON shape, through at least four different tests: `evidence ? 'spendDates'`, `Array.isArray(spendDates)`, `evidence ? 'revisions'`, and "has revisions or corrections and a branch". The gate's period fragment applies to any kind that happens to carry `spendDates`.

The record lists two special cases removed and none added. Its control tests cannot catch any of this, because "the demo world has no ads quarantine" (line 237).

**Simpler:** either a distinct incident kind, using the existing extension points (`DETECTED_KINDS`, `DECISION_BLOCKING_KINDS`, `KIND_LABEL`, and the workflow `exceptionKinds` arrays, which keeps the replay reuse); or one exported predicate that all of the roughly twelve `quarantined_source_records` checks in `lib/` go through. Either way, list the special cases added, and put one ads quarantine into the control world.

**Evidence:** `lib/ai/deterministic.ts:552, 593, 633-645` (outside); `lib/inquiry/cac-change.ts:236-241, 280-284` (outside); `lib/ai/queries.ts:354-361` (outside); `app/exceptions/[id]/page.tsx:125, 487, 498-536, 606`; `components/incidents/RevisionHold.tsx:96`; `lib/reconcile/refused-revisions.ts:129, 137`; `lib/metrics/decision.ts:290`; `lib/reconcile/reconcile.ts:346`; `lib/workflow/kinds.ts:138` (outside).

### Z3. Major: a fourth, different branch rule replaces the existing one, and one column now means both "where a record belongs" and "whether it holds"

**Scope:** §3 lines 198-203, 214-217; §2 lines 164-171; §7 lines 346-348.

**Rationale:**

- **The existing rule.** A raw event belongs to the branch its payload names, or, for ad spend, to the campaign's mapped branch. It is already copied three times: `RAW_EVENT_BRANCH`, `EVENT_BRANCH`, and the metric trace. The trace copy calls itself "the same branch rule as the investigator's tools" and cites review F6 ("held spend was invisible here").
- **The new rule.** `v_quarantine_holds.branch_id` gives the campaign's branch only while the refused revision is newer than the counted one.
- **The fusion.** Rule 1 uses that column as the incident's branch, which drives its scope and its fingerprint. So "where the record belongs" and "whether it holds" are now one value.
- **Effects:**
  - The same raw event is B09's in the trace, the shadow snapshot and the investigator's per-record scope check. It is company-level in its incident and in the investigator's group lookup.
  - A held day of a mapped B09 campaign sits in a company-level incident whose own sentence names B09. A B09-scoped viewer cannot open it.
  - The policy that §7 defers is not one switch. Making held days hold would change the view's branch column, the incident fingerprints, rule 1's revisions query and the gate's period data.

**Simpler:** promote the existing rule to one SQL function (`payload_branch` and `try_date` are precedent), and group and scope incidents by it. Make "holds this decision in this period" a separate predicate that the gate reads.

**Evidence:** `lib/ai/tools.ts:77-84, 750-759, 786-794`; `lib/shadow/snapshot.ts:127-130` (outside); `lib/lineage/trace.ts:223-228` (outside); `0034_refused_spend_revisions.sql:61`; `lib/reconcile/reconcile.ts:77`; `lib/reconcile/refused-revisions.ts:264-266`.

### Z4. Major: "one place phrased" and "no view computes the verdict" overstate the consolidation, and the refused hold skips the codebase's own status pattern

**Scope:** §3 lines 214-217, 245-252; §4 lines 278-281.

**Rationale:**

- **Wording lives in at least four places.**
  - Rule 1's SQL summary is what the Overview status line quotes "in the holding incident's own words", and what Decision Lab's `heldBy` shows.
  - `holdSentence` drives the incident verdict and Decision Lab's reasons. So the Overview and the incident word the same hold differently.
  - The suffix "It holds until a newer revision is accepted." is copied twice.
  - RevisionHold builds its own headline, "held until" clause and Next text. The page computes its "Budget decisions" tile itself.
- **No status object.** `gapStatus` already gives a coverage gap one status object, in words, for every view. The refused hold has nothing equivalent.
- **Daily evidence bypasses the gate.** It reads the view directly and finds its incident by JSON containment on `status = 'open'` only. Rule 1a reads open or acknowledged.
- **Incomplete lists.**
  - The FILES list names 7 files. It is missing `movement.ts`, `gap-coverage.ts`, `gap-status.ts`, `RevisionHold.tsx`, `app/page.tsx`, `app/exceptions/[id]/page.tsx` and `OverviewSelection.tsx`.
  - The SHARED PRIMITIVE readers list omits `spendDays` and `unattributedSpend`.

**Simpler:** add a `revisionHoldStatus()` beside `gapStatus()` (label, reason, next) and have every surface use it. Have rule 1 store facts, not prose. Then correct both lists.

**Evidence:** `lib/reconcile/reconcile.ts:81-90`; `lib/metrics/movement-copy.ts:129-138` (outside); `lib/metrics/decision.ts:189, 217`; `lib/decision/verdicts.ts:299`; `components/incidents/RevisionHold.tsx:44-50, 72, 93-97`; `app/exceptions/[id]/page.tsx:293-304`; `lib/reconcile/gap-status.ts:7-19, 174-249` (outside); `lib/metrics/movement.ts:320-328` (outside).

### Z5. Nit: two changes share one record, and the high-level sections are full of evidence detail

**Scope:** lines 10-17, 290-312, 377-504; also 111-117, 158-180, 325-334.

**Rationale:**

- **A separate change inside.** §9 has its own brief, review and verification. It includes a product-wide `Card` frame change "on every page" (line 413; baselines regenerated, line 491). The status block calls this "Same logic, new first screen" (line 17).
- **Scattered provenance.** It spans 5 commits and 6 build ids. The §9 browser specs ran on a build that the record itself says is not the final one (line 490).
- **Detail in high-level sections.** Pixel offsets, contrast ratios, rgb values, Tailwind classes, ports and local paths.
- **Repetition.** N1 is explained in §1.6, §2 and §6, and again in §7.
- **Third evidence view.** §9 adds a third per-date evidence view (`gap-days.ts` plus the date strip), although its own brief (line 387) said "the existing evidence view".

**Recommend:** move §9 to its own record, keep one provenance table here, and move the measurements into the existing `hold-to-decision/` evidence files.

### Z6. Nit: the new modules copy helpers and bypass the shared surface component

**Rationale:**

- **Helpers copied instead of shared:**
  - `channelName` now exists in five identical copies, three of them in modules this work created.
  - The English list-joiner exists in seven copies across the codebase, two of them added here.
  - `unique`, `month`/`monthOf` and `mondayOf` are duplicated too; `movement.ts` keeps its own private copy of `mondayOf`.
- **Micros-to-cents SQL.** It appears twice in new code, although `microsToCents` exists and the migrations already hold small SQL helpers.
- **`Card` bypassed.** RevisionHold, DecisionWindow and GapRecovery hand-copy `Card`'s `rounded-xl bg-surface ring-1 ring-text/10`. `ui.tsx` says pages "do not style surfaces … themselves, so the whole product changes together". The next frame change will miss these three.

**Evidence:** `lib/reconcile/refused-revisions.ts:148-150`; `lib/reconcile/gap-days.ts:41`; `components/incidents/RevisionHold.tsx:11-13, 113`; `components/incidents/DecisionWindow.tsx:84`; `components/incidents/GapRecovery.tsx:15, 172, 295`; `lib/reconcile/gap-coverage.ts:166`; `lib/primitives.ts:23-26` (outside); `components/ui.tsx:6-9`.

### Z7. Nit: the refused amount is read straight from the raw payload, ignoring its currency

**Rationale:**

- The view computes `refused_cents` from the raw `costMicros`, and both surfaces print it with a "$".
- The fixture's own `refusedOther` step is billed in CAD (GUIDE line 70), and the test pins its amount at 40,000 cents. So the screen reads "said $X … because it is billed in CAD".
- It is small but visible. Carry the stated currency through, or drop the $ figure for amounts not in USD.

**Evidence:** `0034_refused_spend_revisions.sql:27-28`; `components/incidents/RevisionHold.tsx:147`; `components/trace/OverviewSelection.tsx:126` (outside); `tests/acceptance/b09/deliveries.ts:90` (outside); `tests/integration/refused-revision.test.ts:55, 137`.

### Z8. Nit: the 50-entry cap creates a second representation, and what happens past it is not reported

**Rationale:**

- **Two arrays.** `revisions` is capped at 50 and `spendDates` is not, so the gate needs two period checks over two arrays.
- **Past 50 entries.** A date in the period can still hold the decision while `revisions` is empty. When that happens: every channel's comparison becomes "unverified"; the refused-revision integrity reason disappears; the daily evidence loses its link to the hold.
- **Corrections cap.** `corrected.slice(-50)` drops the oldest corrections.
- **What §7 says.** Line 349 mentions only the cap itself.

**Recommend:** state these effects, or let the gate read the view instead of a capped JSON copy.

**Evidence:** `lib/reconcile/reconcile.ts:98, 107-108, 353`; `lib/reconcile/refused-revisions.ts:136-146`; `lib/metrics/decision.ts:125-133, 205-206`; `lib/metrics/movement.ts:325` (outside).

### Z9. Nit: where the invariant depends on lineage, the lineage is guessed rather than recorded

**Rationale:**

- **Scenario 6 (one-second rule).** A delivery is told apart from a "re-map in place" by checking whether the record was projected within one second of receipt. A replay keeps the original `received_at` and stamps `projected_at = now`. So a replay that accepts a refused revision (the `accepted_itself` lift) counts as a re-map, and its amount change is left out of `amountChanges`.
- **`correctionsFor`.** It works out how, and by which delivery, a hold lifted from the ledger's current state. If a group replay accepts the newer of two refused revisions of the same day, the older one is reported as "ingestion run #N accepted a newer revision", where #N is the run that refused it.
- **Not stated.** Neither rule appears in §3 or §7.

**Evidence:** `lib/reconcile/gap-coverage.ts:165-172`; `lib/ingest/replay.ts:207-211`; `lib/reconcile/refused-revisions.ts:292-305`.

## egm-inventive-catalyst

6 Major and 2 Nit, all advisory. Severity is in words because the reviewer's output format does not allow emoji.

**Coverage.** The reviewer read the target in full and all 19 context files; for `ui.tsx`, `design-system.md` and `tools.ts` it read the parts the target describes. `lib/reconcile/gap-status.ts`, `lib/metrics/eligibility.ts` and `lib/ingest/ingest.ts` were not supplied; a finding that depends on one says so. "L" means a line of the target.

### C1. The hold depends on the ledger having a row, not on the source's newest revision

**Severity:** Major

**Affected scope:** §1.2 (L38-44), §1.6 (L113-117), §2 "N1 is partly true" (L173-180), §3 ROOT INVARIANT and "Not changed, on purpose" (L188-190, L254-258), §7 "Held days" (L343-345). Subsystem: `v_refused_spend_revisions` and rule 1a.

**False compromise.** The invariant is written in terms of the source's revisions: every mapped campaign-day in the period must have its newest revision counted (L38-41). The view enforces it only where the ledger already has a row (`join ad_spend_daily s`, 0034:44). Held days are excluded by construction (0034:18-19). The doc then treats N1 held days and the "newest observation decides" row removal as separate questions for Moxie (L179-180, L343-345). But N1 held days already break the invariant as written. And because the hold needs a ledger row, losing the counted amount is recorded as a correction:

- `correctionsFor` labels a vanished ledger row `no_longer_counted` (refused-revisions.ts:292-294).
- Rule 1a stores that as a correction and resolves the incident once nothing else holds (reconcile.ts:351-362).
- A chain using only behaviour the doc describes:
  1. Oct 20's revision is refused for fractional conversions, which holds the decision.
  2. The source sends a newer revision with no stated currency.
  3. That policy removes the older row (L256-258).
  4. B09's incident resolves as "Corrected. Oct 20: the ledger no longer counts a revision of this campaign-day."
- So a newer, unaccepted revision lifts the hold, against L43-44 and the failure class at L123.
- The lifted incident then shows "Counted now, corrected dates $0.00" (page.tsx:288 sums `c.correction.cents ?? 0`), which is the L121 failure.
- It also says "No amount changed": RevisionHold.tsx:42 leaves `cents === null` out of `changed`, so lines 86-87 print that sentence.
- The refused record moves to the company-level group, where it is described as "a day the ledger never counted" (refused-revisions.ts:228-233, 265). That is false: the ledger counted $120.91 for that day.

**Proposed resolution (Extraction).**

- Move "is the source's newest revision the one counted?" out of the ledger join into its own relation over the source's revisions. It takes the newest revision per platform, campaign id and date by source clock, left-joined to the ledger.
- Its states are: current; a newer refused revision over a counted amount; and newest refused with nothing counted, split into previously counted and never counted.
- Rule 1, rule 1a and the gate all read this relation.
- Only "the newest revision is now counted" (`newer_accepted`, `accepted_itself`) counts as a correction. Losing the counted row keeps the hold.
- The ledger policy tested in `currency-rules.test.ts` stays as it is.
- Moxie's open question shrinks to the never-counted case. Even that can be decided per record by the gate's existing "could change which channel is cheapest" test (decision.ts:91-94, 216-223), instead of one global hold-or-limit switch.

**Secondary liabilities.**

- Telling "previously counted" from "never counted" needs revision history: a lateral lookup like gap-coverage.ts:165-172, plus an index ending in the source clock (source, entity, entity_id, occurred_at). The COMPLEXITY claim (L239-243) would change.
- Some holds move from company level to their branch. Verified readiness's `complete` rule and the new state could report the same record twice unless one defers to the other.
- §2's N1 measurements, the 177-check runner and the rule tests all need re-baselining.

### C2. The whole revision is refused over a field the decision never reads, and the only stated recovery is to wait

**Severity:** Major (strategic)

**Affected scope:** the opening (L3-4, "after the source corrects itself"), §1.4 scenarios 1 and 4 (L72, L76), §3 BUG (L184-186), §4 Incident row (L287). Subsystem: how intake validation feeds the hold.

**False compromise.** The headline refusal is about platform conversions: "it reports 2.5 conversions and the ledger stores whole numbers only" (refused-revisions.ts:155-156). Users are shown that as a fixed rule.

- The decision reads only spend and CRM customers (verdicts.ts:107-108; decision.ts:10-12).
- The refused cost is readable: the view parses it (0034:27-28) and the page shows "said $400.00" (RevisionHold.tsx:147).
- So a storage choice for a field the decision doesn't use becomes a branch-wide budget hold. Everything downstream (the hold, four surfaces explaining it, correction tracking) exists to compensate.

The stated recovery is to wait: "The source has to send a newer revision … that intake accepts … Nothing on this page lifts it" (RevisionHold.tsx:95-96). Yet the page's side panel offers an engineer a replay (page.tsx:487, 498-536). The fixture only models a source that corrects itself (L76).

If fractional conversions are a standing property of the source rather than a one-off error, every newer revision is refused too:

- restated days hold the decision (R-54), while brand-new days only limit it (N1);
- the hold only ends through a mapper change plus a replay, which is the path C3 shows reports the result wrongly;
- refusal groups quickly pass the 50-revision cap (C4).

**Proposed resolution (Segmentation at field level).**

- Validate and accept per field, according to which consumer reads it. Identity, date, cost and currency go into the ledger; the failing conversions field is held as its own evidence.
- Keep the decision hold for refusals that touch what the decision reads: unsupported currency, unreadable cost, an unidentifiable campaign.
- A cheaper variant: drop the self-imposed integer limit and store conversions as decimals.
- Optional, Blessing in Disguise: when one refusal code keeps recurring for a source, open a dry-run replay plan through the existing propose, dry run and approve path (page.tsx:367-373), so recovery is active rather than a wait.

**Secondary liabilities.**

- "One revision counted per campaign-day" becomes lineage per field. That touches the ledger, the incident's revision table, `correctionsFor` and replays.
- Mapper contracts must declare which fields each consumer reads, and that mapping has to be kept up to date.
- Fractional conversions may signal a wider reporting change at the source. Accepting the cost alone could hide that.
- Consumers that assume whole-number conversions need auditing. The rule tests and acceptance steps built on this refusal code need re-basing.

### C3. "Re-mapped in place" is guessed from a 1-second timing window, so the designed replay lift breaks scenario 6

**Severity:** Major

**Affected scope:** §3 "Scenario 6" (L262-271), compared with §1.2's lift "or the refused revision itself is accepted" (L43-44) and §1.7 (L124). Subsystem: `gapCoverage.amountChanges`.

**False compromise.** "Unless the record was re-mapped in place, which cannot change an amount" (L266-267) is implemented as a timing guess, not a recorded fact:

```sql
and re.projected_at <= re.received_at + interval '1 second'   -- gap-coverage.ts:170
```

- A replay stamps `projected_at = req.now` in both of its modes (replay.ts:207-211).
- That includes the "quarantined" mode (replay.ts:150-158). This mode accepts a held revision for the first time, which is exactly the `accepted_itself` lift (refused-revisions.ts:54, 295-296).

What happens: replaying #200033 through any mapper version that accepts it makes Oct 20 count $400.00.

- The lookup for the amount it replaced is skipped, so `amountChanges` stays empty.
- The verified B09 gap keeps "Reclassified, not added" and prints the live branch total as "stayed $…" (GapRecovery.tsx:285-286, 307-311; page.tsx:127-132).
- Meanwhile the R-54 incident for the same branch and period says the total rose by $279.09 (RevisionHold.tsx:86-88).
- That is both the L124 and the L126 failure.

No rule test or acceptance step performs a replay (advance.ts:14-16; GUIDE.md:9), so "177 of 177" does not cover this path. One dependency is inferred: that `reclassified` requires an empty `amountChanges` comes from comments at gap-coverage.ts:62-66 and GapRecovery.tsx:261-262, because gap-status.ts was not supplied.

**Proposed resolution (Preliminary Action).** Record why a projection happened at the moment it happens. Two options:

- Stamp each projection's origin (intake run, held-record replay, or re-projection) and skip only re-projections. The replay row already stores `mode` (replay.ts:129-133).
- Or (Inversion) have the projection write the amount it displaced onto the ledger row when it overwrites one. Then the read side never has to reconstruct history from timestamps.

**Secondary liabilities.**

- A schema change and a backfill. Rows written before the change have no stamp and must read as "unknown", which withholds the "not added" claim rather than granting it.
- The projection path shared by intake and replay must keep the displaced amount correct under its source-clock guard and under concurrent re-projections.
- The no-new-column variant joins to replays for each covered date on every incident page load.

### C4. The 50-revision display cap is also rule 1a's working state

**Severity:** Major

**Affected scope:** §7 "Revisions on the incident are capped at 50 per group. The gate's period test reads every date." (L349); §3 rule 1a (L209-210); §4 Decision Lab row (L288). Subsystem: rule 1 and rule 1a evidence.

**False compromise.** The cap gives up completeness to keep the row small ("a mass refusal must not bloat the row", reconcile.ts:98), assuming it only limits what the page lists. But rule 1a compares against that capped list: `still` comes from this run's capped detection, and `gone` is "stored before but not in `still`" (reconcile.ts:351-353).

In a group above 50:

- A new refusal that sorts before the 50th entry (oldest date first, reconcile.ts:98-108) pushes a revision that still holds out of `still`.
- `correctionsFor` finds the old revision still counted and records the change as `other` (refused-revisions.ts:292-299).
- The incident then says "Already corrected, and no longer holding it: … the counted revision or the campaign's mapping changed" (RevisionHold.tsx:74-79) about a day that still holds.
- That breaks the design's own promise that "lifting one campaign-day never hides another" (reconcile.ts:339-340).
- `corrected` is appended without de-duplication and trimmed to 50 entries (reconcile.ts:353).

The gate still holds, because it checks the complete `spendDates` list. But its wording reads the capped array (refused-revisions.ts:143-146), and the cap keeps the oldest dates, so the current period drops out first.

- That period's blocker then carries no revisions, so `touches` becomes null (decision.ts:125-133).
- The per-channel "refused_revision" reason disappears (verdicts.ts:293-302).
- The comparison drops to "unverified" (decision.ts:205-206), the opposite of what L288 promises.

**Proposed resolution (Segmentation: separate state from preview).**

- Rule 1a decides lifts against the view itself (is each stored revision still `standing = 'newer'` for this branch?) or against a child table (exception, raw event, state, corrected-by).
- The JSON keeps only a labelled preview, "first 50 of N".
- The gate's in-period list comes from the full set.

**Secondary liabilities.**

- One more indexed query per incident per reconcile. That runs inside the serialized, lock-holding transaction that replays also use (replay.ts:249).
- The child-table option needs a migration, and the preview and the state table must not drift apart.
- Mass refusals now store every row, which is the cost the cap was avoiding, though as indexed rows rather than a rewritten JSON blob.

### C5. The shared rule is a stored result, and the decision path never checks whether it is current

**Severity:** Major

**Affected scope:** §4 "Every view quotes the same facts, and none computes the verdict itself" (L278-281); §1.5 "pending, empty, stale and unavailable evidence are said as such; a loading state never shows 'ready'" (L106-107). Subsystem: reconciliation as the only writer of the hold.

**False compromise.** Views agree because the rule is computed once and stored in `exceptions`, and the gate reads only that table (decision.ts:163-175).

- Reconciliation runs as a consumer after a delivery commits ("then the intake's consumers (reconciliation)", refused-revision.test.ts:65-73).
- Readiness checks only that feeds are fresh (verdicts.ts:472-476, 629-654).
- Each reconcile run records a coverage watermark (`snapshot`, `txid`, reconcile.ts:375, 424). Nothing on the decision path in the supplied code reads it.

So between a delivery and the next reconcile, or indefinitely if the consumer fails, a refused revision sits in `raw_events` while every view reads the older incident set. Decision Lab can say "Ready for review": the §2 symptom (L155-156) in a window the doc never addresses. The acceptance runner reconciles right after each delivery (GUIDE.md:7-8), so it cannot see this window.

**Proposed resolution (Beforehand Cushioning).**

- The gate compares the last reconcile's watermark with the latest intake.
- When reconciliation is behind, it returns a "pending reconciliation" blocker: not ready, and not held by an incident. That uses the "pending" wording L106 already requires.
- Self-Service variant: the read triggers or waits for a reconcile when it is behind.

**Secondary liabilities.**

- A brief "pending" after each delivery, unless there is a grace interval.
- The snapshot and transaction-id comparison must be correct under concurrent transactions.
- One more query per readiness read.
- A stalled consumer becomes a visible, company-wide "pending" instead of a silent, wrong "ready". That is the honest result, but it is noisy to operate.

### C6. The shared rule is not the only path: two readers still use their own

**Severity:** Major

**Affected scope:** §3 SHARED PRIMITIVE and SPECIAL CASES REMOVED ("the group rule had three copies … All now read the view", L214-221); §4 Daily evidence row (L286); §7 trace card (L352-353). Subsystem: secondary readers of "which held records belong to this branch and period".

**False compromise.** The view is the single shared rule, but two readers bypass it:

- **The AI investigator tool `getIngestionFailures`** (a different tool from the one the doc counts). It groups quarantined records by `payload_branch(re.payload)` straight from `raw_events`, and rebuilds the incident link from that branch (tools.ts:512-523). It does not read `v_quarantine_holds`; only `compareMappingVersions` does (tools.ts:750-757).
  - A spend payload names a campaign, not a branch (0034:5-7). So the tool files B09's refused Oct 20 revision under no branch and links it to the company-level fingerprint, which points at a company-level incident or nothing.
  - For a B09-scoped viewer it filters the record out entirely.
  - That is the pre-fix answer (L142), and it is one click from the hold via "Investigate with AI" (page.tsx:184-188). It can contradict the incident (L126).
- **The trace's held-records card.** It filters by fetch time, while the gate decides a period by spend date (refused-revisions.ts:136-146). It was left as is because "the AI evaluation packs read it" (L352-353), so a test fixture is fixing what the product means. At month boundaries, the card and the hold for the same period name different records. That undercuts "opens the exact records behind it" (L3-4).

**Proposed resolution (Intermediary, enforced).**

- Every "which held records, for which branch and period" question goes through one SQL relation: the view, or a function over it that returns the group and its incident id.
- A structural test fails on any other `payload_branch` grouping of quarantined records.
- Give the eval packs their own pinned, versioned projection. The card can then move to spend dates, showing both times on each row, without breaking the packs.

**Secondary liabilities.**

- The tool's counts change for scoped viewers, and eval packs that read either reader need re-baselining.
- Superseded refusals still belong in an ingestion-health answer. The tool needs two labelled lists, "failed validation" and "holding a decision", rather than just the view.
- Versioned projections must be retired deliberately, or they multiply with each consumer.

### C7. Same-instant revisions are resolved on the permissive side

**Severity:** Nit

**Affected scope:** §1.3 Boundary row "at the same instant as the accepted one … no hold (not newer)" (L56); §7 F8 (L340-342). Subsystem: `standing` in 0034.

**False compromise.** A tie on the source's clock is read as "nothing to hold".

- Same-instant records get no branch (0034:39-41, 61), so they land in the company-level group. A B09-scoped viewer cannot open it (page.tsx:93; L346-348).
- The test asserts no hold even when the same instant carries different content (refused-revision.test.ts:275-278).
- Identity and branch are both known; only the order is unknown. §1.2's precondition, that the newest revision is the counted one, cannot be established, yet the decision reads as free.
- The permissive side was chosen to avoid holding on F8-style re-sends.

**Proposed resolution (Preliminary Action).** Compute a canonical content fingerprint at intake, with timestamps parsed and numbers normalized.

- Same instant, same content: a re-send. No hold, and F8's duplicate version can be absorbed.
- Same instant, different content: a conflict, shown as "not confirmed" at the mapped branch.

**Secondary liabilities.**

- Canonicalization rules must be maintained for each source.
- A mapper upgrade that changes the canonical form can create false conflicts.
- A hash column and its index.
- The same-instant test inverts.

### C8. A continuous date strip is traded against touch-target size

**Severity:** Nit

**Affected scope:** §9 brief (L384), §9.2 320 px row (L432), §9.5 "passes AA's 24 px, not the 44 px touch-target aim" (L503-504). Subsystem: DecisionWindow layout.

**False compromise.** Below the `md` breakpoint the strip is 9 columns (DecisionWindow.tsx:108).

- Its two rows (Oct 13-21 and Oct 22-30) cut across the Monday-start weeks that the "selected week" fact (design-system.md:116-118) and the records links (page.tsx:139-156) are built on.
- Each date stays 33 px wide.

**Proposed resolution (Segmentation in space).** On phones, use one row per Monday-start week: 7 columns, with blank cells before Oct 13 and after Oct 30.

- The selected week becomes exactly one row.
- Using the doc's own measured widths, a date grows to about 43 px at 390 px with 4 px gaps (44 px with 2 px gaps), and to about 33 px at 320 px.

**Secondary liabilities.**

- A third row, about 75 px, pushes the action and "What moved" down the phone first screen measured at L294-297 and L449-451.
- Blank cells must sit outside the radio group, and arrow-key order must stay in date order.
- The desktop and phone layouts diverge.
