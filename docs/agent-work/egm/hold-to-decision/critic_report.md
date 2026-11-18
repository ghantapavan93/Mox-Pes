# Stage 7: critic review

- **Target:** `docs/agent-work/HOLD-TO-DECISION.md`, FeatureRange lines 1-504, as of 2026-11-18.
- **Reviewers:** `egm-design` and `egm-structural` against `feature-spec-standard.md`; `egm-style` with no separate standard.
- **Goldfish context:** the same 19 files as Stage 5 (see `zoom_out_report.md`).
- **Note on the standard:** the feature-spec standard is written for a spec drafted before implementation. This target is a record: a frozen spec (§1), a report on what was built (§2-§8) and a second change (§9). Findings that apply the spec template to a record are kept as the reviewers wrote them; the Elephant's assessment is in `consolidated_review_report.md`.
- The findings below are the reviewers' own.

## egm-design

**Verdict: does not pass the standard.** 3 Blockers, 7 Major, 7 Nit. The reviewer read the persona, the standard, the target and the context files it needed, and also the code those files call wherever a claim depended on it: `lib/ingest/project.ts`, `lib/adapters/marketing.ts`, `lib/ingest/ingest.ts`, `lib/metrics/movement.ts`, `lib/metrics/eligibility.ts`, `lib/events/consumers.ts`, `lib/reconcile/gap-status.ts` and `tests/acceptance/b09/deliveries.ts`. Every file was readable, so the review is complete. Severity is in words because the reviewer could not use emoji.

**How the document covers the standard**

| Area | Coverage |
|---|---|
| Problem statement | Present (§2, §3 BUG) |
| Goals and non-goals | Present but scattered (§1, §3 "Not changed", §7, §9.5) |
| Architecture | Components are listed; the data flow and consistency model are missing (D-M2) |
| Alternatives | Missing (D-B1) |
| Risks and mitigations | Constraints are listed with no mitigations (D-M7) |

### Blockers

**D-B1. No alternatives were evaluated for the core design.** Scope: whole document; §3, lines 182-258; §9, lines 392-402.

- The document proposes one path: two SQL views, plus grouping into the existing quarantine incident, plus the gate's period filter. It never weighs another. "No new incident kind" (line 207) is stated, not argued. §9's kept/rejected list covers visual patterns only (fonts, accent colour, hero layout), with no technical trade-off. The standard says a spec with a single unchallenged path fails.
- **Recommendation:** add an Alternatives section that compares, with concrete trade-offs:
  - (a) Hold only when the refused revision's cost differs from the counted one or can't be read, versus holding on any newer refusal. Today a refusal with an unchanged cost still holds: `tests/integration/refused-revision.test.ts:158-161` sends the default cents.
  - (b) Store fractional conversions instead of refusing them. `lib/adapters/marketing.ts:328-330` already proposes a numeric column.
  - (c) A dedicated per-campaign-day incident, versus reusing `quarantined_source_records` grouped by error code. That reuse is the root of D-B3.
  - (d) Evaluating the views at read time, versus the snapshot taken at reconcile time.
  - (e) A hold scoped to one channel, versus a hold on the whole branch. Today one Local Services day makes every channel not ready (test line 153).
  - (f) An audited override, versus lifting only when the source re-sends.

**D-B2. The lift rule in §1.2 is false, and one lift path shows an uncounted day as $0.00.** Scope: lines 43-44, 254-258, 343-345 and 121.

- The code lifts a hold in four ways (`lib/reconcile/refused-revisions.ts:292-299`): `newer_accepted`, `accepted_itself`, `no_longer_counted` and `other`. Only `newer_accepted` names a delivery (line 305).
- `no_longer_counted` is reachable through the policy §3 keeps on purpose: a newer revision with no stated currency deletes the counted row (`lib/ingest/project.ts:270-279`). The refused revision then drops out of `v_refused_spend_revisions`, and rule 1a resolves the incident as "Corrected. Oct 20: the ledger no longer counts…".
- The incident page then shows **"Counted now, corrected dates: $0.00"**. The code is `money(corrections.reduce((t, c) => t + (c.correction.cents ?? 0), 0))` (`app/exceptions/[id]/page.tsx:288`).
- It also says "No amount changed", although $120.91 left the count. `components/incidents/RevisionHold.tsx:42,86-87` drops corrections whose amount is null.
- This contradicts "never $0" (lines 257, 344) and the §1.7 failure list (line 121). A mapping change also moves or drops the hold through `other`. Only `newer_accepted` is tested (test lines 216-248).
- **Recommendation:** restate the invariant with every lift path, and name the cause for each one. Treat `no_longer_counted` as a hand-off to the held-day rule: not "Corrected.", no $0.00, and say the counted amount left the total. Add tests for the other three paths.

**D-B3. A routine re-fetch of a refused day corrupts the incident's money and its correction record.** Scope: lines 50-62, 206-210, 287 and 349.

