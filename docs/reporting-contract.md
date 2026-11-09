# Reporting contract (`reporting.*_v1`)

The published language this system offers to BI: Power BI or Microsoft Fabric (the company's
VERIFIED BI stack), or a pipeline that copies the views into the lake. SQL:
`database/migrations/0010_reporting_contract.sql`. Pinned by
`tests/integration/domain-model.test.ts` ("reporting contract"). ADR-19 says why.

## Rules

1. Read the `reporting` schema only. `public` is this system's internal model and changes freely.
2. Every view states its grain. Count `distinct prospect_key` for prospects, never rows.
3. Breaking change (column removed, renamed or retyped; grain changed) = a new `_v2` beside
   `_v1`. Adding a nullable column is not breaking.
4. No contact details: no phone or email hashes, no zip, no free text a customer typed.
5. Unknown stays unknown: no evidence = channel `unknown`; unmapped campaign = `branch_id` null.

## Views

| View | Grain | Notes |
|---|---|---|
| `dim_branch_v1` | branch | brand, region, time zone, CRM office |
| `dim_channel_v1` | channel | `measurement`: what evidence can show the channel's effect |
| `fact_ad_spend_daily_v1` | campaign × spend date | `classified_by` = mapper version behind `channel_code` (lineage); `branch_id` null = unallocated |
| `fact_leads_v1` | lead record | effective branch (after overrides), attribution evidence |
| `fact_acquisitions_v1` | acquired CRM customer | attribution basis, collected revenue to date |
| `fact_exceptions_v1` | exception (any status) | `decision_blocking` = puts a budget signal on hold |
| `contract_v1` | view | the contract listing itself |

## Measures in BI, matching the app

| App metric | From the contract |
|---|---|
| Paid spend | `sum(cost_cents)` from spend where `branch_id is not null`, joined to `dim_channel_v1` with `cost_basis = 'media'` |
| Unallocated spend | `sum(cost_cents)` where `branch_id is null` |
| Prospects | `count(distinct prospect_key)` from leads in the period |
| Acquired | rows of acquisitions with `initial_status = 'completed'` and `initial_completed_at` in the period |
| Paid CAC | paid spend ÷ acquired customers whose channel is paid media |
| Open exceptions | rows of exceptions with `status = 'open'` |

The test asserts the first, second, third, fourth and last rows equal the app's own numbers for
the same scope, so a dashboard built on this contract cannot quietly disagree with the product.

## In production (proposed)

The same views sit over lake tables instead of this Postgres, the definitions in
docs/metric-definitions.md become the semantic model's measures, and freshness comes from the
source streams' last successful run.
