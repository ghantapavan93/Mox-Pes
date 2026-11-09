# Revenue Signal OS — roadmap and module contracts

Status: plan of record, 2026-11-01. This file is the contract the module builders work to. It extends
Revenue Signal + ChangeGuard; it does not replace them. Independent concept, synthetic data, not a
Moxie system.

## 1. Existing capabilities (baseline, verified)

| Capability | Where | Evidence |
|---|---|---|
| Raw event log, exactly-once ingest, two clocks, quarantine | `lib/ingest/ingest.ts`, `0001_init.sql` | `tests/integration/invariants.test.ts` |
| Versioned mappers (FieldRoutes-shaped CRM, calls 1.0/1.1, web, D2D, ads 1.0/1.1) | `lib/adapters/*` | unit + integration tests |
| Attribution as views (first evidenced touch, unknown stays unknown) | `0002_attribution_views.sql` | invariants |
| Six reconciliation detectors → self-resolving exceptions | `lib/reconcile/reconcile.ts` | invariants, scenario |
| Replay (quarantined) and re-projection (reproject), dry run, idempotency, lineage | `lib/ingest/replay.ts`, `replay-plan.ts` | replay + changeguard tests |
| Metrics (branch rows, totals, channels, bridge, freshness), budget-signal gate | `lib/metrics/*` | scenario |
| Google conversion feedback (dry run) | `lib/feedback.ts` | — |
| Roles (guest, marketing analyst, engineer, approver, partner), server-side scope | `lib/viewer.ts` | e2e 403 |
| Product shell: sidebar, ⌘K command menu, `/api/search` | `app/layout.tsx`, `components/CommandMenu.tsx`, `lib/nav.ts` | — |
| Tests: 93 vitest + 8 Playwright; two scenarios (B20 call drift, B09 LSA→PMax) | `tests/` | docs/testing.md |

## 2. Missing capabilities (this build)

Customer 360 + identity resolution; FieldRoutes-compatible connector (HTTP mock + authorized-client
boundary) with jobs, checkpoints, faults and a studio; an evidence-grounded investigator with tool
trace and structured contract; an Action Center (case state machine, proposals, dry run, approval,
audited execution); a Decision Lab (integrity vs readiness vs effectiveness, scenarios, an A/A
experiment); Audit & Health page.

## 3. Database changes (one migration per module; never edit applied migrations)

| File | Owner | Tables (indicative; owner finalises) |
|---|---|---|
| `0004_identity.sql` | Identity | `identities`, `identity_links` (source, source_record_id unique; rule, confidence, evidence), `identity_conflicts` (fingerprint unique; status pending/accepted/rejected; decided_by/at/reason) |
| `0005_connectors.sql` | Connectors | `connectors`, `sync_jobs` (state, idempotency_key unique, attempts, next_attempt_at, cancel_requested, stats), `sync_checkpoints` (connector, office, entity), `sync_api_calls`, `mock_fieldroutes_faults` |
| `0006_action_center.sql` | Action Center | `cases` (one per exception; state machine), `case_events`, `action_proposals`, `action_approvals`, `action_executions` (idempotency key, before/after, verification) |
| `0007_decision_lab.sql` | Decision Lab | `decision_scenarios`, `experiments`, `experiment_assignments` (or derived) |
| `0008_investigations.sql` | AI | `investigations`, `investigation_steps` (tool calls/results), `ai_eval_runs` |

Cross-module references go through ids in jsonb, not foreign keys, so modules migrate independently.
`npm run db:migrate` applies pending migrations to the demo database without reseeding.

## 4. Backend modules and their public contracts

Every function takes a `Queryable`/`Pool` first, enforces scope with `lib/viewer.ts`, and writes an
`audit_log` row for every state change.

**Identity (`lib/identity/`)**
- `resolveIdentities(pool, now)` — idempotent; deterministic links (exact CRM customer id; phone hash or
  email hash shared by exactly one CRM customer within the attribution window); ambiguous cases become
  `identity_conflicts`, never silent merges. A rejected pair stays rejected after re-runs unless its
  evidence fingerprint changes.
