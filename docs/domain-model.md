# Domain model

Revenue Signal OS, described the way Eric Evans would ask for it: what the core domain is, where
the model's boundaries are, how the contexts relate, which rules each aggregate protects, and
how facts move between contexts. Vocabulary lives in [`GLOSSARY.md`](../GLOSSARY.md); decisions
in [`decisions.md`](decisions.md) (ADR-15 to ADR-19). Independent concept, synthetic data, not
a Moxie system.

## 1. Domain vision

> Marketing claims and the company's ledger disagree. This system makes the disagreement
> **explicit, explained and fixable**, and refuses to let a budget decision rest on data that
> has not been reconciled.

The money question ("which channel makes us money?") is easy to ask and easy to answer wrongly.
The hard and valuable part is knowing **when an answer is trustworthy**. That is the core
domain.

| Subdomain | Kind | Why |
|---|---|---|
| Reconciliation + Decision readiness | **Core** | The differentiator: cross-system invariants, exceptions with evidence, the budget-signal gate, integrity ≠ readiness ≠ effectiveness |
| Intake (raw events, versioned mappers, replay) | Supporting | Must be exact (once per version, two clocks, quarantine), but it is plumbing in service of the core |
| Identity | Supporting | Ties leads to customers without ever silently merging two customers |
| Action Center | Supporting | Turns an exception into a reviewed, verified change |
| Investigation (AI) | Supporting | Reads evidence, proposes; never acts |
| CRM Sync | Supporting | Gets FieldRoutes-shaped records in, office by office |
| Organization, Access | Generic | Brands, branches, roles, scope |
| Audit | Generic | Who did what, when |

## 2. Context map

```
                      ┌────────────────────────── Organization (shared kernel) ──────────────────────────┐
                      │ Company → Brand → Branch → CRM office · Channel + measurement class · Viewer scope │
                      └───────────────────────────────────────────────────────────────────────────────────┘
                                         ▲ every context references these by id
 FieldRoutes API ──ACL──► CRM Sync ──customer/supplier──► INTAKE ◄──ACL── call tracking, web, D2D, ad platforms
 (upstream, not ours)     jobs, windows,                 raw events, versioned mappers,
                          checkpoints, fencing           projections, quarantine, replay
                                                              │ intake.records_stored / records_reprojected
                                                              ▼
                     ┌──────────── RECONCILIATION (core) ────────────┐        IDENTITY
                     │ detectors → exceptions (fingerprint,          │        identities, links,
                     │ self-resolving); measurement; budget signal   │        conflicts, journey
                     └───────────────────────────────────────────────┘
                          │ exception = case          ▲ reads                    ▲ reads
                          ▼                           │                          │
                     ACTION CENTER ── proposals ──► executes through Intake (replay) and Organization (mappings)
                     cases, state machine,           publishes action_center.proposal_executed
                     dry run, approval, execution
                          ▲ proposals (source "ai")
                     INVESTIGATION (read-only tools, cited evidence)

                     DECISION LAB ── reads Reconciliation + Measurement; effectiveness only from experiments

 Published language (downstream, read-only):  reporting.*_v1 views ──► Power BI / Fabric / a warehouse
 Conformist (downstream of Google):           conversion feedback (dry run) follows Google Ads' upload contract
```

| Relationship | Pattern | Where it is enforced |
|---|---|---|
| FieldRoutes → CRM Sync → Intake | **Anticorruption layer**: the FieldRoutes mapper translates zone-less office wall time, string ids, status codes and zero-dates into our model; unknown codes are rejected, never guessed | `lib/adapters/crm-fieldroutes.ts`, `lib/connectors/fieldroutes-mapping.ts` |
| Every source → Intake | **ACL per source, versioned**: a mapper version is part of a record's lineage, so a wrong translation is replayed, not patched | `lib/adapters/*`, `raw_events.adapter_version` |
| CRM Sync → Intake | **Customer/supplier**: Sync is a client of Intake's single write path (`ingestRecords`); it has no second way to write records | `lib/jobs/sync.ts` |
| Intake → Reconciliation, Identity | **Domain events** (outbox), eventually consistent | `lib/events/*` |
| Action Center → Reconciliation | **Synchronous, same transaction**: an execution's verification needs the reconciled result before commit | `lib/workflow/proposals.ts` |
| All → Organization | **Shared kernel**, changed only with every context's tests green | `lib/reference.ts`, `lib/viewer.ts`, `0009` |
| Us → BI | **Published language**, versioned | `reporting.*_v1`, [`reporting-contract.md`](reporting-contract.md) |

## 3. Aggregates and the invariants they protect

An aggregate is the unit of consistency: everything inside changes in one transaction, under
one lock. Everything between aggregates is eventually consistent unless stated.

