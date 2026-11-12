# How the held-out scenarios are scored

Written and committed **before** the scenarios were run, and before the runner author had seen
them. Neither these rules nor `scenarios.v1.json` change after the first run. Later
disagreements go into an adjudication table beside the first-contact result, never into the
labels.

## The runner uses the real paths

`scripts/eval-changeguard.ts` builds each scenario's world in its own fresh database through the
real intake (`ingestRecords` with the deployed mappers), the real mapping and lead-override
actions, and reconciliation. Each step calls what the HTTP routes call:

| Step | Real call |
|---|---|
| `propose`, `propose_kind`, `resubmit`, `propose_source_contract` | The route's request schema (`NewChangeSchema` + `supersedes`) `.parse`, then `createChange` |
| `rerun_preflight` | `rerunPreflight` |
| `approve`, `reject` | `DecisionSchema.parse`, then `decideChange`, with the hashes read from the stored change (or from `hashesFrom`'s change) |
| `release` | `releaseChange` |
| `monitor` | `monitorChange` |
| `remap_outside` | `mapCampaignToBranch` (the Action Center's write path) |
| `correct_leads` | `overrideLeadBranch` |
| `concurrently` | the steps above, started together (`Promise.allSettled`) on separate pool connections |

Actors are the demo viewers. `marketing2` and `approver2` are the same roles with a different
subject (a different person).

## The system's answer

For a change-proposing step:

| What happened | Actual class |
|---|---|
| The request schema refused the input (`ZodError`): the product cannot represent it | `UNSUPPORTED` |
| Recorded, preview verdict `fail` (status `preflight_failed`) | `BLOCK` |
| Recorded, preview verdict `warn` (status `ready_for_review`, warnings shown) | `NEEDS_REVIEW` |
| Recorded, preview verdict `pass` | `ALLOW` |
| Refused before anything was recorded (`ForbiddenError` or `ActionError`) | `BLOCK`, outcome `refused` |

For every step: `accepted` if the call returned, `refused` if it threw a `ForbiddenError`,
`ActionError` or `ZodError`. Any other exception is a **runner error** for that scenario.

## What is measured, scenario by scenario (no averages hide anything)

| Measure | Definition | Severity |
|---|---|---|
| **False approval** | Expected `BLOCK`, actual `ALLOW` | **Critical** when the scenario's `severityIfWrong` is `critical` or its category is `unsafe_mapping` or `cross_brand_or_branch_conflict`; otherwise high |
| Under-block | Expected `BLOCK`, actual `NEEDS_REVIEW` (a person is warned but may approve) | High |
| Missed review | Expected `NEEDS_REVIEW`, actual `ALLOW` | High |
| False block | Expected `ALLOW` or `NEEDS_REVIEW`, actual `BLOCK` | Medium (high if the scenario says so) |
| Over-review | Expected `ALLOW`, actual `NEEDS_REVIEW` | Low |
| Unsupported mismatch | Expected `UNSUPPORTED`, actual anything else; or the reverse | Medium |
| **Accepted when it must be refused** | A step expected `refused` returned | **Critical** for `approve`, `release`, `monitor`, `remap`-type steps and any step by an actor without the permission; high otherwise |
| False refusal | A step expected `accepted` was refused | Medium |
| **Invariant violation** | Any FI- check below fails | **Critical** |
| **Wrong live mapping** | `expectFinal.mapping` differs from the database at the end, and the actual branch is not null | **Critical** (money sits at a branch nobody intended) |
| Status mismatch | `expect.status` or `expectFinal.statuses` differs | Medium |
| Correct human review | Expected and actual both `NEEDS_REVIEW` | (counted) |

## Invariants the runner measures around every non-world step

| Id | Measured as |
|---|---|
| FI-1 | `sum(ad_spend_daily.cost_cents)` is the same before and after the step |
| FI-2 | After an accepted release: the proposed branch's paid spend (Sep 1 – Oct 30) rose by exactly the campaign's media spend in the window, and the previous branch fell by exactly that |
| FI-3 | After an accepted release: no branch outside {previous, proposed, branches where the campaign's leads arrive} changed any scorecard field |
| FI-4 | After a refused step, and after every preview (`propose`, `resubmit`, `rerun_preflight`): `campaign_branch_map`, every branch's scorecard and `raw_events` are unchanged |
| FI-6 | Company collected revenue and company customers acquired are unchanged by every non-world step |

FI-5 (brand totals) follows from the scorecard and is covered by the existing domain-model tests;
the runner does not re-measure it.

## Evidence

For every actual decision the report keeps: the preview verdict, every `fail` / `warn` check with its
code and detail, the refusal message for refused steps, and the verification checks of releases
and monitoring runs. A `BLOCK` or `NEEDS_REVIEW` without at least one `fail` / `warn` check carrying
a non-empty detail, or a refusal with an empty message, is reported as **unexplained**.

## What counts as invalid

A scenario the runner cannot execute as written (an unknown step type or field, a reference to an
undefined key) is reported as **invalid**, listed with the reason, and excluded from the rates. It
is never edited.

## Amendments made before the first run

Made after reading the scenario author's reply (its stated interpretations), **before any scenario
was run** and without looking at any result:

- **A1.** When a proposal is expected to be `refused` (the wrong actor proposes) and the system
  refuses it, the refusal is what is scored. The author labelled such steps with the class of the
  mapping itself (e.g. `ALLOW`), so the class is not compared. If the system accepts the proposal,
  the class is compared as usual and the acceptance is scored as "accepted when it must be refused".
- **A2.** One monotonic step clock. On a world step, `day` is a data date (a lead's day, the restated
  spend date, the refund date), not the time the step runs. A world step runs one minute after the
  step before it; a change step with `day` runs at 16:00 on that day if that is later. (The first
  draft used a world step's `day` as its clock, which would have made an Oct 5 restatement look
  older than the original delivery.)

## First contact is kept

The first complete run is written to `evidence/first-contact.json` and committed unchanged. Fixes
made afterwards are measured by re-running the same file; the second result is reported **as
"after fixes, no longer held out"**, next to the first.
