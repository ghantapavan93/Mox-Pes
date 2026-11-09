# Decisions

Short ADRs. Each says what was chosen, what was rejected, and what would change the decision.

## ADR-1 Build a reconciliation layer, not a dashboard
**Chosen:** detect where records stop agreeing, show evidence, fix, recompute (research/15).
**Rejected:** multi-branch dashboard (Power BI/Fabric already in use per a public data-team posting;
FieldRoutes reports CAC), follow-up tool (Hatch/Podium/CallRail CI cover it), generic integration console.
**Would change if:** the company already joins call tracking, CRM and ads at record level with
exceptions owned by someone. That is the first interview question.

## ADR-2 Flagship incident: a call-tracking payload change, not a CRM appointment change
The first design quarantined CRM appointments. The red team showed it cannot break revenue-to-lead
lineage in a FieldRoutes shape (payments and tickets carry `customerID`; source sits on customer and
subscription). The call ↔ customer match is the join no vendor provides (CallRail lists no
FieldRoutes integration — research/06), so breaking it breaks attribution for real.

## ADR-3 Polling with cursors and overlap, plus push for event sources
FieldRoutes documents no webhooks and payments have no `dateUpdated` filter (research/06). Polling
with a cursor that only advances on success, an overlap window, and a wide trailing window for
payments. Push (`POST /api/ingest/:source`) exists for sources that do deliver events.

## ADR-4 Raw event log + projections, keyed by record version
`(source, external_id)` unique where `external_id = entity:id:version`. Gives exactly-once writes,
replay from stored payloads, and an audit of what each source said when. Version = the source clock
where one exists; content + receipt order where none does (payments, call updates). Review finding
F2/F9 forced the second half.

## ADR-5 No foreign keys between projections
Sources arrive out of order. A payment before its invoice is a reconciliation exception that clears
itself, not an insert failure that stalls a stream.

## ADR-6 Raw SQL and hand-written migrations, no ORM
The metric definitions are the product; reviewers should read them as SQL. Migrations are append-only
with checksums. The detector SQL is ANSI-leaning and portable to SQL Server/Fabric with small changes.
**Rejected:** Drizzle (its CLI failed to install on Windows here; and an ORM hides the SQL that matters).

## ADR-7 Real Postgres, not an embedded database
An embedded single-connection database would make the concurrent-replay test pass trivially. Tests run
on Postgres 17 (local install or `docker compose`), and CI uses a Postgres service container.

## ADR-8 Attribution derived in views, never stored
Changing the policy re-derives history; a replay re-attaches leads without a backfill job.
Performance: per-customer `LATERAL` index lookups (a `DISTINCT ON` version re-ran per row: 33 s → 44 ms
for a branch-scoped query; docs/testing.md).

## ADR-9 Fictional branches, synthetic data, real shape
44 branches across five time zones (one without DST), parameters from industry ranges (research/07),
asserted in tests. No real metros: a bad number next to a real branch would read as grading a real
branch partner.

