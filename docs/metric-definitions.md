# Metric definitions

One definition per number, implemented once:
- attribution: `database/migrations/0002_attribution_views.sql` (`v_leads`, `v_acquisitions`, `v_customer_revenue`)
- metrics: `lib/metrics/scorecard.ts`
- short form shown in the UI: `lib/metrics/definitions.ts`

All periods are half-open `[from, to)` in **UTC**. Spend dates are calendar dates compared to the
period's UTC dates. Every connection runs with `TimeZone=UTC`, so no number depends on the database
server's zone (regression test F3). Branch-local month boundaries are a known limitation (see below).

## Entities

| Term | Definition |
|---|---|
| Lead record | One record from a capture system: a tracked call, a website lead event, a D2D sale signature. |
| Prospect | One phone hash, else one email hash. **Approximation:** no transitive merge (a person who calls from one number and emails from an unrelated address counts twice). |
| New customer | A CRM customer's **first** subscription. An existing customer adding a service (mosquito, insulation) is never an acquisition. |
| Acquired / serviced | The first subscription's initial service was completed. Sold-then-cancelled is not acquired. A rescheduled initial is superseded by its replacement. |
| Credited touch | The earliest lead record **with evidence** (`click_id`, `utm`, `tracking_number`, `lsa_lead`, `rep_signature`) within 60 days before the sale (+2 h clock tolerance), matched by hashed phone or email. A touch without evidence is used only when nothing better exists. |
| Unknown | No evidenced touch. A channel of its own; **never** reassigned to paid media. |
| Channel conflict | A paid touch came first, then a D2D rep signed. Credit stays first-touch; the sale is flagged so commission and media cost are not both treated as the reason. A person can acknowledge it. |
| Branch (revenue) | The CRM office that services the customer. |
| Branch (lead) | The capturing system's branch (website zip lookup, tracking number), unless a person overrides it with a reason. |
| Identity (Customer 360) | One person as identity resolution sees them: a CRM customer (anchor) plus every lead whose phone hash, else email hash, matches exactly that customer; or a prospect identity grouping unmatched leads by phone hash, else email hash. Links use the whole record history; **credit** still follows the 60-day first-evidenced-touch rule above, so a journey can show a linked lead that is not the credited touch. |
| Identity conflict | A lead whose hashes point at more than one CRM customer (or whose phone and email point at different ones). It stays unlinked until a reviewer decides; nothing is merged silently. |

## Metrics

