# Stage 8: intermediate zoom-out review

- **Target:** `docs/agent-work/HOLD-TO-DECISION.md`, full file (lines 1-504), unchanged since the earlier stages, as of 2026-11-18.
- **Reviewer:** `egm-zoom-out` against `zoom-out-standard.md`, with the Stage 5, 6 and 7 reports and the same 19 context files.
- **Task:** judge the additions and mitigations the Comprehension and Critic stages ask for, at the zoom-out altitude, and say whether the Stage 5 findings still stand.
- The findings below are the reviewer's own.

**Verdict: revise before promotion.** No Blockers, 5 Major, 3 Nit. Severity is in words because the reviewer could not use emoji.

**Coverage.** The reviewer read the persona and `zoom-out-standard.md`, the target, the three earlier reports and all 19 context files. Because several later claims carry a lot of weight, it also read some files outside the supplied context, marked "(outside)": `eligibility.ts`, `scorecard.ts` (HELD_SPEND), `marketing.ts`, `project.ts` (currency gate, searched only), `consumers.ts`, `health.ts`, `movement.ts:320-330`, `gap-status.ts` (searched), `ReplayPanel.tsx` (searched), `BUSINESS-FIT.md` (searched) and `README.md`. Every file was readable, so the review is complete.

**Context sufficiency: pass**, as in Stage 5.

## Findings

### F1. Major: half of the "one rule" Z1 and C1 asked for already exists in the live code

**Scope:** §1.2 (38-44); §2 N1 (158-180, especially 167); §3 (254-258); §6 (325-334, especially 330); §7 (343-345). Also Z1, C1, D-M5, D-B1(e), D-B2, and Stage 6 Majors 2-3.

- **What changed after this record.** Since 2026-11-17, a held day gets a reason with `holds: true, couldChange: true` (`eligibility.ts:234-247`, outside).
  - A held day is a campaign-day with an excluded or quarantined record and nothing counted (HELD_SPEND, `scorecard.ts:88-99`).
  - That reason joins `heldBy` (`decision.ts:219-221`) and fails the channel's readiness as `cost_held` (`verdicts.ts:452-458`).
  - `BUSINESS-FIT.md:236` records the policy: "a held channel cannot carry an action on its cost; the pair it does not touch stays comparable; the branch-wide recommendation is held".
  - So lines 167, 255, 330 and 343-345 were true at `718e4aa` and are out of date now. The question the record leaves as "Moxie's call" is closed.
- **The reviewer's view of Z1 changed.** Z1, C1 and D-B2 say the `no_longer_counted` lift frees a decision without any correction. In the live code it does not. When a newer revision with no stated currency removes the counted row (line 256), the day becomes held spend, and eligibility still holds the recommendation and that channel's readiness. What is left is wrong narration:
  - the incident resolves as "Corrected." (`reconcile.ts:358-361`);
  - it shows "Counted now, corrected dates: $0.00" (`page.tsx:288`) and "No amount changed" (`RevisionHold.tsx:42, 86-87`);
  - the company-level group calls the record "a day the ledger never counted … a limitation, not a hold" (`refused-revisions.ts:213-214, 265`). Both halves of that sentence are false.
  - D-B2's remedy is enough here: treat `no_longer_counted` and `other` as a hand-off, never as "Corrected" and never as $0.00. C1's new relation would duplicate HELD_SPEND, so reject it.
- **What Z1 still gets right.** One root condition, "the source's newest revision is not the one counted", is held in two ways:
  - If an older row is counted, the hold is an open incident. Every channel's readiness fails (`verdicts.ts:436-447`; `refused-revision.test.ts:153`).
  - If nothing is counted, the hold is an eligibility reason. Only that channel fails, and the pair it does not touch stays comparable.
  - So how far the hold reaches depends on whether an older row survived.
