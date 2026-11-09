# Architecture

Every box below is implemented code unless marked **(proposed)**. Bounded contexts, aggregates and events: [domain-model.md](domain-model.md).

```
 Sources (synthetic)            Integration seam                       Truth layer                         Use
 ───────────────────            ────────────────                       ───────────                         ───
 Ad platforms  ─┐   SourceClient.fetchChanges(window)    raw_events (exactly once per          v_leads ─┐
 Call tracking ─┤   (polling, cursor + overlap;          source+version; redacted payload;     v_acquisitions ├─► scorecard (metrics)
 Website leads ─┼──► push: POST /api/ingest/:source) ──► status projected | quarantined) ──►   v_customer_revenue ┘   conversion bridge
 D2D sales app ─┤          │                                    │                                    │                Google feedback (dry run)
 CRM (FieldRoutes-         ▼                                    ▼                                    ▼
   inspired fields) ┘  redact → identify → map (versioned)   projections: leads, crm_*,       reconcile(): 6 detectors → exceptions
                       pure, unit-tested                      ad_spend_daily (source-clock         │ (fingerprinted, self-resolving)
                                                              guarded upserts)                     ▼
                                                                                         decisions: replay · map campaign ·
                                                                                         override lead branch · acknowledge · close
                                                                                         (all audited; replay idempotent)
```

## Where it would sit at a company that already has a lake **(proposed)**

The prototype uses Postgres as a **stand-in for lake tables**. A real deployment would not ingest
sources a second time. It would read the lake's landed rows (CRM, call tracking, ads, web) and add
what a lake does not give you by itself:

1. cross-system invariants expressed as SQL (the six detectors),
2. an exception queue with record-level evidence and an owner,
3. decisions that are audited and recompute the numbers,
4. outbound conversion feedback that only reports reconciled outcomes.

In a Dagster shop, `replay` maps to "re-materialise downstream assets after a mapping fix", and the
detectors become asset checks that write to an exceptions table read by the BI layer.

## Modules

| Path | Responsibility | Notes |
|---|---|---|
| `lib/adapters/contract.ts` | `SourceClient` (transport) and `SourceMapper` (meaning) interfaces, projection row types | Swap a mock for a real client without touching mapping, ingestion or reconciliation |
| `lib/adapters/redact.ts` | Hash contact details before anything else sees a payload; strip them from free text | Shape- and key-aware; replay-safe tokens |
| `lib/adapters/crm-fieldroutes.ts` | CRM mapper modelled on the public FieldRoutes API shape (string ids, zone-less office wall time, `officeID`, status codes, zero-dates) | Unknown status codes are rejected, not guessed |
| `lib/adapters/marketing.ts` | Call tracking (v1.0 and v1.1), website lead events, D2D sales, ad spend | v1.1 is the fix for the seeded incident |
| `lib/ingest/ingest.ts` | Exactly-once write of a batch; duplicate vs conflict; projection isolation; polling runs with cursors | One transaction per run; failed runs never advance the cursor |
| `lib/ingest/project.ts` | Set-based upserts, guarded by the source clock | Order-independent: a late older version is a no-op |
| `lib/ingest/replay.ts` | Re-run quarantined records through a mapper version; dry run in a rolled-back transaction | Idempotency key bound to the request; row-claim prevents double processing |
| `database/migrations/0002_attribution_views.sql` | Attribution as views (never stored) | First evidenced touch; unknown stays unknown |
| `lib/reconcile/reconcile.ts` | Six detectors → exceptions | Advisory-locked, idempotent, self-resolving |
| `lib/ingest/replay-plan.ts` | Which stored records a replay for an exception touches, and how | One place for the API, scripts and tests |
| `lib/metrics/decision.ts` | Budget signal + the open exceptions that make it untrustworthy | ChangeGuard gate |
| `lib/metrics/scorecard.ts` | All metrics, branch-scoped in SQL | Definitions in docs/metric-definitions.md |
| `lib/feedback.ts` | Which serviced customers would be reported to Google Ads, and why not | Dry run only; nothing is sent |
| `lib/viewer.ts` | Roles and branch scope | Demo role picker; enforcement is server-side |
| `lib/sim/*` | Deterministic synthetic world, in-memory source clients, the seed | Fictional branches; parameters from research/07 |
| `lib/identity/*` | Identity resolution (deterministic rules → `identities`, `identity_links`, `identity_conflicts`) and the Customer 360 journey | Never merges two CRM customers; ambiguity becomes a reviewed conflict. See "Identity resolution" below |
| `lib/connectors/*`, `lib/jobs/*` | FieldRoutes-compatible read-only connector over real HTTP, the local mock it talks to, sync jobs (claim with SKIP LOCKED, backoff, checkpoints), the Integration Studio read models | Synced records go through `ingestRecords` + the FieldRoutes mapper: no second write path. The mock is synthetic; no real CRM is called |
| `lib/workflow/*` | Action Center: one case per exception, a checked state machine, proposals → server-side dry run → approval by a different role → execution by the application, verified and audited | Executors reuse `replay`, `lib/actions.ts`, and the identity and connector ports |
| `lib/decision/*` | Decision Lab: integrity, readiness and effectiveness verdicts kept separate; scenario forecasts; an A/A experiment | Effectiveness stays "unknown" without a randomized experiment, however clean the data |
| `lib/ai/*` | Investigator over a fixed, read-only tool registry; analyst grounding; a planner that can only create Action Center proposals (source `ai`) | A deterministic investigator with the same contract runs when no model key is configured, labelled as such |
| `lib/events/*` | Domain events: transactional outbox (`recordEvent`), consumers covered by snapshot visibility (`dispatchEvents`) | ADR-17; contexts publish, they do not call each other to stay fresh |
| `lib/metrics/brands.ts`, `lib/reference.ts` | Organization kernel: Company → Brand → Branch → CRM office; channel measurement classes; brand rollups via the company `totals()` | ADR-18; brand assignment synthetic |
| `database/migrations/0010_reporting_contract.sql` | Published language for BI: `reporting.*_v1` | ADR-19, docs/reporting-contract.md |
| `app/**` | Next.js 16 App Router pages (server components) and REST route handlers | Data reads stream inside Suspense (Cache Components) |

