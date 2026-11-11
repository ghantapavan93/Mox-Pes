# Technical deep dive

For an engineer reviewing the system. Each section names the code and the test that holds it.

## 1. Database design

- **Raw ledger first.** Every delivered record is stored in `raw_events` before it means
  anything:
  - source, entity, external id (`entity:id:version`), payload (redacted at ingest), payload
    hash;
  - mapper version, status;
  - `delivery_count` and `last_delivered_at` (each delivery's own receipt time).
- **Projections are derived.** `leads`, `crm_*` and `ad_spend_daily` are projections of the
  ledger by a versioned mapper. A replay re-derives them from stored payloads with a newer mapper
  (`lib/ingest/replay.ts`).
- **Two version clocks** (`lib/adapters/contract.ts`):
  - *source*: the source stamps versions (`dateUpdated`, `fetchedAt`); the newest source time
    wins.
  - *received*: no version stamp (FieldRoutes payments, call-tracking calls); content identifies
    a version and receipt order decides.
- **Proof the projection is the ledger:** `ledger-model.test.ts` generates 24 seeded random
  histories (out of order, duplicated, A→B→A flips, voids, refunds). The incremental projection
  equals a pure reference model and a full rebuild from the ledger. A negative control shows the
  rebuild needs each version's last observation.
- **Constraints the application cannot bypass:**
  - separation of duties: CHECK constraint plus trigger (0014);
  - audit log and opportunity overrides are append-only (triggers, 0014 and 0016);
  - cross-brand CRM id moves are quarantined (trigger, 0015);
  - money is integer cents.
- **Reporting contract:** versioned views `reporting.*_v1`; a breaking change adds `_v2` beside
  it.

## 2. Transactions and concurrency

- **Intake:** each batch is one transaction (`ingestRecords`). Live lead intake (calls, web,
  D2D) takes a **shared** advisory lock (`LEAD_WRITE_LOCK`) first. An onboarding publication
  takes it **exclusive** first.
  - The earlier `lock table leads` deadlocked against live intake on an identical payload.
    Reproduced as 40P01, fixed by taking the advisory lock first on both sides.
- **Publication** (`publishUpload`): lock, re-compile, re-compare, write in one transaction. It
  holds its approved mapping `FOR SHARE`, so an approval that would supersede the mapping waits.
- **Proof:** `concurrency.test.ts` stages every race with gates or a held transaction, and
  proves the competing side is blocked from `pg_stat_activity` before releasing it. No sleeps.
  Cases:
  - publication vs webhook, in both orders;
  - an identical payload from both sides;
  - an approval superseded mid-publication;
  - a crash after the write, then a retry;
  - a double submit;
  - two deliveries of one record;
  - retention purge vs publication.
- **Workers:** single-row `FOR UPDATE SKIP LOCKED` claims, fencing tokens, a partial unique
  index for one running job per stream, checkpoints moved only in the last batch's transaction
  (`connectors.test.ts`, worker takeover).

## 3. Identity and authorization

- **Viewer.** `Viewer` = role + **subject** (the person) + branch/brand scope + permissions
  (`lib/viewer.ts`). Demo mode has one synthetic subject per role; production would map SSO
  claims to the same type (**not implemented**; `SECURITY-ASVS.md` V6).
- **Separation of duties is by person.** Proposals, approvals, mapping decisions, publications
  and overrides record the subject. The database refuses an approval by the proposing subject
  (`security.test.ts`).
- **Scope.** Scope is resolved once per request (`resolveScope`); a branch outside scope is a
  403, and an out-of-scope incident reads as missing (`golden-path`).
- **CSRF.** `proxy.ts` refuses cross-site state-changing `/api` calls (`sec-fetch-site`, then
  Origin against Host). The role cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` over TLS.

## 4. Events

- **Outbox.** `domain_events` is written in the same transaction as the change (outbox), for
  example `intake.records_stored` and `action_center.proposal_executed`.
- **Delivery.** At least once, with idempotent consumers. Not "exactly once".
- **Downstream.** Identity resolution and reconciliation consume the events. The web app drains
  the queue after the response (`after()`); `npm run worker` does the same out of process.

## 5. APIs

| API | Contract |
|---|---|
| `POST /api/ingest/:source` | 1–500 records, ≤ 2 MB, `x-ingest-key` compared in constant time, idempotent per external id, bad records quarantined |
| `/api/onboarding/*` | Raw bytes ≤ 5 MB; versioned mapping spec; publication only through intake |
| `/api/opportunities` | GET a journey brief. POST an override, recomputed server-side |

All errors are uniform JSON (`lib/http.ts`); unexpected errors are logged, never leaked.
Vendor-facing contracts and their gaps: `VENDOR-CONTRACTS.md`.

## 6. AI and its evaluation

- **Schema assistant** (`lib/onboarding/assistant.ts`):
  - deterministic: no model, no data egress, $0;
  - suggests and abstains; a person must save, and a different person approve.
  - Evaluated on three independently written sets. On held-out v3: 2.2% wrong suggestions,
    precision 97.8%, one critical error against the baseline's six.
  - Calibration is not established.
  - Severity-weighted gate in CI (`AI-EVALUATION.md`).
- **AI investigator:**
  - deterministic mode evaluated on 15 cases (`docs/ai-evaluation.md`);
  - model mode not evaluated, because no key is authorised;
  - cites stored records and proposes; it cannot execute.

## 7. One validation path for unfamiliar data

An uploaded row is never validated by onboarding-specific rules alone. The approved mapping
**compiles** each row into the payload the live feed would send, and the deployed mapper
validates it through `prepare()`, the same function live intake uses. The dry run therefore
quarantines what production would quarantine, with the same codes.

```
bytes ─► parse (CSV/XLSX/JSON, bounded) ─► profile (every row) ─► assistant (suggests, abstains)
      ─► person: mapping version (spec hash; date order; zone; money meaning; value translations)
      ─► compile row ─► prepare() with the deployed mapper ─► in-file duplicates/conflicts
      ─► future-timestamp check ─► compare with ledger (same grain only)
      ─► a different person approves the exact spec hash
      ─► publish: lock, re-compile, re-compare, ingestRecords() for rows the ledger still lacks
      ─► intake.records_stored (same transaction) ─► identity + reconciliation consumers
```

| Decision | Why | Alternative rejected |
|---|---|---|
| Reuse the source mappers through compiled payloads | One set of validation rules; dry run equals production | A second, generic "file mapper" |
| Payments and spend are compare-only | The CRM and ad platforms own those facts; an export can be stale | Let approvers publish them |
| A file may add, never change | Changing a recorded fact is a correction (Action Center) | "Latest file wins" |
| Staged mappers (calls@1.2, ads@1.2) | Fixes are testable and replayable without changing the seeded history | Edit a shipped mapper version |

## 8. Performance (measured; `PERFORMANCE.md`)

On one laptop, durable Postgres (`fsync=on`):
- **1,000,000 rows backfilled in 178 s** (5,604 rows/s);
- batch p50/p95/p99 339/439/627 ms;
- 199 MB peak RSS; 1,981 MB WAL;
- exactly 980,000 leads.

With `fsync=off` the same load ran at 6,733 rows/s. Throughput was flat from 100k to 1M.

A 50,000-row upload: dry run about 6 s, publish about 6 s. A hard kill mid-run lost no partial
batch, and a resume re-delivered 58,800 rows as duplicates with exact totals.

10M was not run; why is in `PERFORMANCE.md` §4.

## 9. Deployment

**Today:**
- `npm run build && npm run start` serves the app on a single Next.js node;
- migrations run with `npm run db:migrate`;
- checksums ignore line endings, so a CRLF checkout is not an "edited migration".

**Not done:**
- no deployment target;
- no SSO;
- no CSP headers;
- no secret manager (credentials resolve from environment variable names);
- no pager integration.

These are listed with owners in `REMAINING-RISKS.md`. The app was never deployed by this work,
by rule.

## 10. Recovery

- **Intake:** a crashed batch rolls back whole, and a re-delivery is a duplicate. Proven at 1M
  scale by the crash and hard-kill tests.
- **Projections:** a wrong projection is fixed by a replay through Action Center (proposal, dry
  run in a rolled-back transaction, approval by a different person, verification). The ledger is
  never edited.
- **Jobs:** connector jobs resume after the last committed id; auth and contract errors fail at
  once with what a person must do.
- **Not built:**
  - backups and point-in-time recovery (a database-platform responsibility; not configured
    here);
  - tombstones for vendor deletes (`VENDOR-CONTRACTS.md` F-5 to F-7).