- The source re-fetches a trailing window of days. Each fetch has its own `fetchedAt`, so it becomes a new raw event (`lib/adapters/marketing.ts:350-358`). A day refused for a lasting reason therefore collects one new "newer" refused revision per fetch. The failure class only covers the byte-identical duplicate (test lines 187-204; `tests/acceptance/b09/deliveries.ts:91`). Consequences:
  - **Money is multiplied.** "Still counted, held dates" sums the counted amount once per refused revision, not once per campaign-day (`page.tsx:289`). After a correction, "Counted now" and the delta are summed the same way (`RevisionHold.tsx:42-43,88`). Two refusals of Oct 20 would read "+$558.18" for a change of +$279.09, and the resolution text repeats each clause.
  - **Counts are wrong.** The scope line counts revisions as campaign-days (`page.tsx:163-167`).
  - **False corrections are stored.** The evidence keeps the first 50 revisions, sorted by date then id (`lib/reconcile/reconcile.ts:98-108`). Rule 1a compares lists by raw event id (lines 351-353). When new revisions of an earlier date push a later date's entries past 50, those entries count as "gone". They are then classified as `other` and stored permanently as "Already corrected, and no longer holding it" (`RevisionHold.tsx:74-78`). Meanwhile the gate still holds that date through the uncapped `spendDates` (`reconcile.ts:60`; `refused-revisions.ts:136-140`).
  - **Other views degrade.** Decision Lab loses that period's revisions: `touches` becomes null and the basis becomes "unverified" (`lib/metrics/decision.ts:125-133`). The daily evidence loses its link to the hold (`lib/metrics/movement.ts:324-325`).
  - Two held days re-fetched daily reach the cap in about 25 days.
- **Recommendation:** keep the evidence and the corrections per campaign-day: the newest refusal plus a count of the others. Sum money per campaign-day. Replace the 50 cap with paging or a per-day aggregate, and compare lists on campaign-day identity. Add the re-fetch case to §1.3 and to the tests.

### Majors

**D-M1. Holds from systematic refusals never lift, and the document doesn't analyse this.** Scope: lines 43-44, 72, 287-288 and §7.

- Fractional conversions are normal under data-driven attribution (`marketing.ts:328-330`), and a non-USD account stays non-USD. Every re-fetch is refused again, so the lift the UI promises never comes. The UI says "Nothing on this page lifts it" (`RevisionHold.tsx:95-96`). The real way out (a mapper upgrade plus a replay) is neither planned nor assigned.
- **Blast radius:** one campaign-day fails every channel's readiness at the branch for the whole period (`lib/decision/verdicts.ts:439-447`). Nothing checks whether the amount matters.
- **Clock:** `fetchedAt` is bounded only to 1970-2100 (`lib/ingest/ingest.ts:162-176`). One future-dated refused record outranks every later correction.
- **Growth:** refused records pile up with each fetch. Every reconcile re-evaluates both views over all of them, under the global lock. User actions take that lock too (`reconcile.ts:33-42`; `lib/actions.ts:106`).
- **Recommendation:** add a section on systematic refusals, with an owner and a way out. Add a rule for when an amount difference matters, and bound `fetchedAt` against `received_at`. Plan how refused records are retained or aggregated.

**D-M2. "Every view quotes the same facts" (lines 278-281) is not how the code works.** Scope: lines 278-281, 211-212, 105 and 126.

- The gate, Decision Lab and the incident read the snapshot written at the last reconcile, capped at 50. The daily evidence reads the view live (`movement.ts:320-328`). The incident reads its own evidence, not the gate's blocker (`page.tsx:124`); line 212 says otherwise.
- Reconcile runs as a separate asynchronous step that can be busy or fail (`lib/events/consumers.ts:23-24,36-42`). After a refused delivery, the daily evidence can show "Refused, not counted" while Decision Lab still reads ready. Past the 50 cap the views disagree permanently.
- **Recommendation:** state the consistency model: when the snapshot is taken, how far it can lag, and how "pending" is shown (line 105). Make the daily evidence read the same snapshot, or say when it is ahead. Test the lag window.

**D-M3. "B09's total October spend stayed $16,649.23" is never actually checked.** Scope: lines 89, 296, 388-389 and 412.

- The "unchanged" tile and the "stayed $X" sentence (`components/incidents/GapRecovery.tsx:285-286,307-311`) print the branch's current period total (`page.tsx:129-131`). They appear whenever `reclassified` is true, and `reclassified` only covers the gap channel's dates in the decision window (`lib/reconcile/gap-status.ts:179`).
- No "before" total is stored. A restatement on another B09 campaign or channel in October changes the total, yet the tile still says "unchanged".
- **Recommendation:** store the total at detection and compare against it, or reword to "added nothing; the total is now $X".