## Golden path (Revenue Signal OS)

The B09 scenario, end to end, as `tests/e2e/os-golden-path.spec.ts` drives it:

1. **Overview** lists "Budget decisions on hold" (open decision-blocking exceptions,
   `decisionHolds`); B09 shows a channel imbalance. The **branch** page's budget signal is
   "not trustworthy yet" and names the incident.
2. **Decision Lab** (`/decisions?branch=B09`) leads with the readiness summary: not ready, blocked
   by the incident, with links to it and to an investigation.
3. The **incident** (`/exceptions/<id>`) shows campaign lineage, the stored spend records and the
   mapper version that classified them, the leads that kept arriving, and their CRM outcomes
   (customers, invoiced, collected; each customer links to Customer 360).
4. **Investigate with AI** opens `/investigator?exception=<id>`. The investigator runs its tools
   with the viewer's scope, cites the evidence ids they returned, and its planner creates a
   `remap_channel` proposal (source `ai`, pending).
5. An **integration engineer** dry-runs it: executor, reconciliation and verification run in a
   transaction that is always rolled back; the before/after snapshot and the precondition
   fingerprint are stored.
6. An **approver** (never the proposer's role) approves that dry run.
7. The **application** executes it once (idempotency key derived from the fingerprint),
   re-projecting the stored spend records through `ads@1.1` and recording campaign lineage.
8. Reconciliation re-runs in the same transaction; **verification** requires the exception to be
   resolved and total ad spend, raw events, CRM customers, invoiced and collected to be unchanged.
   Any mismatch rolls the whole execution back.
9. The **audit trail** holds the investigation, the proposal, the dry run, the approval and the
   execution (actor `revenue-signal-app on behalf of approver`), all on the case.
10. Overview, branch and Decision Lab read the new state: the hold is gone, the signal is sound.

The B20 call-feed incident works both through the legacy replay panel and as a
`replay_quarantine` proposal through the same workflow.

After a committed replay, an executed proposal or a connector sync that stored records, the
change's own transaction has published a domain event (`intake.records_stored`,
`intake.records_reprojected`, `action_center.proposal_executed`). `dispatchEvents`
(`lib/events/consumers.ts`) runs after the response (`after()`), at the end of a sync drain and
in every worker loop; reconciliation and identity re-run only when their last run provably did
not see the change (snapshot visibility, docs/domain-model.md §4). A consumer failure is
recorded on `event_consumers`, leaves the events pending, and never fails the change.

## Identity resolution

Rules (`lib/identity/resolve.ts`, migration `0004_identity.sql`), all set-based SQL in one
transaction under an advisory lock:

| Rule | Link | Confidence |
|---|---|---|
| Every CRM customer anchors exactly one identity (`crm_customer_anchor`) | — | 1.0 |
| A lead whose phone hash matches exactly one CRM customer (`exact_phone_hash`) | lead → that customer | 1.0 |
| Else a lead whose email hash matches exactly one CRM customer (`exact_email_hash`) | lead → that customer | 1.0 |
| A lead matching more than one customer, or whose phone and email point at different customers | not linked: one pending `identity_conflict` per (lead, candidate) | — |
| Leads matching no CRM customer | grouped into prospect identities by phone hash, else email hash | — |
| A reviewer accepts a conflict (`reviewer_accepted`) | lead → the accepted customer; its other candidates are rejected | 1.0 |

