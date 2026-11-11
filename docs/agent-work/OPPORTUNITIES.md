# Revenue opportunities: missed follow-up and retention before the first service

Page: **Decision Lab → Revenue opportunities** (`/decisions/opportunities`).
Code: `lib/opportunities/` (journeys, readiness policy, overrides), `app/api/opportunities`.
Tests: `tests/unit/opportunity-readiness.test.ts` (9), `tests/integration/opportunities.test.ts`
(7, on a fixture whose answers are known by construction), `tests/e2e/z-opportunities.spec.ts`
(2).

## The rule: every sentence says what it is

| Label | What it is | Example |
|---|---|---|
| **Observed fact** | counted from stored records, with its definition | "1,193 repeat-contact prospects did not become customers" |
| **Inference** | arithmetic on facts under a stated assumption | "if they converted at the single-contact rate, about $251k a year" |
| **Hypothesis** | a possible cause the data does not show | "some repeat contacts were never called back" |
| **Recommendation** | the next step, usually a validation | "check the outbound call log for 25 of them" |
| **Measured outcome** | an intervention measured against a control | "None. No follow-up intervention has been run." |

The measured-outcome slot is never left empty. It says "None" until an experiment or a pilot
with a control has run.

## Journey B: missed follow-up

- **Unit:** a prospect's first call or web lead in the period (one per phone hash), with its
  14-day outcome window closed.
- **Repeat contact:** the same phone called or sent a form again within 7 days.
- **Converted:** a first subscription sold to that phone within [lead − 2 h, lead + 14 days].
- **Comparison:** conversion after one contact vs after a repeat contact. The hypothesis
  predicts repeat contacts convert **less**.

**On the seeded world (Sep–Oct, all branches):** 11,497 prospects. 2,012 repeat contacts, of
which 1,193 did not convert. Conversion was 38.4% after one contact and 40.7% after a repeat
contact: +2.3 points, 95% interval −0.1 to +4.7. **The data does not support the hypothesis.**
Repeat contacts are, if anything, more interested prospects.

That is the honest answer for this synthetic world. It is also why the hypothesis needs the
outbound call log: the data here cannot show a callback that never happened.

## Journey C: lost before the first service

- **Unit:** a subscription sold in the period whose first initial visit is due by now.
- **Lost:** cancelled, with no initial visit completed.
- **Comparison:** first visit within 3 days of the sale vs later. The hypothesis predicts
  longer waits lose **more**.

**On the seeded world:** 7,920 subscriptions; 447 lost before service ($241,920 of annual
contract value). 5.1% were lost with a visit within 3 days and 5.9% after a longer wait: +0.8
points, interval −0.2 to +1.8. **Not supported**, so the value at stake counts as $0. The
simulation cancels at random, so that is the expected answer, and the journey finds it.

## Decision readiness policy

| Check | Rule | Overridable? |
|---|---|---|
| Freshness | every feed the journey reads delivered within 36 h (the platform's stale rule) | **never** |
| Data quality | no open `channel_coverage_gap` or `quarantined_source_records` exception in scope. `unmapped_spend` is excluded: these journeys read no spend | **never** |
| Sample | the smaller comparison arm has ≥ 30 units | yes |
| Materiality | value at stake ≥ $10,000 a year | yes |
| Pattern | the 95% interval excludes zero in the hypothesised direction | yes |
| Outcome | a measured outcome of an intervention exists | yes |

Levels: **blocked** (freshness, data quality or sample fails), then **monitor** (immaterial or
unsupported), then **validate** (material and supported, nothing measured yet), then **act**
(measured).

**An observational pattern can never reach "act" on its own.**

**Override:**
- Needs the `approve` permission and a reason of at least 20 characters.
- Raises the level by exactly one step.
- The server recomputes the assessment; the client's view of the level is never trusted.
- Stored append-only in `opportunity_overrides` (migration 0016, trigger-enforced). The row
  holds the person's subject, the accepted risks and the assessment at that moment.
- Audited as `override_opportunity_readiness`.
- An override applies only while the data still assesses at the level it was recorded against.
  If the data changes, the override lapses.

On the seeded world, all-branch readiness is **blocked**: two open data-quality exceptions (the
demo's own incidents). This is correct, and it cannot be overridden.

## What would make these journeys decision-grade

| Gap | Effect | Source |
|---|---|---|
| No outbound call or CRM task log | Missed follow-up stays a hypothesis | CallRail `direction = outbound` (VENDOR-CONTRACTS.md C-3a), FieldRoutes tasks |
| No lead qualification | Spam and not-a-lead calls inflate the denominator | CallRail `spam`, `lead_status` (calls@1.2 refuses them; exclusion is not built) |
| No cancellation reasons | Retention causes cannot be separated | CRM cancellation reason codes |
| Retention after the first service is not simulated | Journey C covers pre-service loss only | — |
| No intervention has been run | No measured outcome exists | A randomised callback-SLA or slot-offer pilot |
