# Capability and gap matrix

As of 2026-11-12, HEAD on `feature/audit-enterprise-redesign`. Classification per the
governing mission (kept local: `MASTER-MISSION.md`, ignored by git because it quotes public
profiles of real people):

**VERIFIED EXISTING** — built, and a test that would fail without it passes in the latest run.
**PARTIAL** — built for some cases; named gaps. **BROKEN** — known wrong. **UNSUPPORTED** —
deliberately refused. **UNTESTED** — built, no evidence. **NOT WORTH BUILDING** — with reason.

Evidence columns name the test or document; the latest run's numbers are in
`VP-ACCEPTANCE-REPORT.md` and `VERIFICATION.md`.

## Mission milestones mapped to what exists

| Milestone | State | Existing module to extend (no duplicates) |
|---|---|---|
| M0 Verified state | VERIFIED EXISTING (re-run each milestone) | `C:/Temp/final-regression-m5.sh`, `rso-verify-run.sh` (clean worktree, fresh databases) |
| **M1 Shadow Mode + AI Answer Assurance** | **VERIFIED EXISTING (bounded), 2026-11-12** — `lib/shadow/*`, `/assurance`, `SHADOW-MODE.md`; blind pack first contact 5/320 failed (2 critical), fixed, regression 320/320; browser journey J9. Limits: R-40 | Built on the proof engine, typed facts, read-only tools, traces and the scenario runner; no new ledger, metric code or agent |
| M2 Reliability Twin | **VERIFIED EXISTING (smallest slice), 2026-11-12** | `lib/twin/*` (`RELIABILITY-TWIN.md`): calls@1.1 → 1.2 staged over 1 → 5 → 44 branches in cloned twin databases through the production intake, replay, sync worker and reconciliation; 12 gates per stage against an independent reference; 429/503/timeout/exhaustion and lost-runner/lost-worker faults at every stage; fail-closed with verified rollback; stage table on the change page (question 9); independent review fixed (`twin/REVIEW-FIRST-CONTACT.md`). Limits: R-44, R-45, R-47. Still missing: scheduled post-release monitoring (R-30), other change kinds |
| M3 Source lifecycle and money | PARTIAL, strong | Intake + raw ledger (`lib/ingest/*`), mappers with versions, currency gate (`lib/currency/*`), refunds, spam reclassification, newest-version-wins, metamorphic and property tests. Missing: CRM merge/delete (R-4), CRM account namespacing (R-3), effective-dated rules (R-28) |
| M4 Proof-carrying investigation | VERIFIED EXISTING (deterministic) | `lib/ai/*`, `lib/inquiry/*` (six hypotheses, versions, notes). Model mode UNTESTED (no key, R-10) |
| M5 Integration + observability | PARTIAL | Vendor-shaped mappers and a FieldRoutes mock connector with faults; `reporting.*_v1` views. Missing: correlation ids across upload → monitor, span timings |
| M6 Ownership + Kaizen + pilot | PARTIAL | Cases have an `owner` field; Action Center flow; opportunity readiness mentions pilots. Missing: recurrence detection, owner/steward per source, pilot-readiness spec, measured operator effort |
| M7 Unified UX | PARTIAL | 23 pages pass axe at 4 widths; UX-FINDINGS lists 1 open P1 and 14 open P2s |
| M8 VP War Room | VERIFIED EXISTING (v1 pack) | 12-scenario frozen pack, first contact kept, adjudicated. Not yet in it: Shadow Mode, a crash-after-commit family |
| M9 Hardening | PARTIAL | Clean checkout script, fault tests, 1M backfill. Missing: load concurrency, production-durability timings for page paths |

## Capability detail