**D-M4. The document gives two different rules for which branch a hold lands on.** Scope: lines 46-48, 188-190, 201-203 and 61.

- The invariant takes the branch from the campaign's mapping. The view lets the payload win: `coalesce(payload_branch(re.payload), case when v.standing = 'newer' then v.branch_id end)` (`database/migrations/0034_refused_spend_revisions.sql:61`).
- `payload_branch` reads `branchId`, `branch_tag` and `officeID` (`database/migrations/0001_init.sql:30-37`). The spend schema doesn't reject extra keys.
- So a refused revision of a B09 campaign that carries `branchId: "B10"` holds B10 and leaves B09 free. That is the line 122 failure. Only the display-name variant is tested (test lines 176-185).
- **Recommendation:** use the campaign's mapping for spend records and ignore branch keys in the payload, and add a test for it.

**D-M5. The N1 findings (how held days behave) are out of date against the current code.** Scope: lines 164-180, 325-334, 343-345 and 255.

- The document says Decision Lab readiness doesn't see a held day, and that held days "limit the decision but do not hold it".
- In the current code, a held day gets a reason that holds (`holds: true`, `lib/metrics/eligibility.ts:234-247`). That reason becomes a `cost_held` failure (`verdicts.ts:452-458`) and joins `heldBy` (`decision.ts:216-223`). This looks like it changed in commit 350fb45 ("A held channel can no longer read ready").
- The product text still says "a limitation, not a hold" (`refused-revisions.ts:265`; migration 0034, lines 18-19). So the company-level incident and Decision Lab now contradict each other.
- **Recommendation:** re-measure N1 on the current build. Update §2, §6, §7 and that product text. Record who made the policy decision the document still leaves to Moxie.

**D-M6. The verification claims go beyond what was actually run.** Scope: lines 192-196, 225-232, 77 and 490.

- **Scenario 5:** it says "a campaign the ledger maps to no branch". The test (lines 257-258) and the acceptance step (`deliveries.ts:97`) both send an id the ledger has never seen. A campaign that has spend records but no branch mapping is the one ambiguous case that enters the view as "newer". It gives a company-level incident `spendDates` and revisions (`reconcile.ts:58-64,96-108`), and it is untested.
- **Lift paths:** `accepted_itself`, `no_longer_counted` and `other` are untested.
- **Volume:** nothing tests several refusals of the same day, or more than 50 revisions.
- **"PROPERTY TEST":** it is 11 example tests; nothing generates inputs.
- **Accessibility:** the axe/WCAG browser gate ran on build `BlhUwlGz…`. That build differs from the final one in the verdict-block layout, which is exactly what the accessibility claims cover.
- **Recommendation:** add the missing cases or narrow the claims, and re-run axe on the final build.

**D-M7. The risks section gives no mitigations and omits several risks.** Scope: lines 336-355.

- §7 lists open edges but gives no mitigation, owner or trigger for any of them.
- It leaves out: systematic refusals that never lift; growth from re-fetches; reconcile lag; clock skew; which branch a hold lands on; raw error text shown to readers; correction history lost when an incident reopens.
- Policy questions are handed to "Moxie" (lines 179-180, 334, 344-345) with no tracked issue.
- **Recommendation:** add a risk table: likelihood, impact, mitigation, owner and link.

### Nits

- **D-N1. Complexity bullet names the wrong index** (lines 239-243). The view scans `raw_events_quarantined_idx` and joins the counted record by primary key (migration 0034, line 45). `raw_events_entity_idx` is used by `lib/reconcile/gap-coverage.ts:168`. The campaign key is (platform, external_campaign_id), not (platform, id). Also say that this cost is paid on every reconcile.
- **D-N2. Scenario 6's guard is justified wrongly** (lines 265-268). The guard `re.projected_at <= re.received_at + interval '1 second'` (`gap-coverage.ts:170`) is explained as covering records "re-mapped in place". It also skips a refused record that a replay later accepted, and a record re-projected under a new currency rule. In both cases the amount can change. A change of exactly zero net across several such days slips through, which is the case scenario 6 exists for. Base the check on raw-event identity, not timing.
- **D-N3. Measurements and build ids (§4 vs §9).** §4's pixel positions were measured on build `nQcx…`, before the §9 redraw. The document cites six build ids. Add a table saying which build each claim was checked on, and mark §4's numbers as superseded.
- **D-N4. Unexplained failure** (line 320). The "1 expected failure" is not named or explained.
- **D-N5. Correction history is lost on reopen.** If a resolved refused-revision incident is detected again, the upsert replaces its evidence and clears its resolution (`reconcile.ts:397-403`). Rule 1a only reads open incidents (line 346), so the earlier corrections disappear. Coverage gaps keep their earlier verifications (lines 321-329); say which behaviour you want for these incidents.
- **D-N6. Raw error text reaches readers.** `refusalReason` falls back to the raw `error_detail` (`refused-revisions.ts:153-160`). For `MAPPER_ERROR` that is a thrown error message (`ingest.ts:194-199`), shown in text marketing viewers read. Map each code to plain words.
- **D-N7. §9 claims about the date strip** (lines 384, 410, 443-447). The strip is not continuous on phones: it wraps into two rows of 9 (`components/incidents/DecisionWindow.tsx:108`). The marks show a glyph, not a word (line 136). Selection follows focus and the day panel is a live region (lines 122, 166), so every arrow press is read out twice; check this with a screen reader. Separately, the document leans on undefined shorthand (R-54, N1, F2, F8, rule 1a/6a, "book §10"); add a glossary.

