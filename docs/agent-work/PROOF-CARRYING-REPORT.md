# Proof-carrying revenue intelligence: final report

Mission of 2026-11-12. Everything below runs locally on synthetic data. Nothing is deployed, no
live Moxie or vendor system is connected, and no language model was run (there is no key, by
rule). Where a number is given, its denominator is given with it.

## Level 1: the answer

**Which business statements can Revenue Signal OS now prove, which can it only hypothesize, and
which must it refuse to answer?**

| | Statements | Why |
|---|---|---|
| **Proves** | A branch's paid CAC, paid spend and paid customers for September or October 2026, reproduced from the stored records under definition v3, with what the figure leaves out. Collected cash, refunds, gross payments, new-customer collections and revenue at risk, to the cent, from payment records. The unknown-channel share. Channel spend, customers and CAC. Brand totals, when the viewer sees the whole brand. Changes, ratios and directions between the two months. Readiness, budget-signal and feed-freshness verdicts as the product's rules computed them. A channel's verified-readiness state under one fixed policy | Each figure is a typed fact from a structured tool output, reproduced from records by a trace whose invariants can fail. Each sentence carries a proof (metric, entity, period, unit, currency, definition version, formula, inputs, evidence ids) checked by code, not by a model |
| **Hypothesizes** | Why a CAC changed (six tests, H1–H6: spend, paid customers, misclassification, missing data, a definition change, conversion lag). A decomposition of the change into spend and customers. Whether October's leads are still maturing. Any model-written sentence that has nothing to prove, or a soft gap | The tests decompose and look for counterevidence; they do not measure a cause. They are labelled SUPPORTED, CONTRADICTED, UNRESOLVED or NOT TESTABLE, each with what would change it. "Accounted for", never "explained" |
| **Refuses** | That something caused revenue, customers or a lower CAC (no experiment exists; READY needs a randomized holdout). Questions naming a branch or brand outside the viewer's scope, however written. Requests to act. Spend whose feed stated no currency, unless two people authorized a rule for that account; any other currency, ever. Invoiced, billed or contract value, profit, margin, payment counts. Periods other than September and October 2026. Model text that says anything the checker did not read | The facts to prove these do not exist in the product, or the viewer may not see them. A refusal says which |

## Level 2: what was built and measured

### A. The frozen held-out evaluation

About 60 cases (62) were written and frozen (`investigator-heldout/FREEZE.md`, sha256 of
`cases.v1.json` recorded) before the code met them. First contact ran once and was committed
unchanged (`evidence/first-contact.*`). The deterministic investigator is measured in
investigator mode; the claim checker is measured in claims mode behind a scripted provider. **The
claims mode measures the checker, not a model: no model accuracy is claimed anywhere.**

| Run | Investigator: correct outcome | Claims: judged correctly | Wrong candidates rejected | Critical false accepts | Template sentences contradicted by their own proofs |
|---|---|---|---|---|---|
| First contact, frozen code `c8421b7` | 20 / 30 | 87 / 133 | 38 / 72 | 26 / 57 | not measured |
| Frozen code, three runner defects fixed (adjudication only) | 20 / 32 | 94 / 138 | 42 / 75 | 25 / 60 | not measured |
| After milestone B | 32 / 32 | 135 / 138 | — | 1 / 60 | — |
| After milestone C | 32 / 32 | 136 / 138 | 75 / 75 | 0 / 60 | 0 / 158 |
| After the review fixes (`007f01f`, regression) | 32 / 32 | 135 / 138 | 75 / 75 | 0 / 60 | 0 / 158 |

From milestone B on, **the set is a regression suite, not a held-out measure**: the code was
improved against its failures. The three runner defects (an undefined branch, a null campaign
given a Google Ads source, a sale 48 h before its service) are listed with the product defects in
`evidence/ADJUDICATION.md`. Of the three claims still judged wrong, two are IV-16's definitional
paraphrases, rejected by design (the checker does not verify a paraphrase of a definition), and
one is IV-35, a correct credited-part sentence the checker still rejects: a false reject, not a
false accept.

### B. Proof-carrying claims

`lib/ai/proof.ts` proves each proposition (level, change, relative or points change, ratio, sum,
share, arithmetic, direction, status, membership, credited part) against the typed facts the claim
cites and returns VERIFIED, CONTRADICTED or UNRESOLVED with a named gap. The fourteen required
rejections (A–N) each have a test (`PROOF-CARRYING-CLAIMS.md`). A model is never the only verifier:
model text is SUPPORTED only when every proposition is VERIFIED and nothing in it went unread;
authoritative text comes only from templates, which are dropped on any contradiction.

### C. Financial Evidence Graph 2.0

Cash, attribution and brand traces, cent-exact, with invariants (`FINANCIAL-EVIDENCE-GRAPH.md`).
Unstated currency is excluded at intake and listed; it counts only under an account rule proposed
by an engineer and authorized by a different approver (enforced in code and in the database), and
revoking the rule excludes it again. Customers whose spend is held leave the CAC with it
(definition v3); customers counted while part of their campaign's spend is held are flagged.

### D. Investigation workspace

"Why did B09's paid CAC increase?" is a persistent workspace: six hypotheses, eleven bounded reads
in one snapshot, every re-test a new version, notes, counterevidence, "what would change this".
On the seeded demo, B09's paid CAC fell ($274.30 → $241.29), so the workspace answers that the
premise does not hold.

### E. Decision Lab verified readiness

READY, READY_WITH_LIMITATIONS, NEEDS_REVIEW or NOT_READY from one ordered policy, every rule shown
with its result, read in one snapshot (`WORKSPACE-READINESS-SIGNALS.md`). No channel in the demo is
READY: none has a completed randomized holdout.

