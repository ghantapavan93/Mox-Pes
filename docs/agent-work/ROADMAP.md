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

## Next, in order

| # | Item | Why now | Extends |
|---|---|---|---|
| 3 | **Reliability Twin, smallest complete slice** (mission M2): one change kind, the calls mapper version, rolled out over 1 → 5 → 44 branches in a cloned world. Each stage is gated by five invariants: cash and CAC traces reproduce, no lead is two customers' first touch, company spend is conserved, and no branch outside the stage moves. Each stage also takes two fault families: 429/503 with backfill, and a crash after commit before acknowledgement. A failed invariant stops the rollout, and recovery is proved by a re-projection that restores the pre-change state exactly. Shown as one stage table on the change page | Release safety is tested per change, not per rollout | ChangeGuard, sync jobs, the mock connector's faults, the scenario runner (one database per scenario), the traces |
| 4 | Scheduled post-release monitoring; status "verified at release" (R-30) | A released mapping is never re-checked unless someone clicks | `lib/changeguard/service.ts` |
| 5 | Correlation ids across upload → monitor; latency and freshness measured per step (mission M5) | Operators cannot follow one record end to end | intake, `lib/events/*`, `audit_log` |
| 6 | Recurrence and ownership on incidents: owner, due/age, recurrence rule (mission M6) | Closing a case is not preventing it again | Action Center cases |
| 7 | One approval vocabulary for incidents and ChangeGuard (R-32); dry-run scope labels (R-31) | Two flows confuse approvers | `components/changes`, Action Center |
| 8 | Decision Lab and Overview load time (R-34) | 3–4 s first loads | the A/A self-check cache |
| 9 | Read-only shadow run against one real office (needs Moxie's approval and data agreement) | R-1 is the largest unproven assumption | Shadow Mode + the mappers |

## Deliberately not built

A conversational BI tool, a CRM or lead router, an agent framework, FX conversion, automatic
rollback, model authority over money or approvals (`CAPABILITY-MATRIX.md`).
