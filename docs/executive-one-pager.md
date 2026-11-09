# Revenue Signal — one page

*Independent proof-of-work by Pavankalyan Ghanta, built unprompted before any interview. Synthetic
data. Not built from or affiliated with any Moxie system.*

**Context (public evidence).** A 44-branch, mostly residential, recurring-revenue business that buys
media across Google (20+ conversion IDs on its site), Microsoft, Meta and more; tracks calls in ~26
CallRail accounts; runs FieldRoutes as its CRM; sells door-to-door at scale; and already has a data
lake, Dagster pipelines and Power BI/Fabric.

**The problem hypothesis (to validate, not assumed true).** Every platform counts its own
conversions, and the CRM counts customers. When call tracking, the website, D2D and the CRM stop
agreeing at record level, branch CAC and channel ROI move for reasons that have nothing to do with
marketing — and budget follows the wrong number.

**What the prototype does.**
1. Checks six cross-system rules continuously (held source records, payments without invoices,
   lead-branch vs CRM-office, unmapped spend, D2D-after-paid, a paid channel with leads but no spend).
   The last one catches silent reclassification, such as a platform re-typing a campaign
   (ChangeGuard: a simulated Local Services → Performance Max migration).
2. Puts every disagreement in a queue with the records behind it and an owner's action.
3. Fixes safely: dry run, replay, recompute; the same request twice changes nothing.
4. Reports back to Google Ads only conversions that reconcile (dry run).

**The demo.** One branch's CAC reads 1.8× company. Cause: its call-tracking feed changed shape, 119
calls were held, 53 customers lost their source. After replay the branch's CAC is in line, spend and
revenue are unchanged, six more conversions become reportable to Google, and three hidden
commission-vs-media conflicts surface.

**Why this fits the role.** Integrations designed for failure, SQL definitions you can audit,
multi-branch scoping enforced on the server, numbers a leader can trust and trace.

**What production would need.** Run on lake tables instead of re-ingesting; a two-week pilot in one
branch; owners per exception type; SSO; incremental detection.

**Pilot success criteria (proposed).** Breaks detected within 24 hours; exceptions closed by owner per
week; dollars of revenue re-linked to a source; conversions withheld from or corrected in Google.
