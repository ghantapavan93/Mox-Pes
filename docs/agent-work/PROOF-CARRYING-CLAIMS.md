# Proof-carrying claims

**Problem.** The earlier claim check (`lib/ai/numbers.ts`) accepted a figure if the same kind of
number appeared in any output the claim cited. "October revenue increased by $20,000" passed
whenever $20,000 appeared somewhere, even with October at $100,000 and September at $120,000. The
independent held-out set measured this at first contact: **26 of 57 wrong candidates in critical
cases were accepted** (`investigator-heldout/evidence/ADJUDICATION.md`).

**Now.** A statement is accepted only when each proposition in it **follows** from the typed facts it
cites. A proposition is a figure, a direction, a status or a brand membership. The check is
deterministic and outside the model. Nothing relies on a model to verify a model.

## Pieces

| Module | What it does |
|---|---|
| `lib/ai/facts.ts` | **Typed facts** from the structured fields of the metric tools, never from text, names or notes. Each fact records: metric, entity (branch, channel, campaign), period, value, unit (integer cents, count, ratio), definition version, whether the money's currency is established, the evidence ids that cite it, and the tool it came from. It also holds **status facts**: decision readiness, the budget signal and feed freshness |
| `lib/ai/proof.ts` | **Proves each proposition** against the cited facts, with an explicit proof: subject (metric, entity, period), the other side of a comparison, relation, formula, inputs (with definition version, currency status, tool and evidence ids), computed and claimed values, qualifier, direction, precision and rounding rule, verdict, and the gap when it is unresolved |
| `judge` | Turns the proofs into a claim status, according to who wrote the sentence |
| `lib/ai/analyst.ts` | Runs the proofs on every observation, suspected cause and free-text field. A rejected claim keeps its proofs |
| `lib/ai/revisions.ts` | Stale revisions: a cited source record that a newer revision of the same entity superseded |
| `components/investigator/FindingsView.tsx` | The claim check, in four levels. 1: status. 2: reason. 3: one line per proposition. 4: the facts each proposition used |

## Relations proved

| Relation | Example | Proof |
|---|---|---|
| level | "B09's October paid CAC is $241.29" | v(paidCac, B09, oct) at the precision written |
| change | "…decreased by $20,000 from September" | v(oct) − v(sep): size **and** sign |
| from → to | "…fell from $120,000 to $100,000" | both levels and the direction |
| relative change | "…rose 12% from September" | \|Δ\| ÷ \|v(sep)\| |
| points change | "…share rose 2 points" | Δ × 100 ("2%" of a share is ambiguous and is not proved) |
| versus | "…higher than B12's $200" · "…less than its Google Search spend" | the two branches or channels in the same period |
| ratio | "…twice its September CAC" · "…half of B10's" | v ÷ v |
| sum | "B41 and B42 spent…" · "Joshua's …" · "across September and October" | every part must be cited. CAC and share are recomputed from summed parts, never averaged |
| share | "Microsoft Ads was 20% of B37's spend" | channel ÷ branch |
| arithmetic | "$4,825.80 ÷ 20 = $241.29" | the arithmetic, using interval bounds for rounded operands; each operand must be a cited fact |
| direction | "October revenue increased" (no figure) | sign of v(oct) − v(sep) |
| status | "Google Search is decision-ready" · "its payment records are complete" | the readiness verdict; feed freshness from **every** tool call of the run (a stale feed anywhere is counterevidence) |
| membership | "B41 … is Mission brand spend" | the branch's brand |

## The fourteen required rejections

Each one has its own tests in `tests/unit/ai-proof.test.ts`, written by the engineer and not taken
from the held-out set. Several are also tested end to end through `runInvestigation` in
`tests/integration/ai-investigator.test.ts`.

| Code | Case | Rejected because |
|---|---|---|
| A | Wrong entity: one campaign's figure attributed to another | The fact for that campaign says otherwise |
| B | Wrong branch, or a branch the evidence does not cover | CONTRADICTED, or `fact_missing` |
| C | Wrong period, or a period not cited | CONTRADICTED, or `period_missing` |
| D | Wrong metric (the CAC figure called spend) | The paid-spend fact says otherwise |
| E | Wrong sign | The direction differs from the sign of Δ |
| F | Wrong arithmetic, or an operand that is not a cited fact | The arithmetic fails, or `operand_missing` |
| G | Unsupported causality | The causal-impact check, which now also catches "caused X to fall" |
| H | Stale revision | The claim cites a superseded raw event without its successor |
| I | A percentage used as currency, or the reverse | Unit mismatch |
| J | A customer count used as a payment count | `metric_unsupported` |
| K | An invoiced amount used as collected cash | `metric_unsupported`, or the collected fact differs |
| L | An amount planted in a name or note | Facts come only from typed fields |
| M | Assumed USD | `currency_unresolved` |
| N | Evidence missing from the snapshot (not cited, or not returned) | Grounding, or `fact_missing` |

## Who wrote the sentence

| Origin | Rule |
|---|---|
| **Template** (deterministic investigator, filled from structured results) | Authoritative. Dropped only on a **contradiction**. Money whose currency is not established, or tools that disagree, gives at most PARTIALLY_SUPPORTED |
| **Model** (free text) | SUPPORTED only when every proposition is VERIFIED. A hard gap rejects the claim: the cited evidence cannot establish it. A soft gap (a figure outside the vocabulary, an ambiguous or conditional reading) shows it as PARTIALLY_SUPPORTED, with the limitation stated. A recommendation stated as a finding is shown as a recommendation |

A figure that no output prints is accepted only when a verified proof derives it: a difference, a
share or a total. That proof is its evidence.

## Measured

| Run | Claims: judged correctly | Critical false accepts | Investigator: correct outcome |
|---|---|---|---|
| First contact (frozen, `c8421b7`) | 87 / 133 | 26 / 57 | 20 / 30 |
| Frozen code, runner corrected (adjudication only) | 94 / 138 | 25 / 60 | 20 / 32 |
| After milestone B (no longer held out) | 135 / 138 | 1 / 60 (IV-24: defect P6, milestone C) | 32 / 32 |

After milestone B the set is a regression suite. The checker was improved against its failures,
so this is not a held-out measure. A fresh independent set is the only honest next measure.

## What it does not do

- **It reads a fixed vocabulary.** That is the product's own metrics, plus branches, channels,
  campaigns, brands, two months and common phrasings. Text outside it is UNRESOLVED, and model text
  is then never certified.
- **It cannot verify a paraphrase of a definition** (IV-16).
- **It does not understand negation in general.** Negated readiness and membership are handled.
- **No language model was measured.** There is no model key. Model-written text was tested only
  through scripted providers.
