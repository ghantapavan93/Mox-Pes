# Source of authority

No system owns every fact. Each fact has one system of record, and a copy of it elsewhere (an
export, a dashboard, an ad platform's own report) can disagree. A disagreement is evidence to
investigate, never permission to overwrite.

## Who owns what

| Fact | System of record | What Revenue Signal OS does with it | What a file upload may do |
|---|---|---|---|
| A call happened (time, caller, tracking number, source) | Call-tracking platform | Ingests by webhook (`/api/ingest/calls`); projects to `leads` | **Publish** missing calls after approval; never change a call the ledger has |
| A web form was submitted | Website event pipeline | Ingests by push (`/api/ingest/web`) | **Publish** missing leads after approval; never change one the ledger has |
| A door-to-door sale was signed | D2D app | Ingests by push | Not offered for upload |
| Customer, subscription, appointment, ticket, payment | CRM (FieldRoutes-style API) | Pulls with a connector (checkpoints, fencing, retries) | **Compare only.** The CRM API is authoritative; an export is a secondary copy |
| Ad cost, clicks, platform conversions per campaign-day | Each ad platform | Pulls spend; platform conversions are kept as the platform's **claim** | **Compare only** |
| Recognized revenue | Accounting (not connected) | Not modelled | Refused as a meaning for any field |
| Contracted annual plan value | CRM subscription | Stored as `annual_value_cents` (a promise, not cash) | Refused as cash |
| Which channel gets credit | **Rule** (`docs/metric-definitions.md`): first qualifying touch with evidence | Computed, versioned, explainable | Never imported |
| Whether a channel *caused* a sale | **Nobody, without an experiment** | Decision Lab separates attribution from causal claims | n/a |

## Money has many meanings

`lib/onboarding/targets.ts` `MONEY_MEANINGS`. A money column must be given exactly one, by a person.

| Meaning | Is it collected cash? | Example headers | Accepted as payment amount? |
|---|---|---|---|
| `collected_payment` | Yes, per payment (refunds negative) | Net Paid, Amount Paid, Amount Received | **Yes** (the only one) |
| `invoice_total` | No: billed, paid or not | Invoice Total, Total, Ticket Amount | No (`WRONG_MONEY_MEANING`) |
| `refund_adjusted_cash` | Yes, but aggregated over a period | Net Revenue | No (wrong grain) |
| `recognized_revenue` | No: an accounting treatment | Recognized Revenue | No |
| `contract_annual_value` | No: a promise | Contract Value, Annual Value | No |
| `gross_sales` | No: before cancellations and refunds | Gross Sales | No |
| `forecast_value` | No | Forecast, Budget | No |
| `lifetime_value` | No: an estimate | LTV | No |
| `ad_cost` | Spend, not revenue | Cost, Amount Spent | Only as ad cost |

Collected cash compares **successful** payments only, on both sides. A payment voided in the
file but successful in the ledger shows as a status difference **and** a cash difference.

## Comparison grain

The comparison is only made where definitions, grain, period and identity match:
- payments: one payment id → amount, status, customer, office, and paid time (or the
  office-local **day** when the export gives only a date);
- ad spend: one (platform, campaign id, day) → cost, clicks, platform conversions;
- calls and leads: one source id → branch, channel, time, campaign.

The decomposition always holds and is tested:
`file total = (file side of rows the ledger holds) + (rows the ledger lacks)`, and
`difference on shared rows = Σ per-row amount differences`. Ledger records inside the file's
scope that the file lacks are counted separately, never netted.