**Claims the code bears out:** identity is platform, campaign id and date, ordered by the source's clock (migration 0034, lines 39-45). The period boundaries hold on the first and last date. The shared-ad-account control works. Integrity reads "not confirmed" rather than "known to be wrong". The status block is honest that the work is not promoted.

## egm-structural

**Verdict: the document fails the standard.** 1 Blocker, 7 Major, 8 Nit. The review is complete: the reviewer read the persona, the standard, the whole target, and the baseline files it needed to check the target's references.

**Structure map**

- H1 (line 1), then a status block (lines 10-17).
- §1 (line 19) has numbered H3s 1.1-1.7.
- §2 (line 128) has one unnumbered H3 (line 158).
- §3 (line 182) uses bold labels instead of subheadings, plus one unnumbered H3 (line 260).
- §4 to §8 (lines 276-375) have no subsections.
- §9 (line 377) has numbered H3s 9.1-9.5.
- None of the standard's five named areas (Problem Statement, Goals & Non-Goals, Proposed Architecture, Alternatives Considered, Risks & Mitigations) is a heading.

**What passes**

- Heading levels never skip, and there are no H4s.
- All 13 tables have consistent column counts.
- Bullets are all "-" with consistent 2-space nesting.
- There are no code fences, and every inline code span is closed.
- Every internal § reference resolves.
- Every path in the §3 and §9.1 file lists exists.
- "11 tests" matches the test file.
- Design-system behaviour rules 9-12 exist as cited.

### S1. 🔴 Blocker: there is no Alternatives Considered section for the core design

Scope: §3 (lines 182-258) and the whole document.

- §3 proposes one path: two SQL views, grouping into the existing quarantine incident, and period filtering in the budget gate. No other design is shown as considered and rejected. The standard says such a spec "fails this standard."
- "No new incident kind" (lines 206-207) is stated without the option it rules out.
- "Not changed, on purpose" (lines 254-258) and §7 list behaviours that were kept, not compared options.
- §9's kept/rejected list (lines 392-402) covers only visual style. Its rejections (fonts, pink accent, hero layout) give no trade-off beyond "(Geist stays)".
- The document even shows a fork it never weighs. A newer revision with no stated currency removes the older row, while every other refusal keeps the row and holds (lines 256-258, 343-344).
- Options a fresh reader would expect weighed: stamping the branch at intake vs. a view read at query time; a new incident kind vs. the existing quarantine incident; a SQL view vs. a rule in application code; keeping the old amount and holding vs. withdrawing it.

### S2. 🟡 Major: the Risks & Limits requirement is not met

Scope: §7 (lines 336-355) and §3 COMPLEXITY (lines 239-243).

- §7's eight limits are prose bullets with no mitigation, owner or severity. Most end in "Not touched" (339), a disclosure (342, 347, 353) or a deferral (345).
- Security implications are never named as such. Yet the change decides which branch a quarantined record belongs to, and so which branch-scoped viewers can see it (lines 77, 107, 287, 346-348).
- The only scope evidence ("62 paired denials, 0 leaks") sits in a verification cell (line 321).
- The AI investigator's tool also reads the view (line 216), and nothing says what that exposes.
- Scalability is split between §3 COMPLEXITY (no volume bound) and the 50-per-group cap (line 349). Neither is stated as a limit.

### S3. 🟡 Major: the standard's named areas have no headings, and the order is inverted

Scope: lines 3-5, §1, §2, §3, lines 254-258, §7, §9.5.

- There is no Problem Statement. It has to be assembled from lines 3-5, 155-156 and the "BUG:" label (184-186).
- The goals (§1) come before the problem (§2).
- Non-goals are spread over at least four places: lines 33-34, 254-258, §7 and §9.5.
- The architecture exists only under bold labels inside §3, so it is invisible in the outline.

### S4. 🟡 Major: one file holds two features and three kinds of document

Scope: lines 10-17, §5, §8, §9 (lines 377-504).

