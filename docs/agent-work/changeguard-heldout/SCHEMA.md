# Scenario format (`scenarios.v1.json`)

A runner executes each scenario against the real system: it builds the world through the real
intake pipeline (the deployed source mappers), then performs each step through the real service
calls, as the named actor. You only describe; you do not need to know how it is done.

The file is one JSON object:

```json
{ "version": "v1", "author": "<who wrote it>", "writtenAt": "<ISO date>", "scenarios": [ ... ] }
```

## Time

- Every `day` is a day of **October 2026** (1–30). Events happen at 16:00 UTC on their day.
- The **world history** uses days 1–24.
- **Steps** happen on day 25 by default (in order, one minute apart). A step may set its own `"day"`.
- Anything that should arrive **after** a step (new leads after a release, a refund after an approval)
  is a mutation step with a later day (26–30).
- The reporting window is Sep 1 – Oct 30, 2026.

## A scenario

```json
{
  "id": "HO-01",
  "category": "unsafe_mapping",
  "title": "One line",
  "rationale": "Why the expected outcome is right, citing BR-/FI- ids.",
  "severityIfWrong": "critical | high | medium | low",
  "world": { ... },
  "steps": [ ... ],
  "expectFinal": { ... }
}
```

`category` is one of: `unsafe_mapping`, `valid_mapping`, `sparse_or_contradictory_evidence`,
`cross_brand_or_branch_conflict`, `historical_mapping_effect`, `benign_schema_drift`,
`refunds_and_source_corrections`, `evidence_changed_after_preflight`, `concurrency`,
`unauthorized_action`, `monitoring_and_recovery`, `human_review_only`. (Pick the main one.)

## `world`: what exists before the first step

```json
{
  "campaigns": [
    {
      "key": "c1",
      "platform": "google_ads",
      "name": "B12 | Search | Termite",
      "spend": [{ "fromDay": 1, "toDay": 10, "dollarsPerDay": 80.25 }],
      "mappedTo": "B12"
    }
  ],
  "leads": [
    { "via": "call", "campaign": "c1", "branch": "B12", "count": 6, "fromDay": 2, "toDay": 9 }
  ],
  "customers": [
    { "key": "k1", "campaign": "c1", "branch": "B12", "day": 4, "amount": "149.00" }
  ],
  "lineage": [{ "predecessor": "c0", "successor": "c1", "day": 12 }],
  "leadCorrections": [{ "campaign": "c1", "fromBranch": "B12", "toBranch": "B13", "count": 2 }]
}
```

| Field | Meaning |
|---|---|
| `campaigns[].key` | Your local name for the campaign, used everywhere else in the scenario. The runner makes the real ad-platform id unique per scenario. |
| `campaigns[].platform` | `google_ads`, `google_lsa`, `microsoft_ads` or `meta`. |
| `campaigns[].name` | The campaign's name on the ad platform. |
| `campaigns[].spend` | Daily media spend, delivered by the ad platform's daily spend feed (dollars with up to 2 decimals). |
| `campaigns[].mappedTo` | The branch it maps to before the scenario starts, or `null` (unmapped). |
| `leads[]` | `count` leads, spread over `fromDay`..`toDay` (or one `day`). `via`: `call` (call tracking) or `web` (website form). `campaign`: the campaign key the lead carries, or `null` for no campaign id. `branch`: the branch the lead arrived at. |
| `customers[]` | A call lead that became a paid customer: customer, subscription, completed first service, invoice, payment of `amount`, all at `branch`. `campaign` is the key the call carried (or `null`). |
| `lineage[]` | The system has recorded that campaign `predecessor` was replaced by `successor`. |
| `leadCorrections[]` | A person has corrected the branch of `count` of the campaign's leads from `fromBranch` to `toBranch` (an audited human override). |

Omit any list you do not need.

## `steps`: what happens, in order

