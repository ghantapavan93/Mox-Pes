# How the held-out investigator cases are scored

Written before the cases existed and committed with them, before any run. Neither this file nor
`cases.v1.json` changes after the first run. Disagreements go into an adjudication table beside
the first-contact result, never into the labels.

## The runner uses the real paths

`scripts/eval-investigator.ts` builds each case's world in its own fresh database
(`revenue_signal_eval`) through real intake (the deployed mappers), the real mapping and lead
override actions, reconciliation and identity resolution. Feed freshness is written as ingestion
run rows.

- **Investigator mode:** `runInvestigation` with `mode: "deterministic"` as the named actor, with
  the question and branch from `ask`. There is no model key, so this is the deterministic
  investigator. Nothing here measures a language model.
- **Claims mode:** `runInvestigation` with a scripted provider. Turn 1 makes the case's tool calls;
  turn 2 submits the candidates as findings, each citing the evidence ids its `cites` calls
  returned (read from the tool results the loop sends back). The checker's verdict on each
  candidate is read from the result's claims. This measures **the checker**, not a model.

## Outcome (investigator mode)

| System result | Outcome |
|---|---|
| The call is refused (ForbiddenError, or the result carries a refusal) | `REFUSE` |
| At least one claim `SUPPORTED` | `ANSWER` |
| Otherwise | `ABSTAIN` |

## Measures, reported per case and in total (no average hides a failure)

| Measure | Definition | Severity |
|---|---|---|
| Correct outcome | Outcome equals `expect.outcome` | — |
| Unnecessary abstention / refusal | Expected `ANSWER`, got `ABSTAIN` / `REFUSE` | medium (high if the case says so) |
| **Wrong answer instead of abstaining** | Expected `ABSTAIN`, got `ANSWER` | high |
| **Authorization failure** | Expected `REFUSE`, got anything else; or any `mustNotMention` string anywhere in the result | **critical** |
| Missing reference fact | A `mustBeStated` fact has no SUPPORTED claim whose figure matches it at the stated precision | medium |
| **Incorrect figure** | A SUPPORTED claim states a figure of a reference fact's kind that matches no reference fact while naming that fact's subject (reported for review; see adjudication) | high |
| **Forbidden statement** | A SUPPORTED claim matches a `forbidden` pattern | **critical** if `severityIfWrong` is critical, else high |
| **Accepted wrong candidate** (claims mode) | Expected not `SUPPORTED`, checker says `SUPPORTED` | **critical** when `severityIfWrong` is critical, else high |
| Rejected correct candidate (claims mode) | Expected `SUPPORTED`, checker says otherwise | medium |
| Status detail (claims mode) | Both not SUPPORTED but different statuses | info |
| Incorrect source reference | A SUPPORTED claim cites an id no tool returned (cannot happen if grounding works; counted anyway) | high |
| Invalid tool call | A tool step with status `error` in the run | low |
| Runner error / invalid case | The world or ask cannot be built as written | excluded and listed |

Headline numbers, each over its own denominator: outcome accuracy; claims-mode accept/reject
accuracy, with critical false accepts listed one by one; authorization failures; abstention
precision and recall.

## First contact is kept

The first complete run is `evidence/first-contact.json`, committed unchanged. Later runs against
the same frozen file are reported as **after changes, no longer held out**.
