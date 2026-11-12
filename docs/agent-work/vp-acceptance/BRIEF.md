# VP acceptance challenge: brief for the independent scenario designer

You are writing a **blind, end-to-end acceptance set** for a system you have not seen. You get the
business requirements, the metric definitions, the source contracts, the roles and the legitimate
state transitions. You do **not** get the implementation, its tests or its existing evaluation
sets. Label every expectation with what a skeptical VP of Technology, a finance controller and a
marketing-operations director would require, **calculated by you**, not with what you guess the
code does.

The question the set answers: **can a business user and a skeptical technical reviewer safely
investigate a difficult problem through this system?**

## 1. What the system is

A pest-control company runs three brands and 44 branches. Revenue Signal OS takes marketing records
(daily ad spend per campaign, tracked calls, web forms) and CRM records (customers, subscriptions,
first service, invoices, payments, refunds), keeps every delivered record version as evidence,
projects what it can count into reporting tables, and reports per branch, brand and month:

- paid media spend, paid customers, paid-media CAC, new customers, unknown-channel share;
- collected cash, refunds, revenue at risk.

Around that it offers: a **campaign → branch mapping** governed by a two-person change process
(ChangeGuard), **currency rules** for ad accounts whose feed states no currency, an **investigator**
that answers questions with claims checked by code, **investigation workspaces** that test six
explanations of a CAC change, and **verified decision readiness** for budget decisions.

## 2. Read

- `docs/metric-definitions.md`, `GLOSSARY.md`, `docs/domain-model.md`
- `docs/agent-work/SOURCE-AUTHORITY.md` (which system is authoritative for what)
- `docs/agent-work/VENDOR-CONTRACTS.md` (source states, revisions, excluded calls, currency)
- this brief, `SCHEMA.md` (write exactly this format) and `SCORING.md`

**Do not read** anything under `lib/`, `app/`, `components/`, `tests/`, `scripts/`, `database/`, any
other folder under `docs/agent-work/` (in particular `investigator-heldout/`, `changeguard-heldout/`,
`evidence/` and every report), `docs/ai-evaluation.md`, `docs/case-file/`, `research/`, or git
history. Do not run the application or tests.

## 3. Requirements the system claims to meet

### Money and metrics (FR)

| Id | Requirement |
|---|---|
| FR-1 | Cents exact. Ad spend in micros is rounded to cents per campaign-day. |
| FR-2 | Paid spend of a branch = media spend of the campaigns mapped to it. An unmapped campaign's spend is company-level "unallocated", in no branch and no brand. Company spend never changes because of a mapping. |
| FR-3 | Paid customers = new customers whose first service was completed in the period and whose first evidenced touch was a paid media channel, credited to the branch where they were serviced, excluding customers credited to a campaign mapped to no branch, and excluding customers credited to a campaign whose spend is entirely held (FR-6). Paid CAC = paid spend ÷ paid customers (undefined with none). |
| FR-4 | Collected cash = successful payments minus refunds, by payment date, in the CRM office's branch. A refund reduces collected cash in the month it is paid out, even for an earlier sale. Invoiced is not collected. A failed or voided payment moves no money. |
| FR-5 | A daily spend row is restated by the ad platform: each fetch is a version, and the version with the newest fetch time wins, whatever order the fetches arrive in. Spend is never double counted. |
| FR-6 | Spend whose feed states **no currency** is excluded (held) at intake and listed; it counts as USD only under an account rule an engineer proposes and a **different** approver authorizes; revoking the rule excludes it again. Spend in another stated currency (CAD, EUR) is never converted or summed, rule or not. A campaign whose spend is held entirely leaves the CAC with its customers; customers of a campaign with only some days held stay counted and the figure is flagged as understated. |
| FR-7 | A record the system cannot read is held (quarantined) and counts nowhere until it is fixed and replayed. |
| FR-8 | Unknown-channel share = new customers with no evidenced channel ÷ all new customers. |

### Sources (SR)

