# ChangeGuard held-out evaluation: brief for the independent scenario author

You are writing a **blind test set** for a system you have not seen. You get the business
requirements, the source contracts, the financial invariants, the roles and the authorized state
transitions. You do **not** get the implementation or its existing tests. Label each scenario with
what a careful revenue-operations reviewer would want, not with what you guess the code does.

## 1. What the system is for

A pest-control company runs three brands across 44 branches. Marketing buys media (Google Search,
Google Local Services, Microsoft, Meta) per **campaign**. Every campaign's spend is assigned to
**one branch** by a configuration row: the **campaign → branch mapping**. That mapping decides
which branch's paid spend, paid customer count and paid CAC include the campaign. A wrong mapping
does not break any pipeline; it silently moves money between branches in every report.

**ChangeGuard** sits in front of changes to that configuration (and assesses changes to source
payload shapes). For each proposed change it must answer, **before** anything is live:
what is changing, what depends on it, what was tested, what failed, what could be affected, what
must be corrected, who can approve, and (after release) what happened.

## 2. Business requirements (what the system claims)

| Id | Requirement |
|---|---|
| BR-1 | A proposed mapping is checked against the campaign's **own lead evidence**: the leads (calls, web forms) that carry the campaign's id, and the branch each lead arrived at (after any human branch correction of that lead). A mapping that contradicts where the campaign's leads arrive must not go through as routine. |
| BR-2 | When there is **no** lead evidence, or the evidence is **split** across branches, the system cannot decide alone: a person must make the call with the uncertainty shown. Unknown data is never treated as valid. |
| BR-3 | A campaign belongs to one brand's ad account. Moving spend **across brands** (a campaign whose leads, or whose current mapping, are brand X, mapped to a branch of brand Y) is never routine. |
| BR-4 | **Money moves, it is not created.** A mapping moves exactly the campaign's media spend from its previous branch (or from "unallocated" if it was unmapped) to the proposed branch. Company spend is unchanged to the cent. Branches outside the change do not move. |
| BR-5 | The preview of a change runs the **real** write path and the real reconciliation, measures every branch before and after, and leaves nothing changed. |
| BR-6 | Proposing needs the propose permission and the branches involved in scope. **Approval is by a different person** with the approve permission, never the author, even if the author holds other roles. |
| BR-7 | An approval is **bound** to what the approver reviewed: the exact configuration, the exact preview, and the base it replaced (the current mapping and where the evidence points). Presenting a different preview's identity, or approving after the base moved, must be refused. |
| BR-8 | **Release** applies an approved mapping once, re-checks the bindings at release time, and verifies the result in the same step (applied, spend moved exactly, nothing unrelated moved, predicted exceptions cleared). If the base moved after approval, the approval is **invalidated** and the change goes back to draft; nothing is released. |
| BR-9 | **Monitoring** after release checks that the mapping is still in place and that leads arriving since release still agree with it. If not, the change becomes **recovery required**: a person proposes a compensating change. **Nothing is rolled back automatically.** |
| BR-10 | "Configuration applied" is not "business improved": the system never claims a revenue or CAC improvement it did not measure. |
| BR-11 | A **source contract** check runs sample payloads of a changed upstream shape through the **currently deployed** mapper and reports refused records, missing identifiers, structural differences, duplicates and the metrics that depend on them. Activating a new mapper version is a code deployment, so a source contract change can be reviewed but **never released** from this tool. |
| BR-12 | Two changes for the **same campaign** may not both be in review or approved at once. |
| BR-13 | A corrected resubmission supersedes the author's earlier change; only the author may resubmit their own change. |

