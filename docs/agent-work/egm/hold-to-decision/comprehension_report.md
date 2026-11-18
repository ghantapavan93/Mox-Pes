# Stage 6: comprehension test

- **Target:** `docs/agent-work/HOLD-TO-DECISION.md`, lines 1-504 (FeatureRange; there is no DetailedRange), as of 2026-11-18.
- **Reviewer:** `egm-comprehension`, no standard. It read the document alone, with no code or other files: this stage tests whether the record stands on its own.
- **Result:** no Blockers, 7 Major, 7 Nit. The reviewer could paraphrase every section, but not two conclusions inside them without guessing: N1's "partly true" (Major 3) and F2 (Major 6).
- The paraphrase and findings below are the reviewer's own. The author compares the paraphrase with the intent: a wrong paraphrase is a finding.

## What this proposes

This is a record of a change that is a candidate and has not been promoted. The code is `718e4aa`, the data is synthetic and nothing was deployed; `d431e9b` stays the accepted checkpoint. Today, when the ad source sends a newer revision of a campaign-day's spend and intake refuses it, the older amount stays counted and nothing holds the decision; the change makes that case hold the branch's budget decision instead. Migration 0034 adds two SQL views that match each refused ad-spend record to the revision the ledger counts and give it the branch its campaign maps to; reconciliation rule 1 puts those records into that branch's quarantine incident, rule 1a records which delivery lifted each one, and the budget gate (`budgetSignal`) holds a period only when such a date falls inside it, so the Overview, daily evidence, the incident and Decision Lab all quote one blocker. It also shows "Reclassified, not added" only when every covered day kept its amount, and on purpose leaves two cases as limitations rather than holds, for Moxie to decide: held days, and newer revisions with no stated currency. §9 then redraws the B09 incident's first screen at `6ed9066` (one verdict, an 18-day strip, one action) without changing any logic.

## How the existing system works, per this document

Ad platforms deliver campaign-day spend into `raw_events` through a polling path. Intake accepts or refuses (quarantines) each record. The ledger `ad_spend_daily` counts the newest accepted version for each platform, campaign id and date, filed under a channel and given a branch by the campaign's mapping. Reconciliation rules open incidents: a quarantine incident for refused records, and a coverage-gap incident when a branch lacks a required channel's spend. That second kind is what happened at B09: it had no Local Services records for Oct 13-30 until the source re-filed $2,123.52 from Google Search. As far as the reviewer can tell, an open incident that carries a branch becomes a budget-gate blocker, which Decision Lab shows as a hold. Before the change, a refused newer revision's incident had no branch, so every view said B09's decision was free while the incident claimed a hold. Separately, a "held day" (one with no accepted version at all) is not seen by the budget gate or Decision Lab readiness; verified readiness and the scorecard flag it only as a limitation.

## Findings

### 🟡 Major 1. "Held" means two things, and §3 uses it for the case §2 says is not held

Lines 113-115, 168, 174-177, 201, 207, 209, 211, 255, 286, 343, 352.

- §1.6 and §2 define a "held day" as one with no accepted version. Line 177 says a day with a refused newer revision "is not held."
- §3 then calls that same day a "held campaign-day" (lines 207, 209) and a "held date" (line 211). Read with the document's own definition, line 211 ("The budget gate holds a period only if a held date falls inside it") says N1 held days now hold the decision. That is the opposite of line 255.
- "Hold" is also used for decisions, incidents ("Incident #N holds it"), records (line 201, "records that still hold something") and intake ("held at intake", the held-records card).
- "Refused", "quarantined" and "held at intake" seem to name one intake outcome, but the document never says so.

### 🟡 Major 2. The invariant as written covers cases the change leaves unheld on purpose, and nothing beside it says so

Lines 38-44, 188-190, 254-258, 343-345 (also 55, 192).

- Lines 38-40 say a decision may read as not held only when every campaign-day it reads counts the newest revision the source sent.
  - A held day fails that test: its newest revision was refused and nothing is counted.
  - Yet it reads as ready, at most with limitations (lines 166-168, 255).
- Lines 40-41 say the ledger "keeps the last accepted amount." Line 256 says a newer revision with no stated currency "still removes the older row."
- "Another currency" (which holds, lines 55 and 192) and "no stated currency" (no row and no hold) are easy to mix up.

Someone reading §1.2 or the ROOT INVARIANT alone would conclude both cases hold the decision. §1 is frozen, so §3 should say the invariant ships in a narrower form and name these two exceptions.

### 🟡 Major 3. "N1 is partly true" never says which part is false

Lines 173-177, 327-332.

- The conclusion appears twice, and §6 is there only to restate it.
- Every bullet under it fits "held spend never blocks": held days only limit the decision, and the gate and Decision Lab readiness ignore them.
- The only case that now blocks is the refused newer revision. The same sentence puts that case outside N1 ("it is not R-54's path"). If it is outside, N1 looks fully true; if it is inside, N1 is now false by design.

A reader can't say what part of N1 failed. If READY_WITH_LIMITATIONS counts as a partial block, the document should say so. The reviewer could not paraphrase this conclusion.

### 🟡 Major 4. The readiness checks, and the path from an incident to a verdict, are never defined

Lines 30, 116, 148-153, 164-171, 185-186, 211-212, 280, 288.