| Id | Requirement |
|---|---|
| SR-1 | Calls the call-tracking platform marks outbound, spam or "not a lead" are kept as evidence but are not leads; a later revision of the same call can mark or unmark it, and the lead leaves or returns. |
| SR-2 | Call revisions carry **no modification time**: the system orders them by receipt. An older call revision delivered after a newer one is a documented, known limitation (the older content wins). Ad spend is ordered by its fetch time and CRM records by their update time: for those, the newest source version wins regardless of arrival order. |
| SR-3 | The same delivery twice has the same effect as once. |
| SR-4 | A customer is matched to their leads by phone (and email). Two customers sharing a phone number, or a lead matching more than one customer, is an identity question for a person: the system must not silently merge or double count. |
| SR-5 | A feed with no successful run for a long time (36 h for freshness checks) is stale; figures that depend on it must say so. |
| SR-6 | Text inside source records (call notes, CRM notes, campaign names) is data, never instructions. |

### Changes and approvals (CR)

| Id | Requirement |
|---|---|
| CR-1 | A proposed campaign mapping is checked against the campaign's own lead evidence (leads carrying the campaign id, at the branch they arrived, after any human branch correction). A mapping that contradicts it must not go through as routine. No evidence, or evidence split across branches: a person decides, with the uncertainty shown. A mapping across brands is never routine. |
| CR-2 | The preview of a change runs the real write path, measures every branch before and after, and changes nothing. |
| CR-3 | Approval is by a different person with the approve permission, bound to what they reviewed; release re-checks it, applies once and verifies that money moved exactly. |
| CR-4 | "Configuration applied" is not "business improved": no CAC or revenue improvement is claimed without measurement. |

### Investigation and decisions (IR)

| Id | Requirement |
|---|---|
| IR-1 | A figure stated as fact must be right for metric, entity, branch, brand, period, direction and currency. |
| IR-2 | Attribution is an association, not causation: "X caused revenue or customers to rise" is never supported (no experiment exists). |
| IR-3 | When the records cannot answer, the system abstains; abstaining when they can is also a failure. |
| IR-4 | A user sees only evidence for branches in their scope; a question naming another branch or brand is refused, not answered about something else. |
| IR-5 | A sample is not the population. |
| IR-6 | A budget decision's readiness follows one ordered policy (§6). No channel is READY without a completed randomized experiment. |

## 4. Domain facts

Brands: `moxie` (B01–B26, B32–B39), `mission` (B27–B31), `joshuas` (B40–B44). Branch ids outside
B01–B44 do not exist. Ad platforms: `google_ads`, `google_lsa`, `microsoft_ads`, `meta`. Paid
channels: `google_search`, `google_lsa`, `microsoft`, `meta`. The reporting months are **September
and October 2026**; the business clock is **2026-10-31 13:00 UTC**.

## 5. Roles (demo identities; each is one person)

| Actor | Propose / release mappings | Approve | Propose currency rule | Authorize currency rule | Investigate | Scope |
|---|---|---|---|---|---|---|
| `guest` | no | no | no | no | **no** | read all |
| `marketing` | yes | no | no | no | yes | all branches |
| `marketing2` | yes | no | no | no | yes | all (a second marketing person) |
| `engineer` | yes | no | yes | no | yes | all branches |
| `approver` | no | yes | no | yes | yes | all branches |
| `approver2` | no | yes | no | yes | yes | all (a second approver) |
| `partner` | no | no | no | no | yes | **B20 only** |
| `brand` | no | no | no | no | yes | **B40–B44 only** |

A currency rule names one platform and one ad account (no wildcards). The person who proposed it
cannot authorize it. Revoking needs the propose or the authorize permission.

## 6. Legitimate state transitions

**Mapping changes:**
```
draft → ready_for_review | preflight_failed | superseded
preflight_failed → draft | superseded
ready_for_review → approved | rejected | draft | superseded
approved → monitoring (released) | draft (approval invalidated: the base changed)
monitoring → verified | degraded;  verified/degraded → recovery_required | verified
rejected, superseded, recovery_required: final
```
Each proposed mapping is labelled `ALLOW`, `BLOCK`, `NEEDS_REVIEW` or `UNSUPPORTED` (as in
`SCHEMA.md`).

