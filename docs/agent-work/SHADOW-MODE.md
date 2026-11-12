# Shadow Mode and AI Answer Assurance: the contract

**What it does.** Another reporting system (synthetic here: "Atlas BI", a made-up name) publishes
metric snapshots and conversational answers. Shadow Mode checks each one against the product's
own versioned evidence and definitions and says, with proof references, whether it holds. It
never changes the other system or any authoritative record: a check reads, then stores only its
own result.

**What it does not do.** It does not produce answers, replace a BI tool, or imitate any real
product's internals. "Atlas BI" is synthetic, and so is everything it reports.

## 1. A metric snapshot (input)

```json
{
  "system": "atlas-bi",
  "datasetId": "marketing_daily",
  "asOf": "2026-10-30T06:00:00Z",
  "definition": {
    "id": "atlas.paid_cac", "version": "3",
    "family": "cac",
    "numerator": "paid_media_spend_mapped_to_branch",
    "population": "new_customers_first_serviced_paid_first_touch",
    "cashBasis": null,
    "periodBasis": "utc_day",
    "branchBasis": "campaign_mapping"
  },
  "scope": { "branch": "B12" },
  "period": { "from": "2026-10-01", "to": "2026-10-30" },
  "currency": "USD",
  "value": "237.00",
  "numerator": "4740.00",
  "denominator": 20
}
```

- `scope` is `{ "branch": "B12" }`, `{ "brand": "<brand id>" }` or `{ "company": true }`.
- `period.from` and `period.to` are calendar dates, both **inclusive**.
- `value`, `numerator` are decimal dollar strings for money, integers for counts.
  `numerator` and `denominator` are optional.
- `definition` is the other system's own description of what it computed, in the vocabulary below.
  A snapshot without it cannot be compared: nothing says what the number means.

### Definition vocabulary

| Attribute | Values |
|---|---|
| `family` | `cac`, `spend`, `customers`, `cash` |
| `numerator` (cac, spend) | `paid_media_spend_mapped_to_branch` · `all_media_spend` (paid and unallocated) · `paid_media_spend_by_lead_branch` |
| `population` (cac, customers) | `new_customers_first_serviced_paid_first_touch` · `new_customers_first_serviced` (any channel) · `customers_sold` (subscription created, service not required) |
| `cashBasis` (cash) | `payment_date_net_of_refunds` · `payment_date_gross` (refunds not subtracted) · `invoice_date` (invoiced, not collected) |
| `periodBasis` | `utc_day` · `office_local_day` |
| `branchBasis` | `campaign_mapping` (spend) · `crm_office` (customers, cash) · `lead_branch` |

### The product's own definitions in the same vocabulary

| Product metric | family | numerator / population / cashBasis | periodBasis | branchBasis |
|---|---|---|---|---|
| Paid-media CAC (v3) | cac | `paid_media_spend_mapped_to_branch` ÷ `new_customers_first_serviced_paid_first_touch` | `utc_day` | `campaign_mapping` (spend), `crm_office` (customers) |
| Paid media spend (v1) | spend | `paid_media_spend_mapped_to_branch` | `utc_day` | `campaign_mapping` |
| Paid customers | customers | `new_customers_first_serviced_paid_first_touch` | `utc_day` | `crm_office` |
| New customers serviced (v1) | customers | `new_customers_first_serviced` | `utc_day` | `crm_office` |
| Collected revenue (v1) | cash | `payment_date_net_of_refunds` | `utc_day` | `crm_office` |
| Gross payments | cash | `payment_date_gross` | `utc_day` | `crm_office` |

For `cac`, the snapshot's `branchBasis` is compared with the spend side (`campaign_mapping`).
For `company`, spend includes unallocated campaigns only under `all_media_spend`; the product's
company paid spend is every branch plus unallocated, and company CAC uses branch spend only
(as in the acceptance pack's `SCHEMA.md`).

## 2. Verdicts

Exactly one, decided in this order (the first that applies wins):

| Order | Verdict | When |
|---|---|---|
| — | *refused* | The viewer may not see the scope. Nothing about the scope is revealed. |
| 1 | `NOT_DETERMINABLE` | No `definition`, or one outside the vocabulary; an unknown branch or brand; `periodBasis` `office_local_day` (the product's figures are by UTC day and it does not recompute on office-local days); `to` before `from`; currency missing (`null`); a family the product has no metric for |
| 2 | `INCOMPATIBLE_DEFINITION` | The definition differs from the product's in any attribute, or the currency is not USD. **Not an error**: the two numbers measure different things. The product's value is shown for reference, labelled as not comparable, with every differing attribute |
| 3 | `INCOMPLETE_EVIDENCE` | Comparable, but the product's own evidence for this scope and window is incomplete for this metric: spend held for an unstated currency (cac, spend); the feed the metric reads is stale at check time (ads for spend; calls, web and CRM customers for customers; CRM payments for cash; both for cac); or the source has records it could not read whose event date is in the window. Shown even when the values agree: both could be missing the same records |
| 4 | `MATCH` | Comparable, complete, and the value agrees: money to the cent (the snapshot's value as written, the product's rounded half-up to the cent), counts exactly |
| 5 | `MISMATCH` | Comparable, complete, and the value differs |

Every verdict carries: the dimensions that disagree (from `definition.<attribute>`, `currency`,
`scope`, `period`, `evidence.<reason>`, `value`, `numerator`, `denominator`, `revision`), the
product's value and its definition version, proof references (the trace that reproduces the
product's value), the scope, the period as UTC instants, limitations, and a next step.

`revision`: records that change this metric's figure arrived after the snapshot's `asOf`. It is
added to a `MISMATCH` as the likely reason and to a `MATCH` as a note; it never changes the
verdict by itself.

## 3. A conversational answer (input)

```json
{
  "system": "atlas-bi",
  "asOf": "2026-10-30T06:00:00Z",
  "question": "Why did B12's paid CAC go up in October?",
  "answer": "B12's paid CAC rose to $237.00 in October, from $200.00 in September. That is because Meta spend doubled."
}
```

The answer is read sentence by sentence and clause by clause, the same way the investigator's
own claims are checked. Each **claim** (a piece that names a figure, a measure, a direction, a
status or a cause) gets one verdict:

| Claim verdict | When |
|---|---|
| `SUPPORTED` | Every figure, direction and status in it follows from the product's evidence for that branch, metric and period, and nothing in it went unread |
| `CONTRADICTED` | The evidence exists and says otherwise: a wrong value, sign, direction, branch, period or unit |
| `UNSUPPORTED` | Nothing contradicts it, but the evidence does not prove it: a cause ("because…"), a measure the product does not verify (invoiced, booked, pipeline), a period with no evidence, a figure the reader cannot place, or a currency that is not established |
| `OUT_OF_SCOPE` | It names a branch or brand the viewer may not see. It is not checked and nothing about that scope is revealed |

A piece that names no figure, measure, entity or direction ("Here is what I found.") is not a
claim and gets no verdict. The answer as a whole is `SUPPORTED` (every claim supported),
`NOT_SUPPORTED` (no claim supported) or `PARTLY_SUPPORTED`. Figures inside quoted names, notes
or identifiers are not claims about metrics. The checker answers only for September and October
2026 (the periods the product holds).

## 4. Storage and audit

A check stores its input, the input's sha256, the viewer, the business time, the verdicts and
the product's definition versions, append-only, with an audit row. It stores no copy of the
other system's data beyond the input it was given.
