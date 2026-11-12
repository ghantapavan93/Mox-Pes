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
| **Model** (free text) | SUPPORTED only when every proposition is VERIFIED **and nothing in the sentence went unread** (the closed reading, below). A hard gap rejects the claim: the cited evidence cannot establish it. A soft gap (an ambiguous or conditional reading) shows it as PARTIALLY_SUPPORTED, with the limitation stated. A sentence with nothing to prove (an event, an explanation) is PARTIALLY_SUPPORTED, never SUPPORTED: the model is never the only verifier. A recommendation stated as a finding is shown as a recommendation |

### The closed reading (added after the AI-claims review of 2026-11-12)

An adversarial review found 18 shapes of wrong model text that the checker accepted as SUPPORTED,
11 of them critical. The shared root: what the reader did not understand, it ignored, and it
certified the sentence on the part it did read. "B09's collections did not fall" was proved as
"fell"; "surged by $20,000" was proved by its size alone; "Elm's CAC" was proved as the
investigation branch's; "300.00 per paid customer" was not seen as a figure at all.

Model text is now held to a closed reading (`closedReading` in `lib/ai/proof.ts`). Each of these
becomes an UNRESOLVED proposition with the hard gap `unread`, so the claim is rejected:

| What was not read | Examples from the review |
|---|---|
| A negation the reader does not handle | "did not fall", "no more than $4,000", "isn't decision-ready", "no longer" |
| A verb of change, rank or equality with no relation | "surged", "flat", "unchanged", "doubled", "ranks first", "the lowest" |
| A comparison target that is not a month, branch, channel or figure | "than it collected", "than the company average", "than planned", "twice the Google Search CAC" |
| A period the facts do not hold | November, Q3, last year, October 2025, daily, per week, average |
| An entity it cannot place, or that no proposition is about | "Elm's", "b12's", "moxie's", "company-wide", an unlisted channel or campaign, a customer id, a second branch in a total stated before the list |
| A figure in a form it does not parse | "300.00", "$-9,999.00", "one hundred fifty thousand", "9.9 million", "20.6 percentage points", a figure in quotes |
| Another currency | "CA$", "A$", "EUR", "€" |
| A second measure no proposition covers | "its spend and its collections both rose" |
| A word that changes the metric | blended, recognized, profit, "per new paid customer" with a cash verb, "only", "excluding", a share of the wrong base |
| A customer count with a verb that is not acquisition | paying, invoiced, refunded, cancelled, became customers |

The checks are deliberately coarse: a correct sentence in words the checker does not read is
rejected, never a wrong one accepted. Templates are not held to it; they are the product's own
sentences in this vocabulary, and the held-out run reports how often a template sentence
contradicts its own proofs.

The same review also fixed, for every origin: "down from" and "up from" read as directions; a
forecast word ("will") governs only what follows it, so "CAC was $4,825.80, which will need
review" is contradicted, not excused; "almost $4,800" must not be above $4,800; a scaled figure
("$0.1M") may be off by at most 5%; a count in arithmetic is exact ("÷ 20" is not 19.5–20.5);
"N points" is read as a change of a share; every channel of a readiness claim is checked; a
customer's figures in a template are not read as the branch's; a figure inside a quoted campaign
name is a name; citing a sampled record of a trace no longer cites the trace's totals; a causal
claim is unhedged unless the hedge is in its own sentence; and a business figure resting on a
superseded revision is dropped whatever words ("after the correction") surround it.
Reproducers: `tests/unit/ai-proof.test.ts` and `tests/unit/ai-claims.test.ts`, "the AI-claims
review, 2026-11-12".

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
  campaigns, brands, two months and common phrasings. Until the review of 2026-11-12, text outside
  it was ignored and a model sentence could be certified on the part that was read; the closed
  reading now rejects model text with any unread part. The closed reading is itself a list of
  patterns: a wrong sentence in a shape no pattern names could still pass. It was tested against
  the review's cases, not against a fresh independent set.
- **It cannot verify a paraphrase of a definition** (IV-16).
- **It does not understand negation in general.** Negated readiness, membership, zeros and
  "not yet paid" are read; any other negation in model text rejects the claim.
- **No language model was measured.** There is no model key. Model-written text was tested only
  through scripted providers.