- **Simplest consistent end state.**
  - Eligibility already has a `refused` code (`eligibility.ts:20-24`). It reads live, per channel and per period, and uses "not confirmed" wording, as `verdicts.ts:423-427` already does.
  - If eligibility read `v_refused_spend_revisions` beside HELD_SPEND, three things would leave the decision path: the gate's JSON period special case (`refusedDatesInPeriod` and `refusedRevisionsInPeriod`), the capped list as the gate's input (F2), and reconcile lag for this condition (F6).
  - The incident would stay as the record of what was refused and what lifted it.
  - This changes §1.4 scenario 1 ("held by an incident") and the readiness of channels the hold does not touch, so it is a decision to record. It is, though, the rule `BUSINESS-FIT.md` §10 already set for held spend, and the direction of commit 350fb45 ("one boundary decides all views").
- **Minimum before promotion:** state which mechanism holds which case; replace §2's N1 subsection and §6 with a pointer to `BUSINESS-FIT.md` §10; fix the hand-off narration and the "limitation" copy.

### F2. Major: evidence should be kept per campaign-day (Z8 upgraded from Nit)

**Scope:** §3 rules 1 and 1a (206-212), COMPLEXITY (239-243); §4 incident row (287); §7 (349). Also Z8, C4, D-B3 and T-N11.

- **The reviewer's view of Z8 changed.** It had treated the 50 cap as a remote edge. Normal operation reaches it, for two reasons: every re-fetch of a recent day is a new raw event (`marketing.ts:350-358`, outside); fractional conversions are routine under data-driven attribution (`marketing.ts:328-330`). So a day refused for fractional conversions gains another "newer" refusal on every fetch.
- **The cause is the unit, not the cap.** Evidence is keyed by raw event, but the invariant in §1.2 is per campaign-day. That mismatch causes D-B3's multiplied money (`page.tsx:289`; `RevisionHold.tsx:42-43`), the wrong campaign-day count (`page.tsx:163-167`), and C4's false "Already corrected" entries from rule 1a's capped `gone` list (`reconcile.ts:351-353`).
- **Simpler fix.** Keep one entry per campaign-day: its newest refused revision against the counted one. Have rule 1a decide lifts from the view, comparing campaign-day identities. This is C4's first option and Z8's remedy. The list is then bounded by campaign-days, money is summed once, and the cap only limits what is displayed.
- **Reject** C4's child table (new state that can drift from the view) and D-B3's paging (UI for a list that no longer grows with each fetch). Keep D-B3's re-fetch test, because it is the test that proves the per-day unit.

### F3. Major: Z3's single branch rule is right, but the rule it proposed to promote is the one D-M4 shows is wrong

**Scope:** §1.2 (46-48); §3 (198-203, 214-221). Also Z3, C6 and D-M4.

- Z3 proposed promoting `RAW_EVENT_BRANCH` (`tools.ts:82-84`) to one shared SQL function. That rule, like `v_quarantine_holds` (`0034:61`), takes a branch named in the payload before the campaign's mapping. This is the precedence D-M4 exploits, and it contradicts §1.2. Adopting Z3 as written would spread that hole to the trace, the shadow snapshot and the investigator.
- **Amended remedy.** For ads spend, the branch is the campaign's mapping and any payload branch keys are ignored. Every other source keeps `payload_branch`. "Whether it holds" stays a separate predicate.
- That one function also fixes C6's bypass. `getIngestionFailures` (`tools.ts:512-523`) groups by it like everything else. C6's structural grep test and its versioned eval projections become unnecessary; re-baseline the evaluation packs once.
- The reviewer's view of Z3 changed only in its remedy.

### F4. Major: the way out of a systematic refusal is already scoped in code: store decimal conversions

**Scope:** lines 3-4; §1.2 lift paths (43-44); §1.4 scenario 4 (76); §3 BUG (184-186); §4 (287). Also C2, C3, Z9, D-M1, D-B1(b) and (f), D-N2, and Stage 6 Nit 3.

