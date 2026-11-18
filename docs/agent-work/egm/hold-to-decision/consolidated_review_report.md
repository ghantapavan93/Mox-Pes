# EGM review of HOLD-TO-DECISION.md: consolidated report

> **Status, 2026-11-18 (later):** K1, K2, K4, K5 and K6 are reproduced and fixed in the working tree, uncommitted; K3 and the decimal migration are deferred together; K7–K10 are not done. Evidence and wording changes: `HOLD-TO-DECISION.md` §10. This report is otherwise as the review left it.

- **Target:** `docs/agent-work/HOLD-TO-DECISION.md` (504 lines), the record of the refused-revision hold and the B09 decision view.
- **Date:** 2026-11-18.
- **Mode:** consolidated report (EGM preset 1), no checkpoints between stages.
- **Stages run:** 5, 6, 7 and 8. Stage 9, implementation readiness, did not run: the record has no implementation-plan section, so it has no detailed range to review.
- **Elephant:** the main session, which wrote the record. It read the reviewers' code claims against the code; the last section says which it checked.

| Stage | Reviewers | Blocker | Major | Nit | Report |
|---|---|---|---|---|---|
| 5. Initial zoom-out | `egm-zoom-out`, `egm-inventive-catalyst` | 0 | 4 + 6 | 5 + 2 | [zoom_out_report.md](zoom_out_report.md) |
| 6. Comprehension | `egm-comprehension` (the record alone) | 0 | 7 | 7 | [comprehension_report.md](comprehension_report.md) |
| 7. Critic | `egm-design`, `egm-structural`, `egm-style` | 3 + 1 + 0 | 7 + 7 + 9 | 7 + 8 + 11 | [critic_report.md](critic_report.md) |
| 8. Intermediate zoom-out | `egm-zoom-out` | 0 | 5 | 3 | [intermediate_zoom_out_report.md](intermediate_zoom_out_report.md) |

**Code read during the review.** Reviewers read the working tree. Another session was committing to the same branch, and HEAD moved from `1814616` to `c445311` while the review ran. Line numbers are as the reviewers saw them. The files the AI-reader items cite (`lib/ai/*`, `lib/inquiry/cac-change.ts`) changed in those commits: re-read them before fixing.

## Verdict

**Revise before promotion.** The record's central claim survives every stage: a refused newer revision now holds the branch's decision for that period, and the views say so. Three findings change the picture:

- **Wrong money on screen in normal operation.** The incident keeps one entry per refused record, not per campaign-day. The ad source re-fetches recent days, so a day refused for a lasting reason gains a new refusal on every fetch, and the page adds the same counted dollars once per refusal (K1).
- **A lift that is not a correction is called one.** When the counted row disappears, the incident says "Corrected", "$0.00" and "No amount changed" (K2).
- **The record is out of date.** Commit `350fb45` (2026-11-17, after this record) made held days hold the decision through eligibility. The record's N1 sections still say they only limit it, and leave that policy to Moxie (R1).

## Fix in code before promotion