| Capability | State | Evidence | Gap |
|---|---|---|---|
| Raw intake, idempotent redelivery, out-of-order revisions | VERIFIED EXISTING | metamorphic relations; fault test 1; J5 | Vendor resend semantics (R-16) |
| Staged onboarding (CSV/XLSX/JSON → mapping → dry run → approval) | VERIFIED EXISTING | `z-onboarding.spec.ts`, mapping eval sets | 50k-row cap (R-8) |
| Cent-exact traces: paid CAC, spend, cash, refunds, attribution | VERIFIED EXISTING | `z-trace`, J2 against raw payloads, property tests | Real data (R-1) |
| Unknown currency held; two-person account rule | VERIFIED EXISTING | VP-10; regression tests | Undated rules (R-28) |
| Non-USD amounts | UNSUPPORTED (refused at intake) | adapter tests | FX deliberately not built |
| Identity resolution with conflicts | PARTIAL | identity tests; VP-01; `shared-phone-credit.test.ts` | Reservation corner case (R-39); office transfers not flagged (R-42) |
| Payment versions without a source clock: a stale copy never adds cash back | VERIFIED EXISTING (bounded), 2026-11-12 | `payment-revisions.test.ts` (12), connector stale-replica case, 24-seed ledger model | A real void reversal is held for a person; a stale void lowers cash (R-37) |
| A claim is SUPPORTED only when every proposition is proved, template or model | VERIFIED EXISTING, 2026-11-12 | `ai-template-trust.test.ts` (18), held-out 336 claims unchanged, browser journey | Templates are not held to the closed reading (R-38) |
| ChangeGuard: preflight, hash-bound approval, release, monitor | VERIFIED EXISTING | `zzz-changeguard`, held-out set, fault test 2 | Scheduled monitoring (R-30); rollout stages |
| Action Center: dry run → approve → execute | VERIFIED EXISTING | `os-golden-path`, `zz-b09` | Mixed scopes in dry-run evidence (R-31); two approval models (R-32) |
| Investigator: tools, proofs, refusals, injection resistance | VERIFIED EXISTING (deterministic) | held-out set (regression), VP-12 | Model mode (R-10); closed reading is patterns (R-27) |
| Investigation workspace (six hypotheses, versions) | VERIFIED EXISTING | J3, VP-01, VP-04 | Ageing (R-29) |
| Decision Lab: verified readiness, scenarios | VERIFIED EXISTING | J8, VP-09 | Slow load (R-34) |
| Server-enforced role and branch scope | VERIFIED EXISTING | J6, VP-07, hostile-input gate | Demo auth (R-2); 403 as HTTP 200 (R-33) |
| Independent check of another system's metric snapshot | VERIFIED EXISTING (bounded) | `shadow-mode.test.ts` (16), Shadow pack, J9 | Synthetic other system; UTC, Sep–Oct, USD (R-40) |
| Checking a conversational answer claim by claim against evidence | VERIFIED EXISTING (deterministic) | Shadow pack answers (31 claims), J9 | No model run (R-10) |
| A lead credits at most one customer | VERIFIED EXISTING | `shared-phone-credit.test.ts`, investigator held-out IV-44/46 | Reservation corner case (R-39) |
| Correlation ids and spans | MISSING | — | M5 |
| Incident recurrence | MISSING | — | M6 |
| Branch rollout simulation (1 → 5 → 44) | MISSING | — | M2 |
| Model-backed AI | UNTESTED | — | Needs an approved key |

## Build / configure / integrate / do not build

| Item | Decision | Why |
|---|---|---|
| A conversational BI chatbot | **DO NOT BUILD** | MoxieBI is publicly described; the gap worth showing is checking answers, not producing them |
| A CRM, lead router or replacement BI | **DO NOT BUILD** | Existing investments; integrate through mappers and `reporting.*` views |
| An agent framework or multi-agent runtime | **DO NOT BUILD** now | The deterministic tool registry and proof engine already do the work; no measured gain to justify it |
| OpenTelemetry SDK | **CONFIGURE later** | Correlation ids first; spans only where a measured question needs them |
| FX conversion | **DO NOT BUILD** | No authorized rate source; refusal is safer than a guessed rate |
| Shadow Mode comparator | **BUILD** | No existing module does it; it reuses the proof engine, traces and the scenario runner |