- The file holds a frozen pre-implementation spec (§1, per lines 21-22), a post-implementation report (§2-§8), and a separately committed redesign (§9, `6ed9066`).
- §9 has no problem statement, alternatives or risks of its own.
- Verification appears three times (status block, §5, §9.4), and run instructions twice (§8 and lines 473-479).
- Five commits and six build IDs appear with no map from commit to build to evidence. The build that §4's captures came from (`nQcxhPYqwZXfT91nSHH7Y`, line 290) is tied to no commit.
- §9.5 carries undated "Since done" edits (lines 497, 499) and there is no revision history.
- The standard expects one feature spec, written before implementation.

### S5. 🟡 Major: the expected outcomes are not traced to results, and Scenario 7 is never reported

Scope: lines 79, 103-109, 119-126, 321.

- Lines 21-22 promise that later sections report against §1, but there is no matrix from §1's rows to results.
- Scenario 7 appears only at line 79. The fixture has a `regression` step for it (advance.ts lines 14-16; GUIDE.md lines 79-80), but line 321 leaves it out and no result is stated anywhere.
- Two required items, pending/empty/stale/unavailable evidence and the loading state (lines 105-106), never reappear.
- The focus-return requirement (line 108) is reported only as "focus stays on their summary" (lines 300-301).

### S6. 🟡 Major: N1 is covered in five places, and the copies disagree

Scope: lines 111-117, 158-180, 255, 325-334, 343-345.

- §6 says outright that it restates §2 (line 334).
- §1.6 sets out five checks, and the §2 table marks three as "Yes".
- Line 174 says "Two readiness checks" without naming them.
- §6 accounts for only four of the five checks and drops the metric trace (lines 328-330).

### S7. 🟡 Major: many references and identifiers cannot be resolved

Scope: lines 15, 54, 113, 136, 175, 288, 354-374, 393-401, 436, 478, 492.

- There are no Markdown links anywhere in the document.
- Paths use four different roots: the repo root (196, 478); `docs/agent-work/` (359); `hold-to-decision/` (144, 290, 436); bare file names with no location (15, 54, 257, 497). `REVIEWER-TASK.md` appears bare at line 354 and with a prefix at line 363.
- Three paths exist only on one machine (`C:/Temp/...`, lines 136, 374, 492). Capture names are globs with no directory (lines 366-372).
- The Google Ads Help IDs (lines 361-362) have no URLs, although GUIDE.md and WALKTHROUGH.md give the full links.
- Some identifiers have no definition or source:
  - "book" (line 113). Migration 0034 cites N1 as "book §9.6.6", while the target says "chapter 16 §10".
  - R-54. The target cites `BIVE-ACCEPTANCE.md` §5 (line 54), but the migration and the test file cite `REMAINING-RISKS.md`, which the target never mentions.
  - R-56 (line 288) and "definition v3" (line 175).

### S8. 🟡 Major: a set-aside option is attributed to a stakeholder with no link

Scope: lines 175, 179-180, 255, 344-345.

- The option that a held day should hold the decision is set aside as "a policy decision for Moxie" and "Moxie's call".
- It rests on a rule "chosen earlier (definition v3)".
- The Alternatives Rule requires a linked issue, discussion or PR for this, and none is given.

### S9. 🟢 Nit: heading numbering and nesting are inconsistent

Scope: lines 158, 260.

- These two H3s are unnumbered, so they cannot be cited by §.
- Line 158 puts N1 under the refused-revision section, although line 173 says N1 "is not the R-54 path".
- Scenario 6 is the only scenario with its own subsection.

### S10. 🟢 Nit: bold pseudo-headings use mixed casing

Scope: lines 184-254, plus lines 130, 135, 306, 383, 416, 473.

- §3 has ten ALL-CAPS labels, then a sentence-case "**Not changed, on purpose:**" (line 254). The other sections use sentence case.
- None of these labels appear in the outline or can be linked to.

### S11. 🟢 Nit: the "three states" label sits on a four-row table

Scope: line 290 vs. lines 292-299. Line 290 says "three states", but the table has four rows, and line 299 says "In all four states".

### S12. 🟢 Nit: the two verification tables do not match

Scope: lines 316-323 vs. 485-492.

- §5 has a "Where" column that §9.4 drops.
- §5's "Where" column mixes commands, paths and a bare commit hash (line 323).
- The cells at lines 321 and 490 are whole paragraphs.

### S13. 🟢 Nit: one line breaks the wrap width

Scope: line 257. At about 128 characters it exceeds the roughly 100-character wrap used everywhere else, which suggests a later insert.

### S14. 🟢 Nit: "rule" means two different things

Scope: lines 206, 209, 488. "Rule 1" and "Rule 1a" are reconciliation rules; the unqualified "rule 11" (line 488) is a design-system behaviour rule.

### S15. 🟢 Nit: the PROPERTY TEST list does not match the tests one to one

Scope: lines 225-232. There are 7 bullets for 9 test cases (11 tests in all). The first/last-date case and the accepted-revision-in-between case are missing from the list, though lines 193-196 claim them and both are in the test file.