| # | | Problem | Fix | From | Elephant check |
|---|---|---|---|---|---|
| K1 | 🔴 | Evidence is kept per refused record, not per campaign-day. Re-fetches of a refused day multiply "Still counted", "Counted now" and the delta, miscount campaign-days, and push entries past the 50 cap. Rule 1a then stores false "Already corrected" entries, and Decision Lab loses that period's revisions. | One entry per campaign-day: its newest refusal against the counted revision. Rule 1a decides lifts from the view by campaign-day identity. Sum money once; the cap limits display only. Add a re-fetch test. | D-B3, F2, C4, Z8, T-N11 | **Verified.** `marketing.ts:350-358` keys each fetch as a version; `page.tsx:289` sums per revision; `reconcile.ts:98-108` caps at 50; `reconcile.ts:351-353` compares capped lists. The B09 fixture never re-fetches a refused day, so no test sees it. |
| K2 | 🟡 | A lift that is not a correction is narrated as one. A newer revision with no stated currency deletes the counted row, so rule 1a resolves the incident as "Corrected"; the page shows "Counted now, corrected dates: $0.00" and "No amount changed". The company-level text calls the day "a limitation, not a hold". | Treat `no_longer_counted` and `other` as a hand-off, never "Corrected", never $0.00, and say the counted amount left the total. Fix the "limitation" copy. Test the three untested lift paths. | D-B2, Z1, C1, F1 | **Verified** the narration: `refused-revisions.ts:292-299`, `reconcile.ts:351-362`, `project.ts:270-279`, `RevisionHold.tsx:42, 86-87`, `page.tsx:288`. **Not checked:** that eligibility keeps the decision held on this path (F1 says so, and `350fb45`'s title agrees). |
| K3 | 🟡 | A replay that accepts a refused revision skips the amount-change check, so "Reclassified, not added" and "stayed $X" can show after money changed. The check guesses a re-map from a one-second gap between receipt and projection. | Record the overwritten amount when a projection replaces a row. Ship it with any decimals mapper (K6). | C3, Z9, D-N2, F4 | **Verified.** `gap-coverage.ts:170`; `replay.ts:207-211` stamps `projected_at = now`. |
| K4 | 🟡 | Readers written for held lead records misdescribe spend holds now that those incidents carry a branch. The AI investigator says "Paid CAC at B09 is overstated … no paid touch". The CAC inquiry says "October spend missing". `getIngestionFailures` groups by payload branch and links the wrong incident. | One exported predicate for the refused-revision sub-kind (or a distinct kind), used by every `quarantined_source_records` reader. Put one ads quarantine in the control world. | Z2, C6, F3 | **Verified** in committed code: `deterministic.ts:593-640`, `cac-change.ts:284`, `tools.ts:512-523`. |
| K5 | 🟡 | A branch named in a spend payload wins over the campaign's mapping. A refused B09 revision that carries `branchId: "B10"` would hold B10 and leave B09 free: the §1.7 failure. | For ads spend, the branch is the campaign mapping and payload branch keys are ignored. Use one shared function for the view, the trace, the shadow snapshot and the investigator. Add a test. | D-M4, Z3, F3 | **Verified:** `0034:61`, `payload_branch` in `0001_init.sql:30-37`. **Not checked:** whether the spend schema rejects extra keys. |
| K6 | 🟡 | Refusals that recur never lift. Fractional conversions return on every fetch, and no shipped mapper accepts them. The replay rail also offers `ads@1.0`, which accepts an ambiguous campaign by misfiling it: the B09 bug. | Plan the numeric conversions column and `_v2` view the adapter already names (`marketing.ts:328-330`), with K3. Offer only mapper versions that fix the refusal's code. | D-M1, C2, F4, D-B1(b) | **Verified:** the rail lists `mapperVersions(source)` (`page.tsx:530`, `ReplayPanel.tsx:111-114`); v1.0 files by platform alone (`marketing.ts:316-322`). |
| K7 | 🟢 | "Unchanged" and "stayed $16,649.23" print the current total, not one compared with a stored before-total. | Reword: "added nothing; the total is now $X". | D-M3, F8 | Not checked. |
| K8 | 🟢 | The refused amount prints with "$" whatever its currency (the fixture's CAD refusal). | Carry the stated currency, or omit the amount when it is not USD. Do this before any amount comparison. | Z7, F7 | **Verified:** `0034:27-28`, `RevisionHold.tsx:147`, GUIDE step `refusedOther`. |
| K9 | 🟢 | Small code items: raw `MAPPER_ERROR` text shown to readers; correction history lost when a resolved incident is re-detected; copied helpers; the Card frame hand-copied in three components; the date strip may be announced twice (live region plus selection that follows focus). | Plain-word reasons in `refusalReason`; follow `previousVerifications`; share the helpers; use `Card`; check the strip with a screen reader. | D-N6, D-N5, Z6, D-N7, F8 | **Verified** the Card copies: `RevisionHold.tsx:113`, `GapRecovery.tsx:172`, `DecisionWindow.tsx:84`. The rest not checked. |
| K10 | 🟢 | The views read the last reconcile, and nothing says "pending" while it lags. | Out of this change: one sentence in the record (R3). If ever built, reuse `consumerBacklog`. | C5, D-M2, F6 | Not checked. |

## Fix in the record

| # | | Change | From |
|---|---|---|---|
| R1 | 🟡 | **Out of date since `350fb45`:** held days now hold through eligibility. Replace §2's N1 subsection and §6 with a pointer to `BUSINESS-FIT.md` §10. Fix §3 "Not changed, on purpose" and §7. | D-M5, F1, Comp-M3, T-M3, S6. Verified: `350fb45` comes after `6ed9066` and changes `lib/metrics/eligibility.ts`. |
| R2 | 🟡 | State the invariant as shipped: each lift path, and the cases that limit instead of hold. Give each form of "held" one meaning. | Comp-M1, Comp-M2, T-M3, T-N2, T-N3, D-B2, Z1 |
| R3 | 🟡 | One data-flow paragraph: which incidents become blockers and for which period, what each view reads, and that reconcile runs asynchronously. It replaces "every view quotes the same facts". Correct the FILES and SHARED PRIMITIVE lists. | Comp-M4, D-M2, T-M4, Z4, T-M7, S16, F5 |
| R4 | 🟡 | Define period, decision window and selected week; say weeks start on Monday. | Comp-M5, T-N11 |
| R5 | 🟡 | One result row per §1.4 scenario and §1.5/§1.7 item: pass, fail or not run. That includes scenario 7's `regression` step. | Comp-M7, S5, T-M2 |
| R6 | 🟡 | One provenance table: build, commit, evidence. Say the pixel baselines were regenerated, add a "Not run" line for `6ed9066`, and re-run axe on the final §9 build. | T-M6, S4, Comp-N4, D-N3, D-M6 |
| R7 | 🟡 | Narrow the test claims: three refusal codes, example tests rather than a property test, "an id the ledger never counted". List the untested lift paths and volumes. | T-M1, D-M6, S15 |
| R8 | 🟡 | A short note on the four choices that changed correctness: incident kind, unit of evidence, which mechanism holds, decimals versus refusal. | S1, D-B1, F5. Severity lowered from Blocker: this is a record of built work, not a spec awaiting approval. |
| R9 | 🟡 | Explain F2 and link the coverage-gap backstory (`B09-RECOVERY.md`). Put F2's condition beside the Verified row. | Comp-M6, T-M8 |
| R10 | 🟡 | Move §9 to its own record, with its fixes: the 377 px vs 445 px phone figures, "each mark has its word" (the word is in the accessible name and the legend, not on the mark), the source of the 44 px target, and the scope of an axe run. | Z5, S4, T-M5, T-M9, T-N9, D-N7, C8, Comp-N5, Comp-N6 |
| R11 | 🟢 | One line on the project and Moxie. Real paths and links for `RELEASE-CANDIDATE.md`, `BIVE-ACCEPTANCE.md`, `PREMIUM-POLISH.md`, `REMAINING-RISKS.md` and the Google pages. Define R-54, R-56, F2, F8, "the book" and "definition v3". | Comp-N1, Comp-N2, S7, S8, T-N8 |
| R12 | 🟢 | Give each open edge in §7 one status: accepted, fix planned, or decided (and where). | S2, D-M7, F5 |
| R13 | 🟢 | Structure and wording: unnumbered H3s, label casing, "three states" over four rows, line 257's width, "rule 11", filler and intensifiers, the BUG line, the view descriptions, COMPLEXITY's index and campaign key, the unnamed expected vitest failure, the §2 summary against the #5540 row, undated "Since done" notes. | S9-S14, T-N1, T-N4-T-N7, T-N10, D-N1, D-N4, Comp-N3, Comp-N7 |

## Decisions for you

- **How far a refused revision holds.** Today one refused Local Services day fails every channel's readiness at the branch. Held days already hold only their own channel (since `350fb45`). F1's end state: eligibility reads the refused-revision view per channel and period, which removes the gate's JSON special case, the capped list and reconcile lag for this condition. It changes §1.4 scenario 1, so record it if you take it.
- **Store decimal conversions** (K6): the way out of the main permanent hold. It is a schema change plus a reporting view.
- **A distinct incident kind, or one shared predicate** (K4).

## Requests set aside

These follow Stage 8's reasoning; the Elephant agrees.

- C1's new relation (it duplicates HELD_SPEND), C2's per-field acceptance and auto-replay, C4's child table, D-B3's paging, C6's structural test and versioned projections, and C7's intake fingerprint.
- D-B1(f)'s audited override and D-M1's retention plan: nothing measured asks for them.
- C5's "pending reconciliation" blocker: it changes the gate for every incident, outside this change.
- S3's restructure into the feature-spec template, owner and likelihood columns, and a separate glossary. The record stays a record.

## What the Elephant checked

- **Verified in code:** K1, K2's narration, K3, K4, K5, K6's replay rail, K8, K9's Card copies, R1's commit order.
- **Not checked:** K2's held decision under eligibility, K5's schema, K7, the rest of K9, and K10. Also N1 itself, re-measured on `c445311`.
- **Comprehension findings** were read against the record only; by design they test what a reader without context understands.

## Traceability

| Raw finding | Item |
|---|---|
| Z1 | K2, R2 |
| Z2 | K4 |
| Z3 | K5 |
| Z4 | R3 |
| Z5 | R10 |
| Z6 | K9 |
| Z7 | K8 |
| Z8 | K1 |
| Z9 | K3 |
| C1 | K2 (relation set aside) |
| C2 | K6 (per-field set aside) |
| C3 | K3 |
| C4 | K1 (child table set aside) |
| C5 | K10 |
| C6 | K4, K5 |
| C7 | set aside |
| C8 | R10 |
| Comp-M1, Comp-M2 | R2 |
| Comp-M3 | R1 |
| Comp-M4 | R3 |
| Comp-M5 | R4 |
| Comp-M6 | R9 |
| Comp-M7 | R5 |
| Comp-N1, Comp-N2 | R11 |
| Comp-N3, Comp-N7 | R13 |
| Comp-N4 | R6 |
| Comp-N5, Comp-N6 | R10 |
| S1 | R8 |
| S2 | R12 |
| S3 | set aside |
| S4 | R6, R10 |
| S5 | R5 |
| S6 | R1 |
| S7, S8 | R11 |
| S9-S14 | R13 |
| S15 | R7 |
| S16 | R3 |
| T-M1 | R7 |
| T-M2 | R5 |
| T-M3 | R1, R2 |
| T-M4 | R3 |
| T-M5, T-M9 | R10 |
| T-M6 | R6 |
| T-M7 | R3 |
| T-M8 | R9 |
| T-N1, T-N4-T-N7, T-N10 | R13 |
| T-N2, T-N3 | R2 |
| T-N8 | R11 |
| T-N9 | R10 |
| T-N11 | R4, K1 |
| D-B1 | R8; decisions |
| D-B2 | K2 |
| D-B3 | K1 |
| D-M1 | K6 |
| D-M2 | R3, K10 |
| D-M3 | K7 |
| D-M4 | K5 |
| D-M5 | R1 |
| D-M6 | R6, R7 |
| D-M7 | R12 |
| D-N1, D-N4 | R13 |
| D-N2 | K3 |
| D-N3 | R6 |
| D-N5, D-N6 | K9 |
| D-N7 | R10, K9 |
| F1 | R1, K2; decisions |
| F2 | K1 |
| F3 | K4, K5 |
| F4 | K6, K3 |
| F5 | R3-R12 |
| F6 | K10 |
| F7 | K8 |
| F8 | K7, K9 |