## ADR-10 No AI in the build
Every AI candidate failed the removal test here (research/10): explanations, NL queries and triage are
done as well by templates and SQL; the one plausible use (classifying free-text "how did you hear
about us") depends on an input that may not exist when the CRM's source field is a dropdown. Adding a
model would be decoration. **Would change if:** the team has free-text lead notes or call transcripts
in volume — then a validated, abstaining source classifier is the first candidate (schema and
validator are specified in research/10).

## ADR-11 Demo roles without passwords, enforcement on the server
A cookie picks the role so a reviewer can switch views. What is real is that every read and write
resolves scope server-side and refuses out-of-scope requests. Missing role = read-only guest.
Production replaces the picker with SSO claims.

## ADR-12 Google conversion feedback stays a dry run
It shows the decision logic (what to report, retract or hold, and why) without credentials, spend or
network calls. Field names follow the 2026 Data Manager API path and must be verified before use.

## ADR-13 Channel classification belongs to each mapped record (ChangeGuard)
**Chosen:** `ad_spend_daily.channel_code` is written by the mapper version that projected the record;
metrics read it. A corrected mapper re-projects stored records (replay mode `reproject`, claimed by
`status = 'projected' and adapter_version = <old>`), which rewrites classification and never money.
**Rejected:** keeping channel only on `ad_campaigns` (a fix silently rewrites all history, with no
record of which version said what), and deleting/re-ingesting history (the platform no longer serves
old Local Services reports after migration, per Google).
**Why it matters:** the failure is silent. Records are valid; their meaning is wrong. Only a
cross-system rule (leads without spend) sees it.

## ADR-14 Budget signals carry their blockers
**Chosen:** a channel budget signal is returned together with the open exceptions that change what a
channel cost or produced (coverage gap, held source records, unmapped spend), and is marked "not
trustworthy yet" while any is open. The signal rule (≥ 1.5× cost per customer) is deliberately naive
and labelled illustrative.
**Rejected:** suppressing the signal (people then act on the raw dashboard instead) and blocking on
every exception kind (D2D/paid conflicts are long-lived and would block forever).
**Would change if:** the team already gates spend decisions on data-quality checks elsewhere.

## ADR-15 Bounded contexts inside one deployable and one database
**Chosen:** the contexts in docs/domain-model.md (Intake, CRM Sync, Reconciliation, Identity,
Action Center, Investigation, Decision Lab, Organization) are module boundaries: each owns its
files and tables, refers to other contexts' records by id (ADR-5), and learns about their changes
through domain events (ADR-17). One Next.js app, one worker, one Postgres.
**Rejected:** a service per context (a few engineers would pay for network failure modes,
distributed transactions and deploy choreography before any context needs to scale apart), and
one undivided module (the reconcile/identity/workflow rules would leak into each other).
**Would change if:** one context needs independent scaling or ownership by another team. It can be
lifted out along the lines it already talks through: ids and events.

## ADR-16 Sync job claims carry a fencing token
**Chosen:** every write a sync worker makes after claiming a job is conditioned on
`claimed_by = <worker> and attempts = <attempt>`. A worker presumed dead (stale heartbeat) whose
job was re-claimed can wake up, but its batch rolls back, it never moves the checkpoint and it
records no outcome. A lost worker uses up an attempt, so a job that keeps killing workers fails at
max_attempts instead of looping.
**Rejected:** trusting the heartbeat alone (a long GC pause or a hung HTTP call makes a live worker
look dead: two writers), and leases with a lock held across the HTTP call (a connection per
in-flight job, and the lock dies with the session anyway).

## ADR-17 Domain events through a transactional outbox, covered by snapshot visibility
**Chosen:** a context records `domain_events` rows in the same transaction as its change. Consumers
(reconciliation, identity) are coarse idempotent recomputations; each run publishes the snapshot it
read, and an event is delivered only once a run's snapshot provably covers its transaction.
Contexts no longer call `reconcile()` or identity resolution "to keep things fresh"; they publish.
**Kept synchronous on purpose:** an Action Center execution and a replay reconcile inside their own
transaction, because their verification must see the reconciled result before committing.
**Rejected:** direct calls after every write (every new write path must remember every reader, and
a crash between write and call loses the update), a message broker (another system to run for two
consumers in one database), and offset-based consumption (bigserial ids are not commit order: an
offset skips an event whose transaction commits late).
**Invariant for publishers:** record an event before the reconcile that should cover it in the same
transaction.

## ADR-18 Brand is part of the Organization kernel; scope stays a branch list
**Chosen:** `Company → Brand → Branch → CRM office`, with `branches.brand_id`. A brand-scoped role is
expanded to its branches in `lib/viewer.ts`, so every query keeps enforcing one thing. Opening a
brand requires seeing all of it; brand numbers come from the same `totals()` as the company line.
Brand names are public; the branch-to-brand assignment is synthetic.
**Rejected:** brand as a free-text tag on records (no single answer to "which brand is this branch"),
and a second brand filter beside the branch filter in every query (two enforcement paths drift).

## ADR-19 BI reads a versioned published language, never the internal tables
**Chosen:** `reporting.*_v1` views with a stated grain, no contact details, pinned by a test that
also checks the facts add up to the app's own metrics. A breaking change ships as `_v2` beside
`_v1`. Power BI or Fabric (the company's VERIFIED BI stack) would read these, or a pipeline would
copy them into the lake.
**Rejected:** pointing BI at the public schema (every internal refactor would break a dashboard
someone else owns), and exporting files (no contract, no freshness).