| Aggregate (root) | Context | Invariants | Guard |
|---|---|---|---|
| **Raw event** (source, external id, version) | Intake | Stored once per version; a conflicting payload for a version already stored is recorded, never overwritten; a late older version never beats a newer one (source clock) | unique key; guarded upserts; tests/integration/invariants |
| **Replay** (idempotency key) | Intake | A key answers one request; a record moves to `replaying` once; a dry run changes nothing | key ↔ fingerprint; row claim; rolled-back transaction |
| **Sync job** (connector × office × entity × window) | CRM Sync | One running job per stream; the checkpoint moves only with the batch that completes the window; **only the current claimant writes** (fencing token = claimed_by + attempt); a lost worker uses up an attempt | partial unique index; fenced updates; `requeueStale` |
| **Exception** (fingerprint) | Reconciliation | One exception per condition; it resolves itself when the condition is no longer detected; an acknowledged one stays acknowledged while the condition persists | fingerprint unique; reconcile lock |
| **Case** (one per exception) | Action Center | Only legal state transitions; terminal states are terminal | `lib/workflow/states.ts` |
| **Proposal → Execution** | Action Center | Approved by a role other than the proposer's; executed only against the approved dry run's precondition fingerprint; verified or rolled back whole; executed at most once | separation of duties; fingerprint; idempotency key; savepoint |
| **Identity** | Identity | Never merges two CRM customers; ambiguity becomes a reviewed conflict; a rejected pair stays rejected until its evidence changes | deterministic rules; conflict fingerprint |
| **Experiment** | Decision Lab | Arms are assigned by hash, not by outcome; effectiveness is claimed only from a randomized test | sample-ratio check |

## 4. Domain events

Facts a context publishes for the others, written in the **same transaction** as the change
(transactional outbox, `domain_events`). Names are `<context>.<fact in the past tense>`.

| Event | Published by | Means |
|---|---|---|
| `intake.records_stored` | `ingestRecords` (every write path: seed, push, poll, CRM sync) | New record versions or payload conflicts were stored |
| `intake.records_reprojected` | `replay` (committed) | Stored records were re-mapped through another mapper version |
| `reconciliation.run_completed` | `reconcile` | A full run finished; carries the snapshot it read |
| `identity.resolution_completed` | full `resolveIdentities` | A full resolution finished; carries the snapshot it read |
| `crm_sync.job_succeeded` | sync worker | A job's window is stored and its checkpoint moved |
| `action_center.proposal_executed` | `executeProposal` | A proposal was applied and verified |

**Consumers** (`lib/events/consumers.ts`) are coarse, idempotent recomputations:

| Consumer | Triggered by | Runs |
|---|---|---|
| reconciliation | records_stored, records_reprojected | one full reconcile |
| identity | records_stored, records_reprojected, proposal_executed | one full resolution |

**Delivery without gaps or waste.** Each run-completed event carries
`pg_current_snapshot()` taken at the start of the run, plus the run's own transaction id. An
event is *covered* when its writing transaction is visible in that snapshot (or it was written
earlier in the run's own transaction). Dispatch runs a consumer only if something is uncovered,
then marks delivered only what the new run covers. Event ids are **not** commit order, so an
offset would skip an event whose transaction committed late; snapshot visibility cannot. The
test "an event whose transaction commits after a run started is not covered by that run"
reproduces exactly that interleaving.

**Consistency policy.** Inside an aggregate: synchronous. Across contexts: events. One
deliberate exception: an Action Center execution reconciles inside its own transaction,
because "verified" must mean the exception is resolved and the ledger is unchanged *before*
the change commits (ADR-17).

## 5. Organization: brand as a first-class dimension

`Company → Brand → Branch → CRM office`. The posting asks for software that supports "multiple
branches, brands, and departments"; the CMO runs Moxie and Joshua's together.

* Brand names are public; **which fictional branch trades under which brand is synthetic**
  (B27–B31 Mission, B40–B44 Joshua's, the rest Moxie).
* Brand is a way to **grant** and to **slice** scope, never a second enforcement path: a brand
  role is expanded to its branches once, in `lib/viewer.ts`, and every query keeps enforcing
  the branch list (ADR-18).
* A partial view of a brand is refused rather than shown under the brand's name (the B20
  partner cannot open "Moxie").
* Brand lines are computed like the company line (`totals()`), never by summing branch rows:
  distinct prospects are not additive. Spend on a campaign mapped to no branch belongs to no
  brand.

## 6. Channel measurement classes

A channel's **measurement class** says what evidence can ever show its effect, which bounds
what a budget decision may rest on:

| Class | Channels | Evidence |
|---|---|---|
| touch_attributed | Google Search, Local Services, Microsoft, Meta, Google Business Profile | per-lead touch (click id, tracked number) |
| rep_recorded | Door-to-door | the CRM records the selling rep |
| landing_inferred | Organic search & AI answers (SEO/GEO) | landing page, "how did you hear"; directional |
| experiment_only | Sponsorships & brand media (arena, college clubs) | only a geo or holdout test |
| no_evidence | Unknown | none; stays unknown |

The synthetic world generates no SEO or sponsorship records (adding them would shift every
random draw and every pinned scenario number), so those channels show empty rows: the model is
ready, the data is honestly absent.

## 7. What is deliberately not "textbook DDD"

* **One deployable, one database** (ADR-15). Contexts are module boundaries with file
  ownership, ids instead of cross-context foreign keys, and events between them, not
  services. A team of a few engineers gets the boundaries without the distributed-systems
  tax; a context can be extracted later because it already talks through ids and events.
* **No repository layer or ORM** (ADR-6). Set-based SQL is the domain logic for
  reconciliation and attribution; wrapping it in objects would hide the invariants.
* **Attribution is a view, not an aggregate** (ADR-8): derived, never stored, so a fixed
  mapping recomputes history.

## 8. Open questions in the model

These are known gaps; none is papered over.

* **FieldRoutes translation details** (research/17): Pacific wire time vs office time zone,
  `isInitial` vs a sales anchor, NA tickets, payments applied to several invoices, negative
  ids. The mapper marks each inferred rule as such; a real account would settle them.
* **Departments** (the posting's third axis) are not modelled; roles stand in for them.
* **Who owns marketing analytics** (CTO's team or the CMO's) decides who owns exceptions of
  each kind; today ownership is per role.