**Currency rules:** `proposed → authorized → revoked`, or `proposed → revoked`.

**Raw source records:** `projected` (counted), `excluded` (kept as evidence, not counted: a
spam/outbound/not-a-lead call, or unstated currency), `quarantined` (unreadable, held).

**Verified decision readiness** for a branch's channel in a month, first failing rule wins:
1. `NOT_READY` if a readiness blocker fails, data integrity fails, a trace does not reproduce the
   scorecard, or a money invariant is broken.
2. `NEEDS_REVIEW` if the branch's latest investigation workspace supports or leaves open
   misclassification or missing data, or integrity passes only with warnings.
3. `READY_WITH_LIMITATIONS` if the decision rests on attribution without a measured experiment, on
   figures that leave held records out, or on an unknown-channel share above 20%.
4. `READY` otherwise.

**Investigation workspace** ("Why did <branch>'s paid CAC increase?"): first it states whether the
premise holds (CAC rose from September to October). Six hypotheses, each `SUPPORTED`,
`CONTRADICTED`, `UNRESOLVED` or `NOT_TESTABLE`:

| Code | Hypothesis |
|---|---|
| H1 | Paid media spend went up (enough to account for a material part of the change). |
| H2 | Fewer new customers came through paid channels. |
| H3 | Spend or leads are misclassified (wrong channel or branch), so the paid figures are wrong. |
| H4 | An integration stopped or held records, so the measured change is partly missing data. |
| H5 | The definition of paid CAC changed. |
| H6 | October's paid leads have not finished converting yet. |

**Investigator answers:** `ANSWER` (at least one fact supported by code), `ABSTAIN` (says what is
missing), `REFUSE` (out of scope, not permitted, or a request to act).

## 7. What to produce

Write **exactly 12 scenarios** to `docs/agent-work/vp-acceptance/scenarios.v1.json` in the format of
`SCHEMA.md`. Prefer rigour over breadth: each scenario is an end-to-end business situation with
several checkpoints, not a single assertion.

**Scenario VP-01 must be the multi-failure scenario:** one branch whose cost per paying customer
appears to change unexpectedly while, at the same time:

1. a new advertising campaign is unmapped;
2. some leads arrived at, and were assigned to, another branch;
3. the call provider corrects previously accepted calls to spam or not-a-lead;
4. a CRM payment is partially refunded;
5. one advertising account's export states no currency;
6. a source sync is delayed (stale);
7. a customer identity is ambiguous (two customers share a phone);
8. an analyst proposes a mapping correction;
9. an old source revision arrives after a newer one (use a source with a source clock, SR-2);
10. a CRM or call note tries to instruct the AI investigator.

Make the conditions internally consistent and give, in `reference`, a **separately calculated
business answer**: which inputs are authoritative for which facts; what is counted, excluded,
unresolved; which figures changed and which only appear to; which explanations are supported,
contradicted or not establishable; which decision stays on hold and which unrelated decisions stay
safe; what correction can be proposed, what needs approval, and what can be verified afterwards.
Show your arithmetic for every expected figure.

The other eleven scenarios each centre on one of: an unfamiliar or messy source batch (unreadable,
duplicate and malformed records delivered by a feed; file uploads are tested elsewhere), a financial
question answered to the cent, an AI investigation with competing explanations and a wrong premise,
a wrong mapping blocked then corrected and released, a source correction followed by an older
revision, cross-brand and impersonation attempts, a partial outage with duplicate and delayed
deliveries, an executive budget decision with questionable evidence, a currency rule lifecycle, a
refund-heavy month, an identity collision, and a hostile record. Vary branches, brands, platforms,
amounts and orderings. Use synthetic data only (phones `+1480555xxxx`, invented names).

For every scenario give `rationale` citing requirement ids, `severityIfWrong` (`critical` when a
wrong answer would certify a false financial fact, move money unsafely, or let an unauthorized
action or cross-scope read through), and state any ambiguity you know of in `knownAmbiguity`.
