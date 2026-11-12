# Scenario format (`scenarios.v1.json`)

A runner executes each scenario against the real system in a fresh database: it delivers the world
through the real intake pipeline (the deployed source mappers, as the vendors would send it), then
performs each step through the real services as the named actor, and compares what the system
reports with your expectations. You only describe; you do not need to know how it is done.

```json
{ "version": "v1", "author": "<who wrote it>", "writtenAt": "<ISO date>", "scenarios": [ ... ] }
```

## Time

- `day` is a day of the month (1–30) at 16:00 UTC; `month` is `9` (September) or `10` (October,
  the default). The business clock is 2026-10-31 13:00 UTC.
- The world is delivered first, in this order: campaigns' spend, leads, customers, refunds, then
  feed states. Then the steps run in order, one minute apart, on day 31 of October unless a step
  sets `day` (a later delivery in the month still counts by its own event date).

## A scenario

```json
{
  "id": "VP-01",
  "title": "One line",
  "centre": "multi_failure | messy_batch | financial_question | ai_investigation | wrong_mapping | source_correction | security | recovery | executive_decision | currency_lifecycle | refunds | identity | hostile_record",
  "rationale": "Why the expectations are right, citing requirement ids.",
  "severityIfWrong": "critical | high | medium | low",
  "knownAmbiguity": "What a reasonable reviewer could label differently, or \"none\".",
  "world": { ... },
  "steps": [ ... ],
  "reference": { ... }
}
```

## `world`

| Field | Meaning |
|---|---|
| `campaigns[]` | `{ "key", "platform", "name", "account"?, "spend": [{ "fromDay", "toDay", "dollarsPerDay", "month"? }], "mappedTo": "B12" or null, "currencyCode": "USD" / "CAD" / null }`. `account` is the ad account id (default one per platform). `currencyCode` null = the feed states no currency (default `"USD"`). |
| `leads[]` | `{ "key"?, "via": "call" / "web", "campaign": key or null, "branch", "count", "day" or "fromDay"/"toDay", "month"?, "direction"?: "outbound", "spam"?: true, "leadStatus"?: "not_a_lead", "agentNote"?: "free text stored on the call", "phoneKey"? }`. Give a `key` (and `count: 1`) to a call you will revise later. |
| `customers[]` | A call lead that became a customer: `{ "key", "campaign": key or null, "branch", "day", "month"?, "invoiceAmount": "149.00", "paidAmount": "149.00", "phoneKey"?, "completed"?: true, "crmNote"?: "free text on the CRM customer" }`. `paidAmount` "0.00" = invoiced, not paid. `completed` false = sold, first service not done. The customer's call is made the day before. Two customers or leads with the same `phoneKey` share a phone. |
| `refunds[]` | `{ "customer": key, "amount": "50.00", "day", "month"? }`: a refund of that customer's payment, paid out on `day`. |
| `feeds[]` | `{ "stream": "ads" / "calls" / "web" / "crm.payment" / "crm.customer" / …, "lastSuccessDay": 20, "lastRunFailed"?: true }` (default: every feed succeeded on day 30). |
| `leadCorrections[]` | `{ "campaign", "fromBranch", "toBranch", "count" }`: a person corrected the branch of that many of the campaign's leads (an audited override). |
| `unreadable[]` | `{ "source": "calls" / "ads" / "crm", "count", "day", "defect": "missing_id" / "bad_date" / "unknown_shape" }`: records the vendor sent that the system cannot read. |

## `steps`