### S16. 🟢 Nit: §3's file and reader lists are incomplete

Scope: lines 214-217, 245-252.

- FILES lists no UI file, although §4 changes four screens. `RevisionHold.tsx` and the incident page appear only in §9.1, marked as changed since `718e4aa`.
- SHARED PRIMITIVE leaves out `unattributedSpend`. It queries `v_refused_spend_revisions` directly and feeds the incident page (page.tsx line 126).

## egm-style

**Verdict: needs revision.** 0 Blockers, 9 Major, 11 Nit. The reviewer read the whole target and checked the supplied context wherever the target makes a claim that can be verified; every required file could be read. No style standard was supplied, so there is no standard-compliance section. The tone is already dry, direct and evidence-led, with little hyperbole. The problems are calibration problems: several claims about tests, data flow, UI copy and verification go further than the cited code and records show.

Short names: test = `tests/integration/refused-revision.test.ts`; rr = `lib/reconcile/refused-revisions.ts`; reconcile = `lib/reconcile/reconcile.ts`; decision = `lib/metrics/decision.ts`; verdicts = `lib/decision/verdicts.ts`; page = `app/exceptions/[id]/page.tsx`; hold = `components/incidents/RevisionHold.tsx`; gap = `components/incidents/GapRecovery.tsx`; strip = `components/incidents/DecisionWindow.tsx`; days = `lib/reconcile/gap-days.ts`; coverage = `lib/reconcile/gap-coverage.ts`; mig = `database/migrations/0034_refused_spend_revisions.sql`; advance = `tests/acceptance/b09/advance.ts`; ds = `docs/design-system.md`; guide = `docs/agent-work/hold-to-decision/GUIDE.md`.

### Major

**T-M1. The test-coverage claims go further than the test file.** Lines 192-196 and 225-232 (pre-registered at 55 and 77).

- **"Every refusal code … All of these are in tests/…":** the test's `REFUSALS` map has three codes (test 52-57). §1.3 pre-registered "a schema failure" as a variant (line 55). §3 never says whether `AMBIGUOUS_CAMPAIGN_TYPE` stands in for it or whether the variant was dropped. "Every" depends on a test comment ("one per code") that the document does not cite.
- **"An unmapped … campaign" (195) and "an unmapped one, holds no branch" (231):** the tested case is "An id the ledger has never counted" (test 257). The code's own taxonomy calls that case `unknownCampaign`. It keeps `unmapped` for a campaign the ledger counts but maps to no branch, and gives that case a different sentence (rr 210-215, 258-259). No supplied test covers a campaign that is counted but unmapped. §7 (346) repeats the label.
- **"PROPERTY TEST"** labels 11 hand-written example cases. §5 (319) calls the same tests "Rule tests".
- **Fix:** write "three refusal codes (FRACTIONAL_CONVERSIONS, CURRENCY_UNSUPPORTED, AMBIGUOUS_CAMPAIGN_TYPE)"; report the schema-failure variant as covered or as not run; rename the unmapped case "a campaign id the ledger has never counted", or add a test for the counted-but-unmapped case.

**T-M2. The pre-registered outcomes are not reported one by one.** Lines 21-22, 79, 105-106, 314-323.

- §1 promises "Later sections report what happened against it", but no later table follows §1.4's scenario numbers.
- Scenario 7 (line 79: a verified date becomes unsupported) has no result anywhere. §5's list of runner steps leaves it out, and the rule tests do not cover it. A `regression` step exists (advance 14-16; guide 79-80), but the document never says whether it ran.
- Two §1.5 requirements never come up again: "pending, empty, stale and unavailable evidence are said as such" (105); the loading-state rule (106).
- **Fix:** add one results row for each §1.4 scenario and each §1.5/§1.7 item: pass, fail or not run, with its evidence.

**T-M3. The invariant is stated without the exception the document itself records, and the N1 conclusion is vague.** Lines 173-180, 188-190, 254-258, 327-334 (against 38-44).

- **The exception is missing where the invariant is stated:** §1.2's scope, "a campaign mapped to that branch, a date in that period" (39), includes a held day. §2's table (166-167) shows that a held day leaves the gate "trustworthy" and Decision Lab "ready", even though the newest revision is not counted. §3's ROOT INVARIANT (188-190) restates the rule without that exception. The exception only appears under "Not changed, on purpose" and in §7.
- **"Partly true" is never explained:** "N1 is partly true" (173, 327) never says which part is false. On §2's own table, no check blocks the decision for a held day, so "held spend never blocks a budget decision" reads as true.
- **The counts disagree:** the §2 table shows three checks that see the held day: verified readiness, the scorecard and the metric trace. The §2 prose (174-175) says "Two readiness checks". §6 (328-329) names verified readiness and the scorecard and leaves out the trace. The scorecard's measured output is a count (`partlyHeldAcquired: 18`), not a limitation.
- **Fix:** add to §3: "Exception: a campaign-day with no counted revision is a limitation, not a hold (§7)"; replace "partly true" with the measured statement; make §2 and §6 list the same checks.

