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
| The Overview says what changed at a branch, and opens that week's records and comes back (2026-11-13) | `OVERVIEW-MOVEMENT.md`; `zy-overview-movement.spec.ts` |
| The Decision Lab's verified verdict in 1.2–2.3 s, not 3.3–5.6 s; the hold was already 0.34–0.49 s (R-34, 2026-11-13) | `PERFORMANCE.md` §6; `decision-lab/`; `verified-readiness.test.ts` |
| A campaign id is matched on the platform the lead names, not by the id alone (R-46, 2026-11-13) | `CAMPAIGN-PLATFORM-MATCH.md`; `campaign-platform-match.test.ts` |
| ChangeGuard judges a campaign on its own leads; an unresolved lead is neither support nor drift (R-46, 2026-11-13) | `CAMPAIGN-PLATFORM-MATCH.md` §6; `changeguard-campaign-platform.test.ts` |
| B09 from decision hold to verified recovery: a coverage gap clears only when its whole window is verified, under its own id; a re-filed week, a duplicate or an older revision cannot clear it (2026-11-14) | `B09-RECOVERY.md`; `b09-recovery.test.ts` |
| One reading order across the Overview, daily evidence, incident and Decision Lab: one coverage-gap status in the same words everywhere; the selected week set against the decision window; "Ready for review" beside a cleared hold and what still needs review (2026-11-14) | `B09-CROSS-VIEW.md`; `gap-status.test.ts`; `b09-cross-view/` |
| One operational handoff on the B09 case: from the incident to its owner, the delivery runs its verification rests on, and what remains; a run number links to its row, and Back returns after a section jump (2026-11-14) | `B09-HANDOFF.md`; `b09-handoff/`; `zz-b09-four-minute-path.spec.ts` |
| A run's row says what it changed: "New" is "Stored", and the outcome tells a stored-but-superseded or duplicate run from one that changed accepted records and was used by a verification; recorded with the change, never inferred (2026-11-14) | `DELIVERY-OUTCOMES.md`; `delivery-outcomes/`; `run-effect.test.ts` |
| Final acceptance: a stale campaign rewrite and two release blockers (a brand-level answer check readable outside its brand; "zero" for missing spend) found and fixed; release walkthrough, route sweep, two lens walks and a full regression on the candidate (2026-11-15) | `RELEASE-CANDIDATE.md`; `BIVE-ACCEPTANCE.md`; `release-candidate/`; `bive/` |
| An answer check is listed by everything it names, not only what it read: the three gaps the acceptance recheck left (R-57), fixed after the decision and verified by the full regression; the accepted local demo checkpoint is `28e498b` (2026-11-15) | `SHADOW-MODE.md` §4; `shadow-mode.test.ts`; `bive/r57/`; `RELEASE-CANDIDATE.md` §7 |
| The B09 proof reruns from the repo with one command on its own database and server: missing → partial hold → verified, replays, an independent ledger, paired scope checks (R-55, 2026-11-15) | `B09-ACCEPTANCE-RUNNER.md`; `tests/acceptance/b09/`; `b09-acceptance/` |

## Next, in order

| # | Item | Why now | Extends |
|---|---|---|---|
| 3 | ~~Reliability Twin, smallest complete slice~~ **Done 2026-11-12** (`RELIABILITY-TWIN.md`): calls@1.1 → 1.2 over 1 → 5 → 44 branches in cloned twin databases, 12 gates per stage against an independent reference, two fault families per stage, fail-closed with a verified rollback, one stage table on the change page | — | — |
| 3a | **A ruling on the two attribution rules the twin cannot judge** (R-39 shared-phone reservation, R-46 campaign ids without a platform), then fix them in the product and the reference together. **R-46 done 2026-11-13** (`CAMPAIGN-PLATFORM-MATCH.md`): an id is matched on the platform the lead's own record names, in the product and the reference; same numbers on the demo world. ChangeGuard's lead evidence moved to the same match the same day (§6). Left from R-46: Local Services after the Performance Max migration. R-39 still needs its ruling | Both pass every gate because the reference applies the same rule | `v_acquisitions`, `lib/twin/oracle.ts` |
| 4 | ~~Scheduled post-release monitoring; "verified at release" (R-30)~~ **Done 2026-11-12** (`POST-RELEASE-MONITORING.md`): daily worker checks for 14 days, one review item per drift, mapping untouched; disk preflight before a twin (R-49) | — | — |
| 4a | ~~The reviewer's path to a drift~~ **Verified and completed 2026-11-13** (`POST-RELEASE-MONITORING.md` §6a): Incidents → the drift case → the exact check → the change already worked without the change id; added a decision summary above the numbered sections and a link to the changed lead's record. No notification system, by instruction | — | — |
| 5 | Correlation ids across upload → monitor; latency and freshness measured per step (mission M5) | Operators cannot follow one record end to end | intake, `lib/events/*`, `audit_log` |
| 6 | Recurrence and ownership on incidents: owner, due/age, recurrence rule (mission M6). **Drift cases done 2026-11-13** (`DRIFT-REVIEW.md`): a review bound to the check's material facts, needs-investigation with an owner, one reopen per new contradiction, stale saves refused. Other incident kinds and due/age are open | Closing a case is not preventing it again | Action Center cases |
| 7 | One approval vocabulary for incidents and ChangeGuard (R-32); dry-run scope labels (R-31) | Two flows confuse approvers | `components/changes`, Action Center |
| 8 | ~~Decision Lab and Overview load time (R-34)~~ **Done 2026-11-13.** Overview: `PERFORMANCE.md` §5, re-measured with "What changed" (`OVERVIEW-MOVEMENT.md` §5): the B09 hold is 25–50 ms later, at 1.1–1.3 s. Decision Lab: `PERFORMANCE.md` §6. Its hold was already usable in 0.34–0.49 s. Verified readiness read B09's scorecard row four times and now reads it once (3.3–5.6 s → 1.2–2.3 s), with identical decisions; the A/A self-check was never the cause, and no cache was added. Left: the one scorecard read (0.66–0.86 s) | — | — |
| 9 | Read-only shadow run against one real office (needs Moxie's approval and data agreement) | R-1 is the largest unproven assumption | Shadow Mode + the mappers |

## Deliberately not built

A conversational BI tool, a CRM or lead router, an agent framework, FX conversion, automatic
rollback, model authority over money or approvals (`CAPABILITY-MATRIX.md`).