Conflict lifecycle: `pending → accepted | rejected`, or `superseded` when the evidence changes or
the lead stops being ambiguous. Every decision binds to an evidence fingerprint: a rejection holds
across re-runs and replays; changed evidence opens a new pending conflict that points at the
earlier decision. Deciding needs the `reviewIdentity` permission (marketing analyst, integration
engineer) and a reason, and writes an audit row. Two CRM customers are never merged and there is
no fuzzy matching: a phone typo stays two people.

Demo counts (measured on the reseeded demo database) are in `docs/testing.md`. The synthetic
world gives every person a unique phone, so the demo itself has no ambiguous identities; the
review queue is exercised by `tests/integration/identity.test.ts` and by the e2e fixtures in
`tests/e2e/db.ts`.

## Failure and recovery paths

| Failure | What happens | Where |
|---|---|---|
| Source API down (the seeded 503) | Run recorded `failed`; cursor not advanced; next run re-reads the window | `runStream` |
| Same record delivered again (overlap windows, retries) | `delivery_count + 1`; no projection change | `ingestRecords` |
| Same version, different content | `payload_conflict` exception; first version kept | `ingestRecords` |
| Clock-less record changes (payment status, call attribution) | New content = new version, ordered by receipt; latest observation wins, including A → B → A | `versionClock: "received"` |
| Record fails validation (new payload shape, unknown branch, out-of-range id) | Quarantined with a precise error; batch continues | mappers, `ingestRecords` |
| Record passes validation but the database rejects it | Isolated by savepoint and quarantined as `PROJECTION_FAILED`; batch continues | `projectIsolated` |
| Out-of-order arrival (payment before its invoice) | Projected anyway (no FKs between projections); `payment_without_ticket` exception; clears itself when the invoice arrives | reconcile |
| Mapper fixed after the fact | Dry run, then replay; metrics recompute in the same transaction; repeat is a no-op | `replay` |
| Two replays race | Each record claimed once by a conditional UPDATE; same key → stored result | `replay` (tested on real Postgres) |
| Valid record, wrong meaning (a platform re-types a campaign, e.g. LSA → Performance Max) | Coverage-gap rule: a paid channel keeps producing leads while its spend stops; evidence names the successor campaign in the same account; budget signal blocked; re-map stored records through the fixed mapper (`reproject`), lineage recorded | `reconcile` (detector 6), `lib/metrics/decision.ts`, `replay` |
| CRM API rate limit, timeout or 503 during a sync | Typed error; the job backs off (Retry-After honoured, else exponential) and resumes after its last committed batch; the checkpoint moves only when the window's last batch commits | `lib/jobs/sync.ts` |
| Expired or missing CRM credentials | The job fails at once and names the env vars to fix; no retry; checkpoint unchanged | `lib/jobs/sync.ts` |
| Records change between an approved dry run and its execution | The precondition fingerprint no longer matches: nothing runs, the proposal goes stale and needs a new dry run and approval | `executeProposal` |
| A fix would change the ledger (spend, customers, invoices, collected) | Verification fails; the execution savepoint is rolled back; the failure is recorded and the case moves to failed | `executeProposal` |
| Platform stops serving history (old LSA reports do not move to Google Ads) | A later re-pull without those rows deletes nothing: projections are upserts, the raw log is append-only | `ingestRecords` (tested) |

## Observability (implemented)

- `ingestion_runs`: one row per run with window, counts, status and error.
- `raw_events.delivery_count`, `received_at` vs `occurred_at` (two clocks).
- `audit_log` for every decision, replay, proposal step, identity decision, investigation and sync job.
- `/audit` (Audit & Health): the filterable audit log, Action Center throughput, stream freshness,
  ingestion runs and the connector health summary (`connectorSummaries`).
- `sync_api_calls`: every connector HTTP exchange per job attempt (credentials never recorded).
- `GET /api/health` (database reachable, migrations applied, last success per stream; no error details leaked).
- Structured JSON logs on replay and route errors.

**(proposed)** alerting on freshness SLOs per stream and on new quarantine groups; metrics export.

## Security posture

| Implemented | Proposed for production |
|---|---|
| PII hashed at the boundary; free-text contact details removed | Key rotation for hashing (pepper) |
| Branch scoping in SQL for every read; refusals (403) not silent filtering | SSO (Google Workspace) replaces the demo role picker; `/api/role` removed |
| Least-privilege default (read-only guest) | Row-level security in the database as a second line |
| Ingest API key, constant-time compare, fails closed in production | Per-source keys, HMAC signatures for webhooks |
| zod validation on every route body; errors never leak internals | Rate limits |
