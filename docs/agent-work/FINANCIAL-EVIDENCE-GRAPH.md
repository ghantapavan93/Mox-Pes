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

## After the financial review of 2026-11-12

An adversarial financial review found 15 defects, two on the headline CAC. Each fix has a
reproducer in `tests/integration/currency-rules.test.ts` or `cash-trace.test.ts`.

| # | Defect | Fix |
|---|---|---|
| 1 | **Critical.** A campaign counted as held only when it had no campaign row, but spend leaves the scorecard three ways that keep the row (the 0020 `assumed_usd` delete, a revoke, the gate removing an older row). Its customers stayed in the CAC: CAC too low, nothing flagged | Held spend is now read from the held raw events themselves, per campaign-day, wherever no counted row exists for that day (`HELD_SPEND` in `lib/metrics/scorecard.ts`) |
| 2 | Replay stamped gate-held records `projected`: money lost for good, every held list silent | `projectAll` reports what the gate held; replay, intake and re-projection never mark those projected |
| 3 | An older version counted after a newer one was held (same batch, late delivery, replay) | The gate drops a spend version older than any held version of the same campaign-day, in the batch or stored |
| 4 | A campaign with some days held: customers counted, part of the cost missing, no flag | `partlyHeldAcquired`: an incompleteness reason on the CAC facts, the `complete` readiness rule, and a high reliability signal |
| 5 | A spend trace stated "0 customers credited" per campaign | Only a CAC trace states a count; a spend trace states none |
| 6 | "Awaiting currency" summed every fetch of every campaign-day, and days already counted | Newest held version per campaign-day, and only days with no counted version |
| 7 | H4 could not see spend held for its currency | H4 reads it per month (below) |
| 8 | H1, H3 and H4 were supported by a cent of spend, an exception of any age, or a paused campaign | Materiality (10% of the change) and direction rules (`WORKSPACE-READINESS-SIGNALS.md`) |
| 9 | H1's per-campaign deltas wrong for a campaign with two channel rows | Summed per campaign over both months |
| 10 | The held-spend exclusion cited customers only, never the records that caused it | `CAMPAIGN_SPEND_HELD` now cites up to five of the held raw events |
| 11 | Revoke checked the campaign's first-seen account, not the record's | Revoke reads the account from each record's payload, as intake and authorize do |
| 12 | Decomposition shares from rounded CACs, one clamped | Unrounded parts; the shares add to exactly 100%, shown unclamped |
| 13 | Two cash invariants could never fail; over-refunds ignored the original's status | The company total is read independently from every successful payment; a refund against a voided payment is over; the tautology was removed |
| 14 | Platform ambiguity of campaign ids | Documented only: acquisitions carry no platform |
| 15 | A possible slow scan for held campaigns | One union over the excluded and quarantined ads events; measured in the final report |

The authorization review added: an advisory lock orders currency decisions against intake (an
ingest holds it shared from its start; authorize and revoke hold it exclusive), so a revoke can no
longer race an in-flight ingest into counting money under a revoked rule, nor an authorize miss a
record held by an ingest in flight (reproducer: "a revoke waits for an ads ingest in flight").
Rules name one account; wildcards are refused through the API.

## Not done

- **No page for the cash trace yet.** It is reachable through the investigator (`getCashTrace`),
  but the branch trace page still shows paid CAC and paid spend only.
- **Held spend is attributed to a branch only through its campaign's mapping.** A campaign whose
  spend is all held has no campaign row and cannot be mapped. Its spend is listed by ad account,
  not by branch. Its customers are still found, and taken out of the CAC, through the lead's
  campaign id.