- **D-M1's analysis holds.** The code itself names the root fix and its cost: "storing it needs a numeric column and a `_v2` reporting view" (`marketing.ts:328-330`). This is a bounded change that removes the main source of permanent holds. The hold mechanism is still right for currency and campaign-type refusals, because those affect the cost and the channel the decision reads. Record it as the planned way out, with its trigger.
- **Reject, as scope the problem does not need:** C2's per-field acceptance; D-B1(f)'s audited override; D-M1's plan for retaining or aggregating refused records (nothing measured shows a cost, and F2 bounds the growth). D-M1's bound on `fetchedAt` is sound, but it is an intake rule, not part of this change.
- **C2's auto-proposed replay would cause harm today.** No shipped mapper accepts these records correctly:
  - v1.0 and v1.1 require whole conversions (`marketing.ts:308, 365`).
  - The only mapper that maps an AMBIGUOUS_CAMPAIGN_TYPE record is v1.0, and it files the campaign by platform alone (318-322, 377-386). That is the B09 misfiling.
  - Yet the rail offers every shipped version (`page.tsx:530`; `ReplayPanel.tsx:111-114`).
  - So §1.2's "or the refused revision itself is accepted", and `refused-revisions.ts:54`, describe a path that cannot happen today for the headline code and is a regression for another. Both should name the real ways out: a newer accepted revision from the source, or a new mapper version.
- **The decimals mapper and C3's fix must ship together.** Replaying the held records through a decimals mapper is exactly C3's case. Replay sets `projected_at = now` (`replay.ts:207-211`), and `gap-coverage.ts:170` then reads the record as re-mapped in place, so a real amount change is hidden. Of C3's two options, recording the overwritten amount when a projection replaces a row removes the reconstruction on the read side. Stamping the projection's origin keeps the reconstruction and adds a column.

### F5. Major: the Stage 6-7 documentation requests pull against Z5

**Scope:** the whole record. Also Z5; Stage 6 Majors 1 and 3-7, Nits 1-2 and 4-6; D-B1, D-M2, D-M7, D-N3, D-N7; S1-S8; T-M2, T-M4, T-M6.

Taken together, the later stages ask for a six-option Alternatives section, a risk table with owners and links, a full traceability matrix, a glossary and a restructure into the spec template. Z5 asked for a shorter record. Both can be satisfied if the record stays a record and grows only where its own conclusions depend on it. Its current order (expectations, reproduction, fix, surfaces, verification, open edges) suits a record.

**Add these, because each replaces an overclaim or meets a promise the record made:**

- **One data-flow paragraph.** It should say which incidents become blockers and for which period, and what each view reads: Decision Lab the gate's blockers, the Overview `decisionHolds`, the incident its own evidence, and the daily evidence the view, live. It should also say that held spend goes through eligibility, and that the gate reads the last reconcile, which runs asynchronously. This answers Stage 6 Major 4, D-M2 and T-M4, and replaces lines 278-281.
- **Three definitions:** period, decision window and selected week (Stage 6 Major 5).
- **One results row per §1.4 scenario,** including scenario 7's `regression` step (`advance.ts:14-16`; `GUIDE.md:79-80`). Lines 21-22 promise this, and it can replace §5's prose.
- **One provenance table** linking each build to its commit and evidence.
- **A note on the four choices that changed correctness:** incident kind (Z2), unit of evidence (F2), which mechanism holds (F1), and decimals versus refusal (F4). This meets D-B1 and S1 without a six-way comparison.
- **One line on what the project is and who Moxie is, plus real paths.** B09-RECOVERY, REMAINING-RISKS, BIVE-ACCEPTANCE, RELEASE-CANDIDATE and PREMIUM-POLISH all exist under `docs/agent-work/`, and GUIDE and WALKTHROUGH already carry the Google URLs. Link the coverage-gap backstory and F2 rather than retelling them.

**Skip these:**

- S3's restructure into the spec template.
- Likelihood, owner and tracked-issue columns (D-M7, S8). The README describes an independent, synthetic proof-of-work, so those columns would have nothing behind them. One status per open edge is enough: accepted, fix planned, or decided (and where). The defects from D-B2 and D-B3 have cheap fixes and should be fixed, not listed as risks.
- A separate glossary, once the definitions above exist.

**Delete these, which answers several requests at once:**

- Replace §2's N1 subsection and §6 with a pointer to `BUSINESS-FIT.md` §10.
- Move §9 to its own record. Take Stage 6 Nits 5-6, C8, D-N7, T-M5, T-M9 and T-N9 with it.