- `getCustomerJourney(db, crmCustomerId, scope)` → overview, identity links with rule/confidence,
  leads/calls, subscriptions, appointments, tickets, payments/refunds, attribution, conflicts,
  freshness, chronological timeline with source references (raw_event_id).
- `searchCustomers(db, filters, scope)`, `listIdentityConflicts(db, filters, scope)`,
  `decideIdentityConflict(pool, {conflictId, decision, reason, actor, now})`.

**Connectors (`lib/connectors/`, `lib/jobs/`)**
- `CrmConnector` interface: `validateConnection`, `capabilities`, `listOffices`, `search(entity, filter)`,
  `get(entity, ids)`, with typed errors (auth, rate limit, timeout, unavailable, bad record).
- `FieldRoutesHttpClient` (real HTTP over an injectable `fetch`; office-scoped credentials from env
  names, never stored in the database or sent to the browser; production writes disabled).
- Mock FieldRoutes server: a pure `(Request) => Response` handler served at
  `/api/mock/fieldroutes/...`, backed by the synthetic world, with documented search/get limits,
  pagination and fault injection.
- `enqueueSync`, `runPendingJobs` (claim with `for update skip locked`, retry with backoff, cancel,
  checkpoint only on success, one office failing never blocks others), `connectorHealth`.
- Synced records go through the existing `ingestRecords` + FieldRoutes mapper: no second write path.

**Action Center (`lib/workflow/`)**
- Case state machine: `detected → investigating → proposed → dry_run_verified → awaiting_approval →
  applied → verified → resolved`, plus `failed`, `cancelled`, `closed_acknowledged`,
  `closed_unresolvable`, `closed_insufficient_evidence`. Illegal transitions throw.