- The document names five checks: the budget gate; Decision Lab readiness; verified readiness, with its `complete` rule, READY_WITH_LIMITATIONS and NEEDS_REVIEW; the scorecard; the metric trace.
- Decision Lab also has "integrity" and "Other checks need review."
- It never says what each one checks, which one produces "Ready for review," or how they connect.
- The rule the whole fix depends on is only implied, by lines 185-186 and 211-212: an open incident with a branch becomes a gate blocker for the periods it touches.
- Line 168 gives B09 a NEEDS_REVIEW "from #970," but line 149 lists #970 as B44's hold. That sits oddly with scenario 2a's "word for word" isolation between branches (line 73).
- Without these definitions the N1 table (lines 164-171) can't be read.

### 🟡 Major 5. Period, decision window and selected week are never defined or related

Lines 38-39, 87-88, 95, 211, 294-297, 307-308, 408-410.

- The invariant and the gate work on "a period": B09's October, given as "Oct 1-30, 2026 (UTC)" with no reason for stopping before Oct 31.
- The interface says the decision has an 18-day "decision window," Oct 13-30.
- A reader can't tell what a refused revision on Oct 5 does. By the invariant it holds B09's October decision, yet it falls outside the decision window.
- Weeks appear to run Monday to Sunday, so the action for "the first missing dates" (line 87) opens Oct 12-18, a day before the window starts. Unexplained, that reads as an off-by-one.

### 🟡 Major 6. The coverage-gap backstory is assumed, which makes "required" and F2 impossible to paraphrase

Lines 72, 87-89, 132, 161, 338-339.

- These questions are never answered: Why does B09 "require" a Local Services record? Why does the window start on Oct 13? How do lsa-B09 (line 161) and pmax-lsa-B09 (lines 72, 132) relate? Why was $2,123.52 filed under Search?
- F2 depends entirely on that story. "A successor," "the stop," "overlap days" and "the window" are all undefined. The reviewer's reading is that a successor campaign started before its predecessor stopped, and the days both ran fall outside the window, still misfiled. That is a guess.
- F2 also says a shipped sentence, "reclassified, not added," can be false. That is a real risk the reader needs to understand.

### 🟡 Major 7. Several expected outcomes have no reported result

Lines 21-22, 78, 79, 105-106.

Lines 21-22 promise that later sections report against §1, but these have no result anywhere in the document:

- Scenario 7 (line 79): no runner step in §5, no test in §3, no open edge in §7.
- Scenario 6's "Decision Lab show before and after" (line 78): §3 reports only the incident (lines 267-268).
- "Pending, empty, stale and unavailable evidence are said as such" (line 105).
- "A loading state never shows ready or $0.00" (line 106).

The reader can't tell whether these passed, went untested or were dropped. Separately, "existing policy, inside 60 days" never says what the 60 days are counted from.

### 🟢 Nit 1. The project, Moxie and the branch codes are never introduced

Lines 3-5, 12, 61, 180, 345, 408. The document never says what the product is. Moxie owns both open policy questions, but who Moxie is is never stated. B09 is used from line 12, only reads as a branch from about line 61, and is named ("B09 Coral") only at line 408. B10, B20 and B44 are never introduced either.

### 🟢 Nit 2. Identifiers and documents with no explanation or path

Lines 7, 15, 54, 113, 175, 288, 338, 340, 361-362, 496-499.

- R-54 is used as shorthand, but only its case 2 is described.
- Unexplained: R-56, F2, F8, BIVE, "the book, chapter 16 §10" (so it's unclear whether N1 is a requirement or a claim), "definition v3", "the spec" and "recorded by `91f253b`".
- `RELEASE-CANDIDATE.md`, `BIVE-ACCEPTANCE.md` and `PREMIUM-POLISH.md` have no path.
- The two Google Ads Help articles have no URL.

### 🟢 Nit 3. The second way a hold lifts is never shown, and the $400.00 example blurs it

Lines 43-44, 132, 141, 216, 251, 270.

- A hold also lifts when "the refused revision itself is accepted." That is presumably by replay, but replay is never described and no scenario or test exercises it.
- For a replay, "names the delivery that resolved it" is unclear.
- Line 270's correction ($120.91 to $400.00) has the same amount as the refused revision. A reader checking §1.7's first failure ("a refused amount shown as counted") has to work out from scenario 4 that this $400.00 came from a newer accepted revision.

### 🟢 Nit 4. It's unclear what the verification rows were measured on

Lines 11-13, 150, 290, 320-323, 452-453.

- §4's captures were taken on build `nQcxhPYqwZXfT91nSHH7Y`, and §5's browser specs cite `9b052dc`. Neither is tied to `718e4aa`.
- The status block says full vitest passed, but §5 reports one unnamed "expected failure."
- Line 321's "31 proving, 62 paired denials," "the independent ledger" and "paired scope" are unexplained.
- Lines 452-453 don't say which world they describe. Line 150 shows the same week in another world as having spend records.

### 🟢 Nit 5. The re-run steps in §9.3 can't be followed as written

Lines 473-479. "Demo mode" is not defined, the steps don't say which database each port (3999/4000, 3996/3997) serves, and "this build" could mean `6ed9066` or the working tree.

### 🟢 Nit 6. The design references don't say what was borrowed

Lines 393-401. UI/UX Pro Max has no link and no one-line description. "Knock for one event," "Sentry for the default selection" and "OpenStatus for the strip" name products but not the patterns taken from them.

### 🟢 Nit 7. Names that invite confusion

Lines 1, 3-4, 16, 55, 192, 379, 420-421, 488.

- "The B09 decision view" reads as Decision Lab until line 379.
- The incident page's route is `app/exceptions/[id]`.
- "Comes back to the same decision" could mean the outcome is unchanged.
- "A schema failure" (§1.3) and "ambiguous typing" (§3) may be the same refusal code.
- "Rule 11" (a design-system rule) is easy to confuse with reconciliation rules 1 and 1a.
