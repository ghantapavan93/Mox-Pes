# Schema assistant: evaluation

The schema assistant (`lib/onboarding/assistant.ts`) suggests which column of an unfamiliar
export is which business field. It is the AI-adjacent piece most likely to do quiet damage: a
confident wrong mapping moves money into the wrong meaning. So it is measured, and the
measurement is built to resist self-deception.

## What it is, honestly

- **Deterministic.** Header vocabulary (with abbreviation expansion and stopwords), value-shape
  profiles over every row, branch-name resolution, enum-value fit, money-meaning vocabulary, and
  explicit abstention rules. No language model. No row value leaves the server. Cost per case: 0
  tokens, $0.
- **A model is not evaluated here.** A model-backed assistant could implement the same output
  contract (`FieldSuggestion`: candidate, evidence, alternatives, abstain reasons,
  `requiresConfirmation: true`). It would have to beat these numbers on the same held-out sets
  first, and sending column profiles to a provider needs data-handling approval. Neither exists.
- **It only suggests.** Every suggestion needs a person to save a mapping version, and a
  *different role* to approve it (enforced by a database check constraint).

## Method: three independently written sets

Each set was written by a separate agent that could read only the field definitions
(`lib/onboarding/targets.ts`) and branch reference data. None could read the assistant, its
tests or the other sets.

| Set | Cases | Field labels | Written | Role in this evaluation |
|---|---|---|---|---|
| v1 | 69 | 417 | before the assistant was run | **Held out at first contact**, then used to fix failures, so it became a development set |
| v2 | 59 | 389 | after v1 fixes | **Held out at first contact**, then used to fix safety failures, so it became a development set |
| v3 | 56 | 365 | after the rules were frozen | **Held out. Never used for tuning.** The generalisation number |

**Scoring** (per labeled field): label = a header → correct if exactly that column is suggested,
**wrong** if another column is suggested, *abstained* if nothing is. Label = `null` (nothing
should map) or `ambiguous` (a careful person would ask) → correct only if nothing is suggested.
Dataset detection is scored separately, including "abstain" labels.

**The safety metric is the wrong-suggestion rate**: of the columns the assistant put forward,
the share the labeler says are wrong. Abstaining costs the user a question; a wrong suggestion
can cost money. Every number has its denominator. The **baseline** is what a quick script would
do: map each field to the best-matching header, never abstain, no value or money checks.

## Results

### First contact (held out at the time of measurement)

| Set | Assistant wrong / suggested | Baseline wrong / suggested | Abstention recall (assistant / baseline) | Over-abstention (assistant / baseline) | Dataset detection (assistant / baseline) |
|---|---|---|---|---|---|
| v1 | **6 / 362 (1.7%)** | 13 / 371 (3.5%) | 89.3% / 76.8% | 1.4% / 0.8% | 7/8 / 5/8 |
| v2 | **7 / 277 (2.5%)** | 24 / 309 (7.8%) | 90.8% / 72.3% | 16.4% / 10.2% | 6/8 / 3/8 |
| **v3** | **6 / 269 (2.2%)** | 21 / 300 (7.0%) | **89.4% / 68.1%** | **17.0% / 10.4%** | **7/9 / 5/9** |

Evidence: `docs/agent-work/evidence/mapping-eval-v{1,2,3}-first-contact.json`.

**What the held-out numbers support:** on exports it has never seen, the assistant puts forward a
wrong column about 2–2.5% of the time, roughly a third of the naive baseline's rate, and it
abstains on ambiguous or absent fields about 89–91% of the time against about 68–77% for the
baseline. **The price** is over-abstention of 16–17%: on vendor-specific abbreviations
(`Amt Rcvd`, `Txn Dt`, `GCLID__c`, Twilio's `from`/`to`), it asks instead of guessing. That costs
the user a question, not a wrong number.

**What they do not support:** a claim of general accuracy. Plain accuracy (correct labels / all
labels) is about the same for both engines (v3: 83.6% vs 85.2%): the naive matcher "wins"
easy fields by always answering, and loses where answering is unsafe.

### After fixing (development numbers, not generalisation)

| Set | Assistant wrong / suggested | Dataset detection |
|---|---|---|
| v1 (dev) | 0 / 361 | 8/8 |
| v2 (dev) | 1 / 300 | 7/8 |

These are numbers on sets the rules were fixed against. They show the fixes worked on the cases
that motivated them, nothing more.

## Failure categories (v3, held out)

| Category | Wrong | Notes |
|---|---|---|
| ambiguous_header | 2 | Meta "Link clicks" suggested where the labeler wants a question (two clicks columns); "Created (UTC)" suggested as the payment date |
| plausible_but_wrong | 2 | A Five9 dialer CAMPAIGN read as an ad campaign; a Gravity Forms "Form ID" read as the entry id |
| financial_semantics | 2 | A Square "Date" with several money columns; a ServiceTitan invoice-grain "Amount Paid" (the labeler flagged both as debatable) |
| prompt_injection | **0** | Injected text in cells and headers never changed a mapping |
| correct_mapping | 0 wrong | 16 abstentions on vendor jargon |

## What was fixed between sets, and why it generalises (or might not)

After v1 (6 wrong): a generic one-word synonym ("id", "date", "status") no longer matches a
header qualified by an unrelated noun (`Visitor ID`, `Service Date`, `Sale Status`, `Caller ID`);
numbered sibling headers (`Phone`, `Phone 2`) are always a question; value-only evidence counts
for unmistakable kinds (emails); a right column with damaged values is still the right column;
a file whose values name two record types is not given a dataset.

After v2 (7 wrong): an enum's **values** must translate, not just its name (`Status` = Open/Paid
is not a payment status); branch columns are judged by whether their values name branches; two
branch-valued columns, or two id columns of the same entity, are a question; a bare `Amount` in a
file about invoices and balances is not cash collected; and a dictionary of export abbreviations.

Each fix is a rule about meaning, not about a case's spelling. One v2 case (`Txn Date` vs
`Post Date`) was deliberately **left failing**, because fixing it needed a stemming rule fitted to
that one case. v3 then measured the frozen rules: the wrong-suggestion rate held at 2.2%.

## Regression gate

`tests/unit/onboarding-eval.test.ts` runs in `npm test`:
- v1 ≤ 0 wrong, v2 ≤ 1 wrong, v3 ≤ its first-contact count (6). Zero wrong in
  `financial_semantics`, `prompt_injection` and `plausible_but_wrong` on v1 and v2.
- The assistant must stay below the baseline's wrong-suggestion rate on every set.
- Reports are deterministic (two runs, same report).

Any change to vocabulary or rules that makes the assistant less safe fails the build. A new set
(v4) written after this change is the next honest measurement.

## Reproduce

```
npm run eval:mapping -- --set=v3 --failures
npm run eval:mapping -- --set=v1 --json=out.json
```

Latency on the reference machine (AMD Ryzen 9 5900HX, Node 22): p50 about 2 ms, p95 about 6 ms per
case.

## Limits

- The sets are synthetic and written by language-model agents imitating vendor exports. They are
  independent of the assistant, but they are not real exports and not human-labeled.
- Three labelers flagged 20+ labels as debatable. Where a label is arguable, the wrong-count
  could move by one or two.
- The existing AI Investigator has its own evaluation (`docs/ai-evaluation.md`, 15 cases,
  deterministic mode). Its model mode remains not evaluated (no key, by rule).
