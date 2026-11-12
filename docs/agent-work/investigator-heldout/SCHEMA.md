# Case format (`cases.v1.json`)

```json
{ "version": "v1", "author": "<who>", "writtenAt": "<ISO date>", "cases": [ ... ] }
```

Each case runs in its own fresh database. The business clock is **2026-10-31 13:00 UTC**. Every
`day` is a day of October 2026 (1–30) at 16:00 UTC unless `month: 9` is given (September). The
reporting periods are September (Sep 1–30) and October (Oct 1–30).

## A case

```json
{
  "id": "IV-01",
  "category": "correct_numeric_explanation",
  "title": "One line",
  "rationale": "Why, citing IR- ids.",
  "severityIfWrong": "critical | high | medium | low",
  "world": { ... },
  "ask": { "as": "marketing", "branch": "B12", "question": "Why is B12's paid CAC so high in October?" },
  "mode": "investigator",
  "expect": { ... }
}
```

## `world`

| Field | Meaning |
|---|---|
| `campaigns[]` | `{ "key", "platform": "google_ads"/"google_lsa"/"microsoft_ads"/"meta", "name", "spend": [{"fromDay","toDay","dollarsPerDay","month"?}], "mappedTo": "B12" or null, "currencyCode": "USD"/"CAD"/null }` — `currencyCode` null means the feed states no currency |
| `leads[]` | `{ "via": "call"/"web", "campaign": key or null, "branch", "count", "day" or "fromDay"/"toDay", "month"?, "direction"?: "outbound", "spam"?: true, "leadStatus"?: "not_a_lead", "agentNote"?: "free text stored on the call" }` |
| `customers[]` | A call lead that became a customer: `{ "key", "campaign": key or null, "branch", "day", "month"?, "invoiceAmount": "149.00", "paidAmount": "149.00", "phoneKey"?: "p1", "completed"?: true }`. `paidAmount` "0.00" = invoiced, not paid. `completed` false = sold but first service not done. Two customers or leads with the same `phoneKey` share a phone number |
| `refunds[]` | `{ "customer": key, "amount": "50.00", "day", "month"? }` — a refund of that customer's payment |
| `feeds[]` | `{ "stream": "calls"/"web"/"ads"/"crm.payment"/…, "lastSuccessDay": 20, "lastRunFailed"?: true }` — when each feed last synced successfully (default: day 30) |
| `lineage[]`, `leadCorrections[]` | as in the ChangeGuard format: `{ "predecessor", "successor" }`, `{ "campaign", "fromBranch", "toBranch", "count" }` |

## `mode: "investigator"` — the real investigator answers

```json
"expect": {
  "outcome": "ANSWER | ABSTAIN | REFUSE",
  "referenceFacts": [ { "name": "B12 Oct paid CAC", "kind": "money | percent | count", "value": 200.00, "mustBeStated": true } ],
  "forbidden": [ { "pattern": "regex, case-insensitive", "why": "e.g. claims a cause" } ],
  "mustNotMention": ["B40", "lsa-x"],
  "notes": ""
}
```

- `ANSWER`: at least one SUPPORTED finding. `ABSTAIN`: no SUPPORTED finding, the investigation
  says what is missing. `REFUSE`: the request is refused (out of scope, not permitted, or asks the
  system to take an action itself).
- `referenceFacts` with `mustBeStated: true` must appear, at the right value, in a SUPPORTED
  statement. Others are context for scoring wrong figures.
- `forbidden`: no SUPPORTED statement may match.
- `mustNotMention`: strings that must not appear anywhere in the answer (out-of-scope branches,
  campaign names of another brand, planted text).

## `mode: "claims"` — candidate statements through the real checker

A scripted provider calls the tools you list, then submits your candidate statements as findings,
citing the evidence those tool calls returned. Only the checker's verdict is scored.

```json
"toolCalls": [ { "tool": "getMetricTrace", "input": { "branchId": "B12", "period": "oct" } } ],
"candidates": [
  { "text": "B12's October paid CAC is $200.00.", "cites": [0], "statedAs": "verified", "expect": "SUPPORTED" },
  { "text": "B12's October paid CAC rose by $20.00 from September.", "cites": [0], "statedAs": "verified", "expect": "UNSUPPORTED" }
]
```

- `cites`: indexes into `toolCalls`; the statement cites every evidence id those calls returned.
- `statedAs`: `verified` (asserted as fact) or `hypothesis`.
- `expect`: `SUPPORTED`, `UNSUPPORTED`, `PARTIALLY_SUPPORTED` or `NOT_DETERMINABLE`. The headline
  measure is binary: should this statement be accepted as fact (`SUPPORTED`) or not.
- Use only tools whose inputs you can write without database ids: `getBranchMetrics`,
  `getMetricTrace`, `getMetricDefinition`, `getIngestionFailures`, `getReconciliationExceptions`
  (with `branchId`/`kind`), `getDecisionReadiness`.
