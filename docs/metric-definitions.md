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
| Paid-media CAC | paid media spend ÷ new customers serviced whose credited channel is paid | Channel/branch efficiency | **Period CAC**, not cohort: October spend vs October completions. Young periods look worse. |
| Unattributed share | serviced new customers with channel `unknown` ÷ all serviced new customers | Measurement health | A jump usually means broken capture or linkage, not changed behaviour — the seeded incident shows exactly this. |
| Collected revenue | Σ successful payments − refunds (negative rows), by payment date, in the CRM office's branch | Cash by branch | Includes the existing base. Booked contract value and invoice totals are never revenue. |
| Collected from new customers | Σ successful payments − refunds, to date, from customers serviced in the period | Early payback | Young customers have paid little so far. |
| Booked annual value | Σ annual contract value of active first subscriptions | Bidding value, pipeline | **Booked, not revenue**; always labelled so. |
| Revenue in open exceptions | Σ collected revenue of **distinct** customers referenced by open exceptions | How much revenue has unsettled credit: **untied** (held records, payments without a ticket, conflicting payloads) vs **credit disputed** (branch mismatch, D2D / paid conflict — tied, but contested) | It is not lost revenue. Disputed credit is a policy question, not missing data. Unmapped spend is reported separately. |
| Channel spend | Σ cost of spend records by the channel **each record was classified into** by its mapper version | Channel budget | A platform re-typing a campaign moves spend between channels silently; see the coverage-gap rule |
| Budget signal (illustrative) | the most expensive paid channel at a branch costs ≥ 1.5× the cheapest per new customer serviced (each ≥ 5 customers) | Whether to shift budget between channels | Shown with its blockers; "not trustworthy yet" while a coverage gap, held records or unmapped spend is open at the branch |
| Decision readiness | per paid channel at a branch: integrity passes, no open decision-blocking incident at the branch (coverage gap, held records, unmapped spend), ≥ 5 serviced customers, spend and CRM feeds fresh (≤ 36 h) | Whether this channel's numbers can carry a budget move | Readiness is not effectiveness: a ready channel can still be ineffective; only a randomized experiment measures that |
| Budget decisions on hold (Overview) | open decision-blocking exceptions in scope, most severe first | Which branches must not move budget yet | Lists incidents, not their size in the budget decision |
| Journey collected (Customer 360) | Σ successful payments − refunds for the customer, to date (equals `v_customer_revenue`) | Customer value | Includes add-on services, not only the first subscription |
| Conversion bridge | platform-claimed → paid lead records → unique paid prospects → {existing, not sold, credited elsewhere, sold not serviced, serviced} | "Where did the conversions go?" | Platform claims cover mapped campaigns; buckets are exclusive and add up (tested). |

## Google conversion feedback (dry run)

Serviced Google Search acquisitions with a gclid → candidate conversions.
`transactionId = sha256(lead_id:initial_service_completed)` (stable: a re-send is an adjustment).
Excluded with a reason: no click id, click older than 90 days at upload time, D2D conflict (held),
cancelled plan (retraction). Value = booked annual plan value, labelled as a bidding signal. Shape
follows the Data Manager API path that replaced `UploadClickConversions` for new uploaders in 2026
(research/05); field names must be checked against Google's reference before any real use.

## What attribution is not

Attributed revenue says which recorded touch preceded a sale. It does not say the sale would not
have happened without the ad. Incremental lift needs holdouts (geo split, platform lift studies).

## Known limitations

- Periods are UTC, not branch-local; a Phoenix payment at 18:00 local on Sep 30 counts in October.
- LSA cost should be charged − credited; the synthetic LSA feed has no credits.
- D2D cost (commission) is not modelled; D2D is excluded from paid-media CAC, visibly.
- Lead-cohort CAC with a maturity flag is not built; only period CAC.