### F6. Nit: C5's "pending reconciliation" blocker would change the gate for the whole product

**Scope:** §1.5 (106-107); §4 (278-281). Also C5 and D-M2.

- Reconcile lag affects every incident that holds a decision, not just this change.
- If a pending state is ever added, the check already exists: `consumerBacklog` (`consumers.ts:75`, outside), which Audit & Health already reads (`health.ts:36`). No new watermark comparison is needed.
- Here, one sentence in F5's data-flow paragraph is enough. Under F1's end state, the lag disappears from this condition's decision path anyway.

### F7. Nit: same-instant and "does the amount matter" rules need no fingerprint at intake, but Z7 must come first

**Scope:** §1.3 (56); §7 F8 (340-342). Also C7, Z7 and D-B1(a).

- C7's canonical fingerprint (rules for each source, a hash column, an index) is more than this edge needs.
- The view already carries `refused_cents` and `accepted_cents`, which is enough for either rule.
- But `refused_cents` ignores the record's currency (Z7), so any amount comparison depends on fixing Z7 first. Z7 now matters more; its severity is unchanged.

### F8. Nit: pick the cheaper of two offered remedies

**Scope:** lines 89, 296; §7. Also D-M3 and D-N5.

- **D-M3:** rewording to "added nothing; the total is now $X" is honest and adds no state. Storing a total at detection adds state.
- **D-N5:** follow the coverage gap's existing `previousVerifications` pattern (`reconcile.ts:321-329`), or say that the history does not survive a reopen. Do not build a new history structure.

## Endorsed as written

These are cheap, make the record more honest and do not change the design:

- **Narrower test claims:** three codes, example tests rather than a property test, and "an id the ledger never counted" (D-M6, T-M1, S15).
- **Corrected lists:** the FILES and SHARED PRIMITIVE lists (Z4, S16, T-M7).
- **Index and campaign-key fixes** (D-N1, T-N5).
- **The expected vitest failure, named** (D-N4).
- **Plain-word error reasons:** extend `refusalReason` (D-N6).
- **One meaning per form of "held"** (Stage 6 Major 1).
- **F2's condition shown beside the Verified row** (T-M8).
- **Axe re-run on the final §9 build.**

## Do the Stage 5 findings still stand?

| Finding | Status |
|---|---|
| Z1 | Stands in substance. Impact and remedy changed (F1). |
| Z2, Z4, Z6 | Stand unchanged. D-B1(c), T-M4 and D-M2 confirm them independently. |
| Z3 | Stands; remedy amended (F3). |
| Z5 | Stands; reconciled with the later requests in F5. |
| Z7 | Stands; now a precondition for any amount comparison (F7). |
| Z8 | Upgraded from Nit to Major (F2). |
| Z9 | Stands; coupled to the decimals way out (F4). |
| C1 | Superseded. Reject the new relation; keep the point about narration. |
| C2 | Keep only the cheaper variant (store decimals). Reject per-field acceptance and the auto-replay. |
| C3 | Fix together with the decimals mapper; record the overwritten amount. |
| C4 | Use option 1 with the per-campaign-day unit; reject the child table. |
| C5 | Out of this change; reuse `consumerBacklog` if it is ever done. |
| C6 | Absorbed by F3. |
| C7 | Reject. |
| C8 | Belongs to §9's own record. |

## Conflicts among the requests

- **Z3 and D-M4** disagree on which source names the branch (resolved in F3).
- **C1 and the eligibility code:** C1's relation duplicates what eligibility already does (F1).
- **C2's auto-replay and §1.2's second lift path** do not match today's mappers (F4).
- **The decimals mapper and C3's one-second rule** must change together (F4).
- **C4's child table and D-B3's per-day unit** are rival fixes (F2).
- **C6's versioned projections and the single branch function:** the function makes them unnecessary (F3).
- **Amount comparisons and Z7:** D-B1(a) and C7 compare amounts, which Z7's currency blindness makes unsafe (F7).
- **The added documentation and Z5's request to shorten** (F5).
- **RevisionHold's "Nothing on this page lifts it" and the rail's replay panel** (Z2). F4's wording settles it.
