# Financial evidence graph 2.0

The paid-CAC trace (`lib/lineage/trace.ts`) showed a figure together with the records that make it,
reproduced to the cent. This milestone adds the same treatment for cash, attribution and brands. It
also closes three money defects that the held-out investigator set found:

| Defect | Cases |
|---|---|
| P6: customers credited to a campaign whose spend was held still counted in the CAC denominator | IV-24, IV-26 |
| P7: a figure on spend of unstated currency could be certified | IV-25 |
| Unstated currency was summed as dollars | IR-8 |

## Unstated currency is not dollars

**Before.** Spend whose feed stated no currency was stored as `assumed_usd` and summed as dollars.
The trace noted that the currency was assumed. The scorecard and every figure still counted the
spend.

**Now** (`lib/currency/`, migration `0020_currency_rules.sql`):

- **No rule, not counted.** A spend record without a stated currency counts only under an
  *authorized account rule*. Without one, its raw event is excluded at intake with code
  `CURRENCY_UNSTATED`. It appears in the trace's held records, in the ingestion failures, and in
  Integrations → Ingestion pipeline → *Ad account currency*, with its amount as written.
- **One gate.** The check sits inside `projectAll`, so intake, replay and re-projection all pass
  through it. No path can count unstated money as USD.
- **The newest record wins.** A newer revision of a campaign-day that drops its currency takes
  the older counted row out.
- **Two people.** An integration engineer proposes a rule with a reason. A different person with
  approval rights authorizes it; the database refuses proposer = authorizer. Authorizing
  re-projects the account's held records, stored as `account_rule_usd`, so a trace says *"USD by
  account rule"*. Revoking a rule excludes them again. Every step is audited.
- **Other currencies are unchanged.** Spend in another currency is still quarantined
  (`CURRENCY_UNSUPPORTED`) and never converted.
- **Historical rows.** The migration excludes rows stored as `assumed_usd`. Their raw events are
  kept, and they come back as soon as a rule covers their account. **This can lower a stored paid
  spend:** it was money nobody had established as dollars.
- **Seed and fixtures.**
  - The demo seed records one authorized rule per synthetic ad account (`demo:onboarding`,
    approved by `demo:approver`).
  - The test fixture (`freshDb`) records one company-wide rule, unless a test asks for none.
  - The held-out evaluation worlds run with no rule, because each case states its own currency.

## CAC definition v3

A paid customer credited to a campaign **whose spend was all held at intake** is out of the CAC
denominator, because its cost is in no figure. This is the same reasoning as v2, which excluded
campaigns mapped to no branch. The rule applies in the scorecard (`HELD_CAMPAIGNS` in
`lib/metrics/scorecard.ts`) and in the trace (exclusion `CAMPAIGN_SPEND_HELD`), so the trace still
reproduces the scorecard exactly.

**Completeness.** The figure is now right as stored, but it leaves a campaign out. That is
reported, not hidden:

- `getBranchMetrics` returns `paidAcquiredHeldOut`;
- the trace lists the exclusion;
- each typed fact carries an `incompleteReason`.

A model sentence that states such a figure plainly is PARTIALLY_SUPPORTED, with the reason. A
template states the held records in a sentence of its own.

## The money traces (`lib/lineage/cash.ts`)

Each trace runs in one repeatable-read snapshot and is checked against the scorecard to the cent.

| Trace | Reproduces | Invariants checked |
|---|---|---|
| `traceCash` | Collected cash (payments − refunds, by payment date, CRM office), gross, refunds, collections from the period's new customers, revenue in open exceptions | net = gross − refunds · amounts in whole cents · every refund names a stored payment · no payment refunded beyond its amount · each at-risk customer counted once |
| `traceAttribution` | New customers, unknown-channel customers, unknown share, coverage | channels partition the new customers · share + coverage = 100% |
| `rollupBrand` | A brand's totals from its branches; CAC from summed parts | the brand is exactly its branches · the brands partition the company, to the cent |

**For the investigator:**

- the `getCashTrace` tool gives collected, refunds, gross, new-customer collected and at-risk facts,
  each cited by payment ids;
- `getBrandMetrics` gives each branch of a brand as its own fact, and brand totals are proved as
  sums;
- a figure question about cash cites the payment records behind it.

## Reference cases

| File | What it covers |
|---|---|
| `tests/integration/currency-rules.test.ts` | Unstated currency excluded and listed; CAD quarantined; held-campaign customers out of the denominator; trace reproduces; propose → authorize (another person) → re-project → revoke → excluded again; a newer revision without a currency removes the older counted row |
| `tests/integration/cash-trace.test.ts` | A partial refund with odd cents; a refund in October for a September sale; a voided payment left out; new-customer collections to date; unknown share; brand rollups that partition the company |
| `tests/unit/ai-proof.test.ts` | Completeness: correct-as-stored figures that leave held records out |

## Not done

- **No page for the cash trace yet.** It is reachable through the investigator (`getCashTrace`),
  but the branch trace page still shows paid CAC and paid spend only.
- **Held spend is attributed to a branch only through its campaign's mapping.** A campaign whose
  spend is all held has no campaign row and cannot be mapped. Its spend is listed by ad account,
  not by branch. Its customers are still found, and taken out of the CAC, through the lead's
  campaign id.