| Metric | Formula | Decision it supports | How it misleads |
|---|---|---|---|
| Paid media spend | Σ cost of media campaigns **mapped** to the branch, by spend date | Budget by branch | Unmapped campaigns are excluded from every branch (shown as unallocated). D2D commission is not media spend. |
| Unique prospects | distinct prospect keys with a lead record in the period | Demand by branch/channel | See prospect approximation. |
| New customers serviced | count of acquisitions whose initial service completed in the period | Acquisition volume | Lags sales by days; the last week of a period is always light. |
| Paid-media CAC | paid media spend ÷ new customers serviced whose credited channel is paid **media** (cost basis `media`), excluding customers credited to a campaign no branch is mapped to (their cost is unallocated spend) | Channel/branch efficiency | **Period CAC**, not cohort: October spend vs October completions. Young periods look worse. **Branch keys differ:** spend follows the campaign's mapped (marketing) branch, customers follow the CRM office that services them. A customer sold by one branch's campaign and serviced by another moves cost and customer to different rows (8 such customers in the October seed, all serviced at B07 from B06's campaigns; counted in UTC on 2026-11-17). Known limitation, not yet resolved: which branch owns CAC is a business decision (audit 2026-11-09, D-2). **Not computed (—)** where paid customers have no paid spend counted in the scope (v4, 2026-11-17): a servicing branch whose only paid customers came from another branch's campaign read **$0.00**, the cheapest figure in the company; the branch page says "no spend mapped here" and the trace says why. |
| Unattributed share | serviced new customers with channel `unknown` ÷ all serviced new customers | Measurement health | A jump usually means broken capture or linkage, not changed behaviour — the seeded incident shows exactly this. |
| Collected revenue | Σ successful payments − refunds (negative rows), by payment date, in the CRM office's branch | Cash by branch | Includes the existing base. Booked contract value and invoice totals are never revenue. |
| Collected from new customers | Σ successful payments − refunds, to date, from customers serviced in the period | Early payback | Young customers have paid little so far. |
| Booked annual value | Σ annual contract value of active first subscriptions | Bidding value, pipeline | **Booked, not revenue**; always labelled so. |
| Revenue in open exceptions | Σ collected revenue of **distinct** customers referenced by open exceptions | How much revenue has unsettled credit: **untied** (held records, payments without a ticket, conflicting payloads) vs **credit disputed** (branch mismatch, D2D / paid conflict — tied, but contested) | It is not lost revenue. Disputed credit is a policy question, not missing data. Unmapped spend is reported separately. |
| Channel spend | Σ cost of spend records by the channel **each record was classified into** by its mapper version | Channel budget | A platform re-typing a campaign moves spend between channels silently; see the coverage-gap rule |
| Budget signal (illustrative) | the most expensive paid channel at a branch costs ≥ 1.5× the cheapest per new customer serviced (each ≥ 5 customers), over the channels the **decision boundary** (below) lets it compare: branch-wide when every covered channel is compared, "among verified channels" when some are left out (each named, with its reason), behind the gate when an open incident's reach cannot be narrowed to channels. A channel with no CAC never takes part (paid-media CAC v4) | Whether to shift budget between channels | Shown with its blockers; "not trustworthy yet" while a coverage gap or held records are open at the branch, or an unmapped campaign produced customers the branch serviced in a compared channel (unmapped spend has no branch of its own, so it blocks where its customers are). The raw ratio over every channel with a CAC is kept as data and never shown as a comparison or a recommendation |
| Decision readiness | per paid channel at a branch: integrity passes, no open decision-blocking incident at the branch (coverage gap, held records, unmapped spend), its own cost evidence holds (none of its spend held at intake, no customer from an unmapped campaign, its customers not all from another branch's campaigns, spend recorded; 2026-11-17), ≥ 5 serviced customers, spend and CRM feeds fresh (≤ 36 h) | Whether this channel's numbers can carry a budget move | Readiness is not effectiveness: a ready channel can still be ineffective; only a randomized experiment measures that |
| Budget decisions on hold (Overview) | open decision-blocking exceptions in scope, most severe first; then each channel the rule covers whose spend is held at intake, has none recorded, or is counted at another branch (no incident says so; 2026-11-17) | Which branches must not move budget yet | Lists incidents and held records, not their size in the budget decision |
| Journey collected (Customer 360) | Σ successful payments − refunds for the customer, to date (equals `v_customer_revenue`) | Customer value | Includes add-on services, not only the first subscription |
| Conversion bridge | platform-claimed → paid lead records → unique paid prospects → {existing, not sold, credited elsewhere, sold not serviced, serviced} | "Where did the conversions go?" | Platform claims cover mapped campaigns; buckets are exclusive and add up (tested). |

## Decision boundary (2026-11-17)

Three separate outcomes, decided once (`budgetSignal`, `lib/metrics/decision.ts`; the reasons in
`lib/metrics/eligibility.ts`) and read by every surface: the branch card, the Decision Lab, the
Overview, the fix receipt and the investigator.

1. **A fact is displayable.** Every channel's spend, customers and CAC are shown, or the reason it
   has none.
2. **A comparison is valid** between channels the rule covers (≥ 5 customers) whose cost is
   defensible and that no open incident touches. If some are left out, it reads "among verified
   channels" and names each one with its reason. It is never a branch-wide ranking then. If an
   incident's reach cannot be narrowed to channels (held lead records can move customers between
   any of them), nothing is verified. The comparison then shows only behind the gate.
3. **A recommendation can still be held.** It is held by any open incident. It is also held by a
   left-out channel whose missing evidence could change which channel is cheapest or most
   expensive. The scenario builder preselects a move only when nothing holds it.

Why a paid channel with customers cannot carry an action on its CAC, in the records' own terms.
Every reason makes that channel not ready, so no move into or out of it is decision-ready. They
differ in what else they hold and what releases them:

| Reason | Records | Holds the branch-wide recommendation | Released by |
|---|---|---|---|
| Held at intake | spend days held (excluded or quarantined, none counted). All of a period's days: no CAC. Some: the CAC is understated | yes | accepting the held records (a currency rule authorized, the record accepted) |
| Revision refused | a newer revision of counted spend was refused; the counted amount is unconfirmed (its own incident) | yes | a newer revision accepted |
| Unmapped campaign | customers credited to a campaign no branch is mapped to; their cost is unallocated (its own incident) | yes | mapping the campaign |
| Cost at another branch | every customer came from campaigns mapped to other branches (branch keys, D-2) | yes | a branch-credit decision; none exists |
| No spend recorded | customers, no spend and nothing held | yes | nothing in the records says why |
| $0.00 recorded | the source recorded $0.00 on every counted day | **no**: it is evidence, not a gap | nothing to release |

An open incident at a branch still holds every move there, as before. A correction clears only
its own blocker. Another open one keeps the recommendation held. The fix receipt says so beside
the fix's own verification. Partly cross-branch customers are a **limitation**, shown beside the
figure and never a reason to leave it out (rule 4: no spend or customers move between branches,
and no replacement metric is computed). In the October seed, 8 paid-media customers serviced at B07
came from B06's campaigns (3 Local Services, 4 Search, 1 Meta).

## Google conversion feedback (dry run)

Serviced Google Search acquisitions with a gclid → candidate conversions.
`transactionId = sha256(lead_id:initial_service_completed)` (stable: a re-send is an adjustment).
Excluded with a reason: no click id, lead older than 90 days, D2D conflict (held), cancelled plan
(not sent). Value = booked annual plan value, labelled as a bidding signal. Shape follows the Data
Manager API path that replaced `UploadClickConversions` for new uploaders in 2026 (research/05);
field names must be checked against Google's reference before any real use.

Limits, re-checked against Google's documentation on 2026-11-09 (audit area F):

- **Cancelled plans are not retracted.** Data Manager does not support conversion retractions (its
  upgrade guide); a value can be restated, the count stays. Nothing here records what was sent, so a
  cancelled plan is simply never sent.
- **"No click id" is not "unmatchable".** Google can match on hashed email or phone (enhanced
  conversions for leads) and on gbraid/wbraid. Neither is implemented. The stored hashes use this
  system's own format (`phone:` + E.164), not Google's normalisation, so they cannot be reused as-is.
- **Click age is approximated from the lead time**, which is at or after the click. Google's limit is
  the conversion action's click-through window (90 days by default).
- **No consent fields are sent.** Google requires them for EEA users only; a real uploader should
  still pass them explicitly.

## What attribution is not

Attributed revenue says which recorded touch preceded a sale. It does not say the sale would not
have happened without the ad. Incremental lift needs holdouts (geo split, platform lift studies).

## Known limitations

- Periods are UTC, not branch-local; a Phoenix payment at 18:00 local on Sep 30 counts in October.
- LSA cost should be charged − credited; the synthetic LSA feed has no credits.
- D2D cost (commission) is not modelled; D2D is excluded from paid-media CAC, visibly.
- Lead-cohort CAC with a maturity flag is not built; only period CAC.
- A branch CAC can still mix its own spend with customers another branch's campaign produced (the
  D-2 split). In the business-fit fixture, B11's own $50 over one customer B10's campaign produced
  read $50.00, and $100.00 after an equal-total restatement between the two campaigns; company
  totals did not move. Since the decision boundary (2026-11-17) the figure says so. A channel whose
  every customer came from another branch's campaigns cannot carry a decision ("cost at B10"), and a
  partial mix is named beside the figure. Which branch carries the cost is still undecided: nothing
  is reassigned and no other figure is offered.
- The scorecard restates history silently: a revision accepted after a decision moves the figure,
  with no "as known at" view. A stored Shadow check keeps the figure it compared, and a re-run
  names the records that arrived after it.