Every step has `"do"`, optionally `"as"` (an actor from the brief's role table), optionally
`"day"`, and `"expect"`.

### Changes

| `do` | Fields | Meaning |
|---|---|---|
| `propose` | `as`, `ref`, `campaign`, `branch`, optional `reason`, optional `payloadExtra` | Propose mapping campaign `campaign` to `branch`. `ref` names the change for later steps. `branch` may be any string (e.g. `"B99"`). `campaign` may be `"unknown"` (an id that does not exist). `payloadExtra` adds fields to the request (e.g. `{"effectiveFrom": "2026-10-15"}`) to ask for something the product may not model. |
| `propose_kind` | `as`, `ref`, `kind`, `payload` | Propose a change of another kind (e.g. `"lead_routing"`, `"reporting_definition"`), with any payload. |
| `resubmit` | `as`, `ref`, `supersedes`, `campaign`, `branch` | A corrected resubmission of change `supersedes`. |
| `propose_source_contract` | `as`, `ref`, `source`, `entity`, `samples` | Sample payloads of a changed upstream shape. `source`: `calls`, `web`, `ads`, `crm`, `d2d`. `entity`: e.g. `call`, `lead`, `spend_day`, `customer`, `payment`. `samples`: 1–50 raw payload objects in the vendor's shape (see the source mappers and `VENDOR-CONTRACTS.md`). |
| `rerun_preflight` | `as`, `ref` | Run the change's preview again. |
| `approve` | `as`, `ref`, optional `hashesFrom` | Approve change `ref`, presenting what the approver reviewed. With `hashesFrom: "<other ref>"`, the approver presents the other change's reviewed identity instead (a mix-up or a swap). |
| `reject` | `as`, `ref` | Reject change `ref`. |
| `release` | `as`, `ref` | Release change `ref`. |
| `monitor` | `as`, `ref` | Run post-release monitoring on change `ref`. |

### World changes between steps

| `do` | Fields | Meaning |
|---|---|---|
| `add_leads` | same fields as a `world.leads[]` item | New leads arrive. |
| `add_customers` | same fields as a `world.customers[]` item | New paid customers. |
| `add_spend` | `campaign`, `fromDay`, `toDay`, `dollarsPerDay` | More daily spend arrives. |
| `restate_spend` | `campaign`, `day`, `dollars` | The ad platform restates one day's spend (a later delivery of the same day with a new amount). |
| `correct_leads` | same fields as a `world.leadCorrections[]` item | A person corrects lead branches. |
| `refund` | `customer`, `amount`, `day` | A partial (or full) refund of that customer's payment, from the CRM. |
| `crm_move_customer` | `customer`, `toBranch`, `day` | The CRM re-delivers the customer record with a different office (branch). |
| `remap_outside` | `as`, `campaign`, `branch` | Someone changes the live mapping through the other, older write path (not this tool), e.g. an incident fix. |
| `reconcile` | — | Reconciliation runs (exceptions open and clear). |
| `concurrently` | `steps: [step, step, ...]` | Run these steps at the same moment. Each keeps its own `expect`; use `"outcome": "either"` when exactly-one-of semantics matter and say so in `expectFinal.notes`. |

### `expect` on a step

```json
{ "outcome": "accepted | refused | either", "class": "ALLOW | BLOCK | NEEDS_REVIEW | UNSUPPORTED", "status": "ready_for_review" }
```

- `outcome`: whether the system should accept the action or refuse it.
- `class`: **required** on `propose`, `propose_kind`, `resubmit`, `propose_source_contract`, and
  optional on `rerun_preflight`: your label for the proposed change (brief §7). A change the system
  refuses at the preview is `BLOCK` with `outcome: "accepted"` (the proposal was recorded, then
  failed its preview); a request the system cannot represent at all is `UNSUPPORTED`.
- `status` (optional): the change's status right after the step, from the brief's state list.
- World-change steps need no `expect`.

## `expectFinal`

```json
{
  "mapping": { "c1": "B13", "c2": null },
  "statuses": { "ch1": "verified", "ch2": "superseded" },
  "invariants": ["FI-1", "FI-3", "FI-4"],
  "exactlyOneOf": [["ch1-release", "ch2-release"]],
  "notes": "anything the runner should know"
}
```

- `mapping`: the live mapping of each listed campaign at the end (`null` = unmapped).
- `statuses`: each change's final status.
- `invariants`: the FI- ids that must hold throughout (brief §4).
- `exactlyOneOf`: for concurrency, lists of step labels of which exactly one must be accepted. Give a
  step a label with `"label": "ch1-release"`.

## Example (format only; not a hint about outcomes)

```json
{
  "id": "HO-EXAMPLE",
  "category": "valid_mapping",
  "title": "Format example",
  "rationale": "Format example only.",
  "severityIfWrong": "low",
  "world": {
    "campaigns": [{ "key": "c1", "platform": "meta", "name": "Spring promo", "spend": [{ "fromDay": 3, "toDay": 7, "dollarsPerDay": 20 }], "mappedTo": null }],
    "leads": [{ "via": "web", "campaign": "c1", "branch": "B07", "count": 3, "fromDay": 4, "toDay": 6 }]
  },
  "steps": [
    { "do": "propose", "as": "marketing", "ref": "ch1", "campaign": "c1", "branch": "B07", "expect": { "outcome": "accepted", "class": "ALLOW" } },
    { "do": "approve", "as": "approver", "ref": "ch1", "expect": { "outcome": "accepted", "status": "approved" } }
  ],
  "expectFinal": { "mapping": { "c1": null }, "invariants": ["FI-1", "FI-4"] }
}
```