- `syncCases(tx, now)` (one case per exception; called at the end of reconcile).
- `createProposal(pool, {exceptionId, kind, params, rationale, source: "human" | "ai", actor})`,
  `dryRunProposal`, `approveProposal` / `rejectProposal` (approver role; never the proposer's role),
  `executeProposal` (application service: idempotency key, request fingerprint, transaction,
  before/after snapshot, verification, audit).
- Proposal kinds: `remap_channel`, `replay_quarantine`, `map_campaign`, `override_lead_branch`,
  `acknowledge_exception`, `resolve_identity_conflict`, `trigger_sync`. Executors reuse
  `replay`/`planReplay`/`lib/actions.ts`/identity/connectors.

**Decision Lab (`lib/decision/`)**
- Three separate verdicts per branch/channel/period: data integrity (records classified and
  reconciled), decision readiness (enough reliable evidence; extends `budgetSignal`), business
  effectiveness (only from a randomized experiment; never from attribution).
- `scenario(db, {branchId, period, changes, assumptions})` → projected outcomes with explicit
  assumptions, ranges, sensitivity and coverage. Labelled forecast, not causal.
- A/A experiment over synthetic leads (hash-randomized arms, no true effect): assignment integrity
  check (sample-ratio), difference in conversion with 95% CI, guardrails, conclusion.

**AI investigator (`lib/ai/`)**
- Fixed tool registry executed by the backend (no model-written SQL): `getBranchMetrics`,
  `getCustomerJourney`, `getSourceLineage`, `getIngestionFailures`, `getReconciliationExceptions`,
  `compareMappingVersions`, `inspectCampaignClassification`, `getMetricDefinition`, `getAuditHistory`,
  `getDecisionReadiness`. Each enforces viewer scope.
- Stages: investigator (tool use) → analyst (verified / strong / weak / missing) → planner (proposals
  via `createProposal`, source "ai", always pending approval).
- Output contract (zod-validated): summary, observations with evidence refs, suspected cause,
  confidence, next action, expected effect, risks, approval requirement.
- Model path: Anthropic Messages API with tool use when `ANTHROPIC_API_KEY` is set. Without it, a
  deterministic investigator runs the same tools and contract and is labelled "deterministic, no
  model". Evaluation set + scorer in `scripts/eval-ai.ts`.

## 5. Frontend modules

`/` Overview (existing, now in the shell) · `/customers`, `/customers/[id]` · `/integrations` (CRM
Integration Studio) · `/exceptions`, `/exceptions/[id]` (Action Center) · `/investigator`,
`/investigator/[id]` · `/decisions` · `/audit` · `/definitions`, `/feedback`, `/branches/[id]` (existing).
Use `components/ui.tsx` primitives and the colour tokens in `app/globals.css`; module components live
in `components/<module>/`. Every page: loading and error states, keyboard reachable, no hardcoded
numbers.

## 6. AI architecture

See §4. Safety: tools are read-only except `createProposal`; proposals never execute without dry run
+ approval by a different role; tool outputs are data and are delimited as such in prompts (prompt
injection inside record text is ignored and logged); every claim in the output must reference an
evidence id returned by a tool, enforced by a validator that drops or flags unsupported claims.

## 7. Integration contracts (FieldRoutes)

Details and sources: `research/17-fieldroutes-api-contract.md`. Search returns ids, get returns
records in bounded batches, keys are office-scoped, payments have no `dateUpdated` filter (wide
trailing window), zone-less office wall time. The mock implements the documented limits; anything
inferred is marked as such in the adapter docs.

## 8. Technical risks

| Risk | Mitigation |
|---|---|
| Parallel builders editing shared files | File ownership per module (§10); shared files only by the integrator |
| Existing numbers drifting | No change to the world's random draws; scenario test pins B20 and B09 numbers |
| Long syncs inside requests | Jobs table + worker (`npm run worker`), `after()` kick for demo |
| AI without credentials | Deterministic investigator with identical contract; clearly labelled |
| Identity over-merging | Deterministic rules only; ambiguity → reviewed conflict; tests for non-merge |
| Demo permissions mistaken for security | Banner + docs; production uses SSO claims |

## 9. Implementation order

Wave 1 (parallel): Identity + Customer 360 · Connectors + Integration Studio · Action Center + Audit ·
Decision Lab. Wave 2: AI Investigator (needs Identity + Action Center). Then integration of the golden
path, multi-role review, fixes, full verification, documentation.

## 10. File ownership during the parallel build

| Module | Owns |
|---|---|
| Identity | `lib/identity/**`, `app/customers/**`, `app/api/customers/**`, `app/api/identity/**`, `components/customers/**`, `database/migrations/0004_identity.sql`, `tests/integration/identity.test.ts`; may append one call to `lib/sim/seed.ts` |
| Connectors | `lib/connectors/**`, `lib/jobs/**`, `scripts/worker.ts`, `app/integrations/**`, `app/api/connectors/**`, `app/api/mock/**`, `components/integrations/**`, `0005_connectors.sql`, `tests/integration/connectors.test.ts` |
| Action Center | `lib/workflow/**`, `app/exceptions/**`, `app/audit/**`, `app/api/cases/**`, `app/api/proposals/**`, `components/actions/**`, `0006_action_center.sql`, `tests/integration/action-center.test.ts`; may append one call to `lib/reconcile/reconcile.ts` |
| Decision Lab | `lib/decision/**`, `app/decisions/**`, `app/api/decisions/**`, `components/decisions/**`, `0007_decision_lab.sql`, `tests/integration/decision-lab.test.ts` |
| AI | `lib/ai/**`, `app/investigator/**`, `app/api/investigations/**`, `components/investigator/**`, `0008_investigations.sql`, `scripts/eval-ai.ts`, `tests/integration/ai-investigator.test.ts`, `tests/unit/ai-*.test.ts` |

## 11. Acceptance criteria

All existing scenarios and tests still pass; Customer 360 is database-backed; the connector syncs
through HTTP against the mock with at least one recovered failure; investigations use real tools and
cite stored evidence; a proposal can be dry-run, approved by a different role and applied, with
verified database state; the UI reflects state after mutations; the B09 golden path works end to end;
no claim of real Moxie data or real CRM access; test and build results recorded as run.