**T-M4. The single-source claims do not match the code.** Lines 211-212, 215-217, 278-281.

- **"Decision Lab, the Overview and the incident read them from it":** only Decision Lab reads the blocker's revisions (verdicts 293-301, 439-446). The Overview reads `decisionHolds`. It applies the same period rule but returns only the summary and a yes/no flag, not the revisions (decision 268-310). The incident page reads its own stored evidence, `revisionsOf(ev)` (page 124), with no period filter. So the incident and Decision Lab can list different revisions for the same hold.
- **"The one place their evidence is parsed and phrased" (217):** the hold is also worded in four other places: the SQL summary in reconcile 81-90, which is the sentence the Overview and the incident's "What was detected" show; verdicts 423-427; decision 189 and verdicts 299; hold 72 and 96.
- **The list of view readers (215-216)** leaves out `unattributedSpend` (rr 225-251), which the incident page calls (page 126).
- **"None computes the verdict itself" (278-281):** the refused-revision headline is computed in the component from `exception.status` and the stored evidence (hold 40-50). That source is not one of the three listed.
- **Fix:** name the source for each surface and drop "the one place".

**T-M5. "Every sentence is the one §4 lists" is false.** Lines 380-381.

- The redraw adds copy that §4 does not list: the date-by-date "Received / Why / What clears it" sentences from the new gap-days.ts (days 66-84); "Selected week covered", "Decision window incomplete" and "Every date is verified. Select one…" (strip 150, 158, 169); the tile labels "Correction in progress", "Verified, with changed amounts" and "Nothing moved yet", and the cleared-hold note (gap 301, 336); the scope line (page 160-168).
- "From the same functions" is also wrong: §9.1 (417) lists gap-days.ts as new.
- This matters because the sentence tells a reviewer that the copy needs no fresh review.
- **Fix:** "The verdict sentences are §4's; the strip adds the date-by-date sentences and labels listed in §9.1."

**T-M6. The verification evidence cannot be traced to the candidate.** Lines 11-17, 290, 316-323, 483-492.

- **Builds without a commit:** the document names six build IDs and five commits. Two builds have no commit: `nQcxhPYqwZXfT91nSHH7Y`, which produced every §4 measurement and §5's "States at four widths", and `BlhUwlGz4Gr681fx7XKCe`, which ran the 67 browser specs. The candidate's own build, `ks0842o0526Xv-eQimWYE`, is cited in no §5 row. The browser-spec row cites `9b052dc`, with no stated link to `718e4aa`.
- **An unsupported equivalence claim:** "differs from `BlhUwlGz…` only in…" (490) is the reason the 67-spec run is allowed to count for the final build. It cites no commit range.
- **Regenerated baselines reported as passes:** "updated on purpose, then passed 2 of 2" (323) and "Re-generated … then checked against: 8 of 8" (491). A baseline compared with itself only shows that rendering repeats. The status block's "Passed: … the affected browser specs" (12-13) hides this.
- **Missing "Not run" line for 6ed9066:** only unit tests and two integration suites ran there, not full vitest (488-489). The status block has a "Not run" line for 718e4aa only.
- **Fix:** map each build to its commit; cite the commit range behind "differs only in"; report the baselines as "regenerated, reviewed by <who>"; add a "Not run" line for 6ed9066.

**T-M7. The FILES list is partial.** Lines 245-252.

- It leaves out files that §3 and §4 describe as changed: gap-coverage.ts (the Scenario 6 change, 265-268, whose `amountChanges` comment cites "scenario 6", coverage 62-67); RevisionHold.tsx (the §4 incident row; §9.1, 419, lists it under "changed", so it already existed at 718e4aa); app/exceptions/[id]/page.tsx (page 120-126); the pages behind §4's Overview, daily evidence and Decision Lab rows; the tests, including the new steps in advance.ts (14-16).
- §9.1's "Files" block has the same shape and is complete, so a reader will take §3's list as complete and scope a code review to it.
- **Fix:** retitle it "Rule files", or list the whole change.

**T-M8. F2 gives the reader nothing to act on.** Lines 338-339 (affects 296).

- "Successor", "the stop" and "overlap days" appear nowhere else in the document, and the caveat names no decision for the reader.
- It undermines the main verified result shown in §4 (296): "reclassified, not added". The window starts at the gap start, so a successor's earlier days are never read (coverage 141-150, 173). The document never says whether B09's successor started before the stop, so the reader cannot tell whether B09's own result is affected.
- **Fix:** define the terms, say whether the B09 fixture is affected, and put a one-line condition beside the Verified row.

