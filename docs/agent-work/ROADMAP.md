# Roadmap: one backlog

Reconciled 2026-11-12 against the governing mission (kept local as `MASTER-MISSION.md`) and
`CAPABILITY-MATRIX.md`. Earlier milestone tables (M-0 to M-9 of 2026-11-11) are history in
`PROGRESS.md`. Ordered by the mission's priorities: money and safety first, then semantics,
then effort and polish. Each item names the module it extends; none adds a parallel system.

## Done in this program (evidence in the linked documents)

| Slice | Evidence |
|---|---|
| Proof-carrying claims, financial evidence graph, currency rules, workspaces | `PROOF-CARRYING-REPORT.md` |
| VP war room: blind 12-scenario pack, browser journeys, UX red team, scorecard, independent review | `VP-ACCEPTANCE-REPORT.md` |
| A lead credits at most one customer (P0 found by the review) | R-39; migration 0024 |
| Shadow Mode + answer assurance (mission M1) | `SHADOW-MODE.md`; `shadow-acceptance/` |
| A claim is supported only when every part is proved (R-38) | `TRUST-HARDENING-REPORT.md`; `ai-template-trust.test.ts` |
| A stale payment copy never puts voided cash back (R-37) | `TRUST-HARDENING-REPORT.md`; `payment-revisions.test.ts` |
| The 11 critical VP findings reviewed one by one | `vp-acceptance/evidence/CRITICAL-REVIEW.md` |
| Released mappings re-checked on a schedule; a drift is one review item (R-30) | `POST-RELEASE-MONITORING.md`; `post-release-monitoring.test.ts` |

## Next, in order

| # | Item | Why now | Extends |
|---|---|---|---|
| 3 | ~~Reliability Twin, smallest complete slice~~ **Done 2026-11-12** (`RELIABILITY-TWIN.md`): calls@1.1 → 1.2 over 1 → 5 → 44 branches in cloned twin databases, 12 gates per stage against an independent reference, two fault families per stage, fail-closed with a verified rollback, one stage table on the change page | — | — |
| 3a | **A ruling on the two attribution rules the twin cannot judge** (R-39 shared-phone reservation, R-46 campaign ids without a platform), then fix them in the product and the reference together | Both pass every gate because the reference applies the same rule | `v_acquisitions`, `lib/twin/oracle.ts` |
| 4 | ~~Scheduled post-release monitoring; "verified at release" (R-30)~~ **Done 2026-11-12** (`POST-RELEASE-MONITORING.md`): daily worker checks for 14 days, one review item per drift, mapping untouched; disk preflight before a twin (R-49) | — | — |
| 4a | Notify on an overdue slot or an opened drift (R-30, still open) | Overdue is visible only on the change page | the worker tick, the release's author |
| 5 | Correlation ids across upload → monitor; latency and freshness measured per step (mission M5) | Operators cannot follow one record end to end | intake, `lib/events/*`, `audit_log` |
| 6 | Recurrence and ownership on incidents: owner, due/age, recurrence rule (mission M6) | Closing a case is not preventing it again | Action Center cases |
| 7 | One approval vocabulary for incidents and ChangeGuard (R-32); dry-run scope labels (R-31) | Two flows confuse approvers | `components/changes`, Action Center |
| 8 | Decision Lab and Overview load time (R-34) | 3–4 s first loads | the A/A self-check cache |
| 9 | Read-only shadow run against one real office (needs Moxie's approval and data agreement) | R-1 is the largest unproven assumption | Shadow Mode + the mappers |

## Deliberately not built

A conversational BI tool, a CRM or lead router, an agent framework, FX conversion, automatic
rollback, model authority over money or approvals (`CAPABILITY-MATRIX.md`).