### F. Reliability signals

Six conditions, each with its size, the role who acts and where; nothing is shown when nothing is
wrong. On the freshly seeded demo none fires.

### G. Reviews, regression, clean checkout

| Check | Result |
|---|---|
| Adversarial reviews | Three independent reviewers: financial correctness and provenance (15 findings), AI claims (20), authorization, concurrency and usability (14). Fixed with reproducers except where listed below |
| Full regression (`007f01f`) | Typecheck, lint, build: pass. Vitest 687 / 687. Investigator held-out (regression) as above; ChangeGuard held-out (regression) 30 pass, 0 critical, unchanged. `eval-ai` failed on a stale case written before out-of-scope questions were refused; the case and runner were corrected and it passes 15 / 15. Playwright 71 passed, 1 skipped, 1 failed: the hostile-input gate ran about 600 requests in one 300 s test and ran out of time (no request failed); split per route in the next commit |
| Clean checkout | `b12dc67`: every step passed except one Playwright test (a nested proof `<summary>` broke a strict locator), fixed in `007f01f`. The clean checkout of the final commit is part of the VP acceptance mission (`VP-ACCEPTANCE-REPORT.md`) |
| Responsive check | 375 and 768 px checked by hand on the workspace, Decision Lab and Integrations at `b12dc67`; the accessibility gate now runs axe and a no-sideways-scroll check on 21 pages at 390, 768, 1280 and 1440 px |

## Level 3: what the reviews found, and what remains

### The worst findings

1. **AI claims, shared root (critical).** What the checker did not read, it ignored, and it
   certified the sentence on the part it did read: "did not fall" proved as "fell", "surged by
   $20,000" proved by its size, "Elm's CAC" proved as the investigation branch's, "300.00 per paid
   customer" not seen. Eighteen shapes of wrong text were accepted as SUPPORTED, eleven critical.
   Fixed by the closed reading: any unread part of model text is a hard gap. While fixing it, the
   same root showed in the held-out set: "5 paid customers, 2 of them credited to Meta" had been
   SUPPORTED on the 5 alone, so "3 of them" would have passed too. The reader now proves credited
   parts.
2. **Financial (critical).** Customers stayed in the CAC after their spend left it by a revoke,
   the 0020 migration's delete or the gate, because "held" meant "no campaign row". CAC read too
   low and nothing flagged it. Held spend is now read from the held records per campaign-day.
3. **Concurrency (high).** A revoke racing an ads ingest could leave money counted as USD with no
   live rule. Currency decisions now take an exclusive advisory lock that intake holds shared from
   the start of its transaction.

The full lists, with each fix: `PROOF-CARRYING-CLAIMS.md` (closed reading),
`FINANCIAL-EVIDENCE-GRAPH.md` and `WORKSPACE-READINESS-SIGNALS.md` ("After the reviews").

### Not fixed

| Finding | Why not |
|---|---|
| The closed reading is a list of patterns | A wrong model sentence in a shape no pattern names could still pass. It was tested on the reviewer's cases and the regression suite, not on a fresh independent set |
| The checker rejects some correct model text (ranges, "each", "respectively", "1.2 times" for 1.206, definitional paraphrases) | Fail-closed by design: a correct sentence rejected, never a wrong one accepted |
| Campaign ids shared across platforms (financial 14) | Acquisitions carry no platform; documented |
| Verified readiness repeats branch-level rules on every channel; the workspace rule does not age out a stale workspace | Low severity; the rule names the workspace and its version and links to it |
| The six-dimension review was done by three reviewers, not six | Financial with provenance, and authorization with concurrency and usability, were reviewed together |

### Performance

Seeded demo world (134,088 raw events), one laptop, Postgres with `fsync=off`, median of 3:

| Path | Median |
|---|---|
| Scorecard, all branches, October (`branchRows`) | 588 ms |
| Company totals, October | 933 ms |
| Paid-CAC trace, B09 | 727 ms |
| Cash trace, B09 | 684 ms |
| Attribution trace, B09 | 671 ms |
| Verified readiness, B09 (one snapshot) | 2.9 s |
| Investigation workspace, six hypotheses | 3.6 s |
| Reliability signals | 903 ms |
| Decision Lab page, server time per request | about 4.3 s (blamed then on the A/A self-check; corrected 2026-11-13: it was Verified readiness reading the scorecard four times, now 1.3–1.9 s, `PERFORMANCE.md` §6) |
| Overview page, server time per request | about 3.3 s |

## Level 4: evidence

| What | Where |
|---|---|
| Frozen cases, brief, schema, scoring, tools, freeze record | `docs/agent-work/investigator-heldout/` |
| First contact, unchanged; adjudication; runner-fixed and after-change runs | `docs/agent-work/investigator-heldout/evidence/` |
| Proof engine and closed reading | `lib/ai/proof.ts`, `lib/ai/facts.ts`, `lib/ai/analyst.ts` |
| Money traces and currency rules | `lib/lineage/cash.ts`, `lib/lineage/trace.ts`, `lib/currency/`, `database/migrations/0020_currency_rules.sql` |
| Workspace, readiness, signals | `lib/inquiry/`, `lib/decision/verified.ts`, `lib/health/signals.ts`, `database/migrations/0021_inquiries.sql` |
| Review reproducers | `tests/unit/ai-proof.test.ts`, `tests/unit/ai-claims.test.ts` ("the AI-claims review, 2026-11-12"); `tests/integration/currency-rules.test.ts`, `cash-trace.test.ts`, `inquiry.test.ts`, `ai-investigator.test.ts` |
| Remaining risks | `REMAINING-RISKS.md` (R-17, R-23 to R-26 updated; R-27 to R-29 new) |
