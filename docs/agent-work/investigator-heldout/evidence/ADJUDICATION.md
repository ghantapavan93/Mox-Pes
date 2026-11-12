# Investigator held-out set: adjudication of first contact

First contact is `first-contact.json`. It was run once, at commit `c8421b7`, from a clean worktree, on
the investigator at `d472069`. It is committed unchanged in `c619d1c`. Nothing here changes it or
the labels in `cases.v1.json`.

Nothing in this file measures a language model. There is no model key:
- **investigator mode** is the deterministic investigator;
- **claims mode** is the claim checker behind a scripted provider.

## First contact, as scored

Each measure has its own denominator. Three cases could not run (runner defect R1 below), so the
first-contact denominators are 30 investigator cases and 29 claims cases with 133 candidates.

| Investigator mode (30 cases) | Count |
|---|---|
| Correct outcome | 20 / 30 |
| Expected ANSWER, answered | 15 / 23 |
| Expected ABSTAIN, abstained | 2 / 3 |
| Expected REFUSE, refused | 3 / 4 |
| Unnecessary abstentions | 8 / 23 |
| Reference facts stated in a SUPPORTED claim | 16 / 31 |
| Forbidden statements in SUPPORTED claims (critical) | 2 (IV-01, IV-28) |
| Authorization failures (critical) | 1 (IV-45) |
| Answered instead of abstaining (high) | 1 (IV-49) |
| Invalid tool calls | 0 |

| Claims mode (133 candidates) | Count |
|---|---|
| Judged correctly (SUPPORTED vs not) | 87 / 133 |
| Wrong candidates rejected | 38 / 72 |
| Correct candidates accepted | 49 / 61 |
| **False accepts, critical-severity cases** | **26 / 57** |
| Exact status (all five) | 82 / 133 |

Every false accept and false reject is listed one by one in `first-contact.report.md`.

## Separating runner defects from product defects

Three first-contact failures came from the runner, not the product. Each one is fixed in
`scripts/eval-investigator.ts`, and the source comment beside each fix points back here.

| # | Runner defect | Effect at first contact |
|---|---|---|
| R1 | An `ask` without a `branch` was passed as `undefined`, not `null` | IV-29, IV-31 and IV-54 failed to run ("Unknown branch undefined") |
| R2 | A customer or lead with `campaign: null` got the call source "Google Ads", which the calls mapper files as paid search. SCHEMA.md says a null campaign means no paid touch | IV-01 and IV-28: the product counted those customers as paid, which was correct for the data as built. The forbidden-statement findings ($214.29, $200.00) are runner artefacts |
| R3 | The first service was 48 hours after the sale. The case convention (FREEZE.md, designer note 4) is the same day | Customers sold on 29–30 October moved into November, so IV-37's October figures differed from the case |

To find which failures belong to the product, the **frozen first-contact code** was run again with
**only the runner corrected**: `first-contact-code-runner-fixed.json` and `.report.md`. This run
does not replace first contact. It shows that:

- **The claim-checker failures are the product's.** The frozen checker still makes 33 false accepts,
  25 of them in critical cases (out of 60). One first-contact false accept (IV-14 "$200.00") was a
  runner artefact.
- **The forbidden statements were the runner's.** In investigator mode there are 0 of them, against 2.
- **The authorization failures are the product's.** There are 2: IV-45, and IV-54, which could not
  run at first contact.
- **The abstentions are the product's:**
  - 9 unnecessary abstentions;
  - 1 answer where it should have abstained (IV-49).

## Product defects found, and what was done

| # | Severity | Defect | Cases | Fix |
|---|---|---|---|---|
| P1 | **critical** | The claim checker matched numbers, not meaning. A figure was accepted if it appeared anywhere in a cited output, whatever metric, branch, period, direction, arithmetic or unit the sentence gave it | 25 critical and 8 high false accepts (IV-04, 05, 07, 08, 09, 11, 12, 14, 15, 19, 20, 24, 25, 27, 32, 33, 35, 39, 44) | Proof-carrying claims (`lib/ai/proof.ts`): every figure must follow from typed facts (`lib/ai/facts.ts`) |
| P2 | **critical** | "…share a phone number. Merge them into one customer" was not refused as an action request | IV-45 | Imperative at any sentence start (`lib/ai/deterministic.ts`) |
| P3 | **critical** | A partner's brand-wide question was answered about the partner's own branch instead of being refused | IV-54 | `assertQuestionInScope` (`lib/ai/investigate.ts`): branches and brands named in the question must be in scope |
| P4 | high | A forecast ("What will CAC be in November if we double…") was answered with current figures | IV-49 | `forecast` intent: the answer says no tool forecasts |
| P5 | high | Plain figure questions (spend, collected cash, customers, a brand's totals) abstained. The deterministic investigator had no plan for them | IV-03, 10, 18, 26, 31, 34, 36, 42, 52 | `metric_lookup` plan; brand rollups through `getBrandMetrics` |
| P6 | **critical** | Customers credited to a campaign whose spend was held at intake (a CAD account) stay in the CAC denominator while the spend is out | IV-24 (claims), IV-26 | Milestone C (definition change) |
| P7 | high | `getBranchMetrics` does not say whether its spend's currency was stated, so a channel figure on unstated currency could be certified | IV-25 | Milestone C |
| P8 | medium | Correct derived figures (a difference, a share, a total) were rejected because the exact number was not printed in a tool output | IV-02, 06, 09, 22, 23, 37 | A verified proof is the evidence for a derived figure |

## Disagreements kept as decisions, not relabelled

| Case | Label | Product | Why the product is kept |
|---|---|---|---|
| IV-16 (×2) | A paraphrase of a metric definition, citing only the definition, is SUPPORTED | PARTIALLY_SUPPORTED | The checker cannot verify that a paraphrase matches the definition. A claim that cites only definitions is not record-backed (`NON_RECORD_KINDS`) |

## After changes (no longer held out)

The same frozen cases were run against the new code. That code was tuned against these cases, so
from here on the set is a regression suite, not a held-out measure. The runs are the
`after-changes-*.json` files. Their headline numbers, with what was still open at each run, are in
`docs/agent-work/PROOF-CARRYING-CLAIMS.md`.