**T-M9. The phone first-screen measurements contradict each other.** Lines 294-297 vs 501.

- §4 puts the verdict headline at 377 px on a 390 px phone. §9.5 says the top bar and menu "take about 445 px before the breadcrumb".
- The verdict renders after the PageHeader, which holds the breadcrumb (page 199-236). So both numbers cannot hold in the same frame, and the first-screen claim depends on which one is right.
- **Fix:** give the reference point (viewport top or page top) and the build for each number.

### Nit

- **T-N1. Opening framing and filler** (3-5, 257, 336, 357, 392). "One workflow, finished" clashes with "candidate, not promoted", with §7 and with §9.5; write "implemented and verified locally". "the exact records" is an intensifier; drop "exact". "the source corrects itself": the source sends a corrected revision. "journey" is UX jargon. The headings "Open edges, stated" and "Run it, show it" carry filler words. "Patterns came in and dependencies did not" reads as a slogan. Line 257 runs to about 130 characters; the rest wraps near 100.
- **T-N2. §2's summary contradicts its own table** (151, 155-156, 188). "Every view told a reader the decision was free", but the #5540 row says "On hold while open". "Newest word" should be "newest revision". The key term drifts: "not held" (§1.2), "free" (§2) and "free of incomplete evidence" (§3). Pick one.
- **T-N3. The BUG line names intended behaviour as the bug** (184-186). "Leaves the older amount counted" is what §1.2 requires (line 41). The defect was that the incident had no branch.
- **T-N4. The view descriptions overstate their scope** (199-203, 206, 216). "Each refused ad spend record": mig 18-19 says held days and unidentifiable records are left out. "Records that still hold something": the view also includes same-instant records, which F8 (341-342) says hold nothing; only `superseded` is excluded (mig 65). "The branch's existing quarantine incident" reads as an incident that is already open. "The two views, one SQL definition" contradicts itself.
- **T-N5. COMPLEXITY and CONTROL TEST present reasoning as results** (234-243). No query plan or timing is cited. The counted revision joins on its primary key (mig 45), so it is not evident that `raw_events_entity_idx` is used. The campaign key is (platform, external_campaign_id), not "(platform, id)" (mig 43). Rule 1a also reads acknowledged incidents, not only open ones (reconcile 346). "117 tests passing" has no log reference. "Cannot move" is an argument, and its premise is not shown.
- **T-N6. Redundancy.** §6 restates §2. §7 at 343-345 and 350-351 repeats lines 254-258 and 273-274. 306-312 repeats the state table. "876 px" is stated twice (431, 451). "identical, word for word" (227) says the same thing twice; so does "failed as intended … updated on purpose" (323). "On purpose" appears four times.
- **T-N7. The state and width counts do not line up** (290, 299, 322, 365). "Three states" heads a four-row table. The next paragraph says "In all four states", and §8 says "Three state captures". "Four widths" counts 200% zoom as a width.
- **T-N8. Undefined references and unnamed actors** (7, 113, 175, 288, 321, 338-341, 361-362, 394, 400-401, 425-426, 502). Undefined: "recorded by 91f253b", "book, chapter 16 §10", "definition v3", "R-56", the source of the F-numbers, "31 proving", "62 paired denials", "green run", "Swiss", "Knock for one event" (ds 6-7 explains it) and "slice". "Checked against" Google Ads Help: guide only cites the pages; say who checked, and when. "Were reviewed … found and fixed" (425-426): name who reviewed.
- **T-N9. §9's accessibility claims** (410, 432, 440-441, 490, 503-504). "Each mark has its word" and "the cross and the word carry the state": the strip shows only a glyph and the day number (strip 129-139); the contrast argument holds on the cross alone. Two widths for a date: 25 px at 320 px (432) vs "33 × 70 px on a phone" (503); name the 390 px width for the second. The 44 px target is not attributed; it comes from WCAG 2.5.5 (AAA). "Zero axe violations, WCAG 2.2 AA" reads as a conformance claim; axe runs automated rules only.
- **T-N10. Mixed time frames** (286, 352-353, 496-500). The "Not done" list includes undated "Since done" notes, all under a 2026-11-16 heading. §4 says the trace card "now says" how it filters; §7 says it "was not changed". Write: its label changed, its filter did not.
- **T-N11. Small precision gaps** (21-22, 267-268, 294-295, 307-308, 320, 349). Cite the commit that recorded §1, so "not edited afterwards" can be checked. "Day by day": the tile shows at most three days (gap 272-275). Say that daily evidence uses Monday-start weeks, which explains "Oct 12-Oct 18" next to a window that starts Oct 13. Write out "(940 + 1 at d431e9b)" and name the expected failure. The 50-revision cap needs its consequence stated: blocker revisions come from the capped list (rr 143-146), so a later period can stay held while Decision Lab falls back to the summary (verdicts 444) and shows no refused-revision reason for that channel.