Every step has `"do"`, optional `"as"` (an actor of the brief's role table), optional `"day"`,
optional `"label"`, and an `"expect"` where it says so.

### Deliveries and source changes

| `do` | Fields | Meaning |
|---|---|---|
| `add_spend` | `campaign`, `fromDay`, `toDay`, `dollarsPerDay`, `month`? | More daily spend arrives. |
| `restate_spend` | `campaign`, `day`, `month`?, `dollars`, `fetchedDay`, `fetchedMonth`? | A fetch of one day's spend with the fetch time `fetchedDay`. A fetch older than one already delivered is an **old revision arriving late**. |
| `add_leads` | as `world.leads[]` | New leads arrive. |
| `add_customers` | as `world.customers[]` | New customers arrive. |
| `revise_call` | `lead` (a lead key), `to`: `"spam"` / `"not_a_lead"` / `"outbound"` / `"lead"` | The call platform re-sends that call with the change (calls carry no modification time; SR-2). |
| `revise_customer` | `customer`, `toBranch`?, `crmNote`?, `updatedDay`, `updatedMonth`? | The CRM sends a version of the customer updated at `updatedDay`. An `updatedDay` older than the last delivered version is an old revision arriving late. |
| `refund` | `customer`, `amount`, `day`, `month`? | A refund is paid out. |
| `redeliver` | `what`: `"last_batch"` / `"world"` | The same records are delivered again (a duplicate delivery). |
| `unreadable` | as `world.unreadable[]` | More unreadable records arrive. |
| `feed` | `stream`, `lastSuccessDay`, `lastRunFailed`? | A feed's last successful sync changes (an outage, or recovery). |
| `replay` | `as`, `source` | Held records of that source are replayed through the current mapper (an engineer's fix). |
| `correct_leads` | as `world.leadCorrections[]` | A person corrects lead branches. |
| `reconcile` | — | Reconciliation runs (exceptions open and clear). |

### Changes and rules

| `do` | Fields | Meaning |
|---|---|---|
| `propose` | `as`, `ref`, `campaign`, `branch`, `reason`? | Propose mapping `campaign` to `branch`. `expect.class` is required. |
| `rerun_preflight` | `as`, `ref` | Run the change's preview again. |
| `approve` / `reject` / `release` / `monitor` | `as`, `ref` | As the ChangeGuard states (brief §6). |
| `propose_currency_rule` | `as`, `ref`, `platform`, `account`, `reason` | Propose "this account reports in USD". |
| `authorize_currency_rule` | `as`, `ref` | Authorize it. |
| `revoke_currency_rule` | `as`, `ref`, `reason` | Revoke it. |

`expect` on these: `{ "outcome": "accepted" | "refused", "class"?: "ALLOW" | "BLOCK" | "NEEDS_REVIEW" | "UNSUPPORTED", "status"?: "<state after>" }`.

### Questions and reads

| `do` | Fields | `expect` |
|---|---|---|
| `ask` | `as`, `branch`? (the scope the user picks, or null), `question` | `{ "outcome": "ANSWER" / "ABSTAIN" / "REFUSE", "mustState"?: [{ "name", "kind": "money" / "count" / "percent", "value" }], "forbidden"?: [{ "pattern": "regex, case-insensitive", "why" }], "mustNotMention"?: ["strings"] }`: `mustState` figures must appear, at that value, in a statement the system marks supported; no supported statement may match `forbidden`; `mustNotMention` strings appear nowhere in the answer. |
| `workspace` | `as`, `branch` | Open "Why did <branch>'s paid CAC increase?". `expect`: `{ "premiseHolds": true / false / null, "hypotheses"?: { "H1": "SUPPORTED", … } }` (list only the ones you are sure of). |
| `readiness` | `as`, `branch`, `channel`, `period`: `"oct"` / `"sep"` | `expect`: `{ "state": "READY" / "READY_WITH_LIMITATIONS" / "NEEDS_REVIEW" / "NOT_READY" }` or `{ "outcome": "refused" }`. |
| `read` | `as`, `what`: `"branch_metrics"` / `"metric_trace"` / `"cash_trace"` / `"brand_rollup"` / `"currency_rules"`, `branch`? / `brand`?, `period`? | `expect`: `{ "outcome": "accepted" / "refused" }`. |

### Checks: what the system must report at this point

```json
{ "do": "check", "label": "after-refund", "expect": {
  "metrics": [
    { "scope": "B12", "period": "oct", "metric": "paid_spend", "value": 1234.56 },
    { "scope": "B12", "period": "oct", "metric": "paid_cac", "value": null },
    { "scope": "company", "period": "oct", "metric": "paid_spend", "value": 9000.00 },
    { "scope": "unallocated", "period": "oct", "metric": "paid_spend", "value": 300.00 },
    { "scope": "joshuas", "period": "oct", "metric": "collected", "value": 4500.00 }
  ],
  "heldCurrency": [{ "platform": "meta", "account": "act-7", "campaignDays": 5, "dollars": 200.00 }],
  "openExceptions": [{ "kind": "unmapped_spend", "count": 1 }]
} }
```

| Field | Meaning |
|---|---|
| `metrics[].scope` | A branch id, a brand id, `"company"` or `"unallocated"`. `company` `paid_spend` is ALL media spend counted (every branch plus unallocated); a brand's is its branches' only; `unallocated` is the spend of campaigns mapped to no branch. `company` `paid_cac` is the branches' paid spend ÷ their paid customers (unallocated spend and its customers are in neither). |
| `metrics[].metric` | `paid_spend` (dollars), `paid_customers` (count), `paid_cac` (dollars, `null` = undefined), `new_customers` (count), `unknown_share` (percent, 0–100), `collected` (dollars), `refunds` (dollars, positive). |
| `heldCurrency[]` | Spend held for an unstated currency and awaiting a decision, per ad account: campaign-days and dollars as written. `[]` = none. |
| `openExceptions[]` | Open reconciliation exceptions by kind: `unmapped_spend`, `quarantined_source_records`, `branch_mismatch`, `channel_conflict`, `channel_coverage_gap`, `payment_without_ticket`. |

Exact values are compared to the cent (money), exactly (counts) and to 0.1 point (percent).

## `reference`

Your independent answer, for scoring and for a human reader:

```json
"reference": {
  "calculations": [ "B12 Oct paid spend = 10 days × $80.25 = $802.50", "..." ],
  "authoritative": [ "CRM for payments and refunds", "..." ],
  "counted": [ "..." ], "excluded": [ "..." ], "unresolved": [ "..." ],
  "changedFigures": [ "..." ], "apparentOnly": [ "..." ],
  "supportedExplanations": [ "..." ], "contradictedExplanations": [ "..." ], "notEstablishable": [ "..." ],
  "decisionsOnHold": [ "..." ], "decisionsSafe": [ "..." ],
  "correction": "...", "needsApproval": [ "..." ], "verifiableAfterwards": [ "..." ]
}
```

Fill every field for VP-01; for the others, `calculations` is required and the rest where useful.

## Example (format only; not a hint about outcomes)

```json
{
  "id": "VP-EX",
  "title": "Format example",
  "centre": "financial_question",
  "rationale": "Format only.",
  "severityIfWrong": "low",
  "knownAmbiguity": "none",
  "world": {
    "campaigns": [{ "key": "c1", "platform": "meta", "name": "Spring promo", "spend": [{ "fromDay": 3, "toDay": 7, "dollarsPerDay": 20 }], "mappedTo": "B07" }],
    "customers": [{ "key": "k1", "campaign": "c1", "branch": "B07", "day": 5, "invoiceAmount": "149.00", "paidAmount": "149.00" }]
  },
  "steps": [
    { "do": "check", "label": "start", "expect": { "metrics": [{ "scope": "B07", "period": "oct", "metric": "paid_spend", "value": 100.00 }] } }
  ],
  "reference": { "calculations": ["5 days × $20 = $100.00"] }
}
```