Known product properties (state these in a scenario's expectation if they matter to it):

- **Mappings are not effective-dated.** A mapping applies to the campaign's whole history. There is
  no way to say "B12 until Oct 14, B13 after".
- Lead evidence exists only where leads carry the campaign id (calls: the `campaign` field; web
  forms: `utm_campaign`). Door-to-door leads and CRM records carry none.
- Lineage: when an ad platform migrates a campaign (e.g. Local Services → Performance Max), the
  system may record "campaign A was replaced by campaign B". Where a predecessor or successor maps
  is context for a reviewer.
- A campaign name starting with a branch id ("B12 | Search | Termite") is a naming convention, not
  an authority.

## 3. Domain facts

Brands: `moxie` (Moxie Pest Control), `joshuas` (Joshua's Pest Control), `mission` (Mission Pest
Control).

| Branches | Brand |
|---|---|
| B01–B26, B32–B39 | moxie |
| B27–B31 | mission |
| B40–B44 | joshuas |

Branch ids outside B01–B44 do not exist. Paid channels with media cost: `google_search`,
`google_lsa`, `microsoft`, `meta`. Ad platforms: `google_ads`, `google_lsa`, `microsoft_ads`,
`meta`.

Metric definitions (read `docs/metric-definitions.md`): paid spend of a branch = media spend of the
campaigns mapped to it; spend on an unmapped campaign is company-level "unallocated" and belongs to
no branch and no brand; paid CAC = paid spend ÷ paid customers acquired. A campaign's spend is
"unmapped spend" (an open exception) until it is mapped.

## 4. Financial invariants (must hold after any preview, release or refusal)

- FI-1 Company ad spend is unchanged by any mapping change (to the cent).
- FI-2 A release moves exactly the campaign's media spend: proposed branch +X, previous branch −X
  (or unallocated −X).
- FI-3 No branch outside {previous, proposed, branches where the campaign's leads arrive} changes.
- FI-4 A refusal (blocked preview, refused approval, refused release) changes no mapping, no spend,
  no ledger row.
- FI-5 Brand totals are the sum of their branches; unallocated spend is in no brand.
- FI-6 Collected revenue follows the CRM's payments; a refund reduces it. A mapping change never
  changes collected revenue or customer counts company-wide.

## 5. Roles (demo identities; each is one person)

| Actor | Can propose / release | Can approve | Scope |
|---|---|---|---|
| `guest` | no | no | read all |
| `marketing` | yes | no | all branches |
| `engineer` | yes | no | all branches |
| `approver` | no | yes | all branches |
| `partner` | no | no | B20 only |
| `brand` | no | no | joshuas branches only |
| `marketing2` | yes | no | all branches (a second, different marketing person) |
| `approver2` | no | yes | all branches (a second, different approver) |

Release is performed by someone with the propose permission, after approval by a different person.

## 6. Authorized state transitions

```
draft            → ready_for_review | preflight_failed | superseded
preflight_failed → draft (re-run preview) | superseded
ready_for_review → approved | rejected | draft (re-run preview) | superseded
approved         → monitoring (released) | draft (approval invalidated: the base changed)
rejected         → (final)
monitoring       → verified | degraded
verified         → recovery_required | verified
degraded         → recovery_required | verified | degraded
recovery_required → (final; a person proposes a compensating change)
superseded       → (final)
```

A new change starts in `draft` and its preview runs at once, ending in `ready_for_review` or
`preflight_failed`.

## 7. Outcome classes (label every proposed change with one)

| Class | Meaning |
|---|---|
| `ALLOW` | Safe as proposed. The system should send it to the normal two-person approval **without** raising anything a person must decide. |
| `BLOCK` | Unsafe or invalid. The system should refuse it at the preview (it must not be approvable as is). |
| `NEEDS_REVIEW` | The system cannot decide alone; it should let it go to approval **but** flag the uncertainty a person must accept (e.g. missing or split evidence). |
| `UNSUPPORTED` | The system cannot express or perform this change at all (e.g. something the product does not model). Saying so is the correct answer; pretending to handle it is not. |

For actions (approve, release, monitor, resubmit, …) you label the step outcome: `accepted` or
`refused`, and optionally the change's status afterwards.

## 8. What to produce

Write **30 to 50 genuinely distinct scenarios** to `docs/agent-work/changeguard-heldout/scenarios.v1.json`
in the format of `SCHEMA.md`. Cover all of these, several scenarios each where it makes sense:

1. Unsafe and valid campaign mappings
2. Sparse or contradictory lead evidence
3. Cross-brand and branch conflicts
4. Historical mapping effects
5. Benign schema drift (source contracts)
6. Partial refunds and source corrections
7. Changed evidence after preflight
8. Concurrent approvals and releases
9. Unauthorized actions
10. Monitoring and recovery
11. Cases where human review is the only safe answer

For each scenario give: a rationale in one or two sentences grounded in the requirements above (cite
BR-/FI- ids), and `severityIfWrong`: `critical` (a wrong answer would let unsafe money movement,
a cross-brand transfer or an unauthorized action through), `high`, `medium` or `low`.

Do not write near-duplicates. Vary amounts, branches, brands, platforms, lead counts and orderings.
Use synthetic data only (phone numbers like `+1480555xxxx`, invented names).

## 9. What you may read

Only: this brief, `SCHEMA.md` next to it, `GLOSSARY.md`, `docs/domain-model.md`,
`docs/metric-definitions.md`, `docs/reporting-contract.md`, `docs/agent-work/VENDOR-CONTRACTS.md`,
`docs/agent-work/INTEGRATION-CONTRACT.md`, `docs/agent-work/SOURCE-AUTHORITY.md`, and
`lib/adapters/marketing.ts` / `lib/adapters/crm-fieldroutes.ts` (the deployed source mappers: the
source contracts).

Do **not** read anything under `lib/changeguard/`, `app/changes/`, `app/api/changes/`,
`components/changes/`, `tests/`, `docs/agent-work/CHANGEGUARD*.md`, `docs/agent-work/changeguard-design/`,
`docs/changeguard/`, or any migration about config changes. Do not run code. Do not use git history.
