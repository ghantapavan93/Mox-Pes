# Performance: measured, on one machine

Every number below was measured on 2026-11-11 on one laptop. It is evidence for this machine and
this code. It is not a capacity guarantee.

- **Machine:** AMD Ryzen 9 5900HX (16 threads), 15.8 GB RAM, Windows 11, Node 22.14.0,
  PostgreSQL 17.8 on the same machine and disk.
- **Two isolated Postgres instances,** never the shared test database:
  - **durable** (port 54334): `fsync=on`, `synchronous_commit=on`, `full_page_writes=on`,
    `wal_level=replica`, `shared_buffers=128MB` (the defaults).
  - **fast** (port 54333, its own `bench_nofsync` database): `fsync=off`, `synchronous_commit=off`.
    This is how the test suite runs. **Its numbers are not production numbers.**

## 1. Onboarding upload, up to the 50,000-row limit (`npm run bench:onboarding -- --ingest`)

One upload is parsed, profiled, given suggestions, compiled and validated by the mapper, then
published in **one** transaction.

| Rows | Parse | Profile | Assistant | Compile + mapper | Publish (fast) | Publish (durable) |
|---|---|---|---|---|---|---|
| 1,000 | 8 ms | 25 ms | 18 ms | 0.17 s | 0.14 s (7,117 rows/s) | 0.15 s (6,878 rows/s) |
| 10,000 | 32 ms | 172 ms | 29 ms | 1.1 s | 1.1 s (9,023 rows/s) | 1.2 s (8,197 rows/s) |
| 50,000 | 156 ms | 834 ms | 164 ms | 4.75 s | 5.3 s (9,354 rows/s) | 6.2 s (8,035 rows/s) |

The 50,000-row dry run (profile + compile) takes about 6 s, which reproduces the earlier
"about 7 s". Durability costs about 15% here: one publication is one commit, so one WAL flush.

## 2. Bulk backfill, 1,000,000 rows (`scripts/bench-backfill.ts`)

This is not a product feature. It is an operator-side test that uses the product's compiler,
mapper validation and `ingestRecords` on a generated 82 MB call export: 2,000-row batches, one
transaction per batch. Every 50th row repeats an earlier call exactly, so the correct answer is
known: 980,000 leads.

| | durable | fast (`fsync=off`) |
|---|---|---|
| Load time | **178.4 s** | 148.5 s |
| Throughput | **5,604 rows/s** | 6,733 rows/s |
| Batch latency p50 / p95 / p99 / max | **339 / 439 / 627 / 1,311 ms** | 289 / 337 / 425 / 1,589 ms |
| Peak RSS (loader process) | **199 MB** | 186 MB |
| CPU, loader (user / system) | 76.4 s / 3.1 s | 76.5 s / 2.4 s |
| WAL written | **1,981 MB** | 1,997 MB |
| Database growth | **1,173 MB** | 1,173 MB |
| Leads = distinct ids = expected (980,000) | **true** | true |
| Raw ledger rows | 980,000 | 980,000 |
| Lead lookup by source id | 1.8 ms | 1.6 ms |
| Raw ledger lookup by external id prefix | 2.2 ms | 1.7 ms |
| Leads grouped by branch × channel (980k rows) | 165 ms | 141 ms |

Evidence: `docs/agent-work/evidence/backfill-1m-durable.json` and `backfill-1m-fsync-off.json`.

What this shows:

- **Throughput is flat.** Progress lines read 5,546 rows/s at 100k and 5,613 rows/s at 900k.
  Nothing degraded as the tables and indexes grew to about 1 GB.
- **Memory is bounded.** RSS went from 191 MB to 199 MB over the run, because the file is
  streamed and only one batch is held.
- **The loader is CPU-bound in Node.** The same 76 s of user CPU in both modes is the compiler
  and mapper. Durability added about 20% wall time (one WAL flush per batch commit).
- **WAL is about 1.7× the data growth** (index updates and full-page images after checkpoints).
  A real backfill needs disk and replica headroom for that.

What this does **not** show:

- **Re-delivery across batches.** Batches are 2,000 rows and repeats are 25 rows back, so every
  repeat in this file is caught inside its own batch by the compiler (`duplicateInFile` 20,000).
  The raw ledger's cross-batch deduplication is exercised by the restart test below.
- **Reconciliation at scale.** `reconcileSeconds` 0.1 is meaningless here: reconciliation works
  on CRM customers and attribution, and this database has no CRM data.
- **Concurrency.** One loader. Live webhooks during a backfill would share the lead-write lock
  (`LEAD_WRITE_LOCK`, shared mode), and a publication would wait for it.

## 3. Crash and restart (durable, 100,000 rows)

| Step | Result |
|---|---|
| Load with `--crash-after=20` (the process exits with 137 after 20 committed batches) | 39,200 leads (20 × 1,960) |
| Resume with `--no-reset`, then kill the process with `Stop-Process -Force` mid-run | 58,800 leads: exactly 30 whole batches, no partial batch |
| Resume with `--no-reset` over the whole file | inserted 39,200, **duplicates 58,800**, leads 98,000 = distinct ids = expected |

A resume is just a re-run. Every committed row comes back as a duplicate through the raw
ledger's content hash, and nothing is double-counted. Evidence:
`docs/agent-work/evidence/backfill-100k-crash-restart.txt`.

## 4. Why 10,000,000 rows was not run

At the measured flat rate, 10M would take about 30 minutes, about 12 GB of database and about
20 GB of WAL on this laptop's disk. The 1M curve showed no degradation, so 10M is expected to
show the same. The real risk at that size is index and checkpoint behaviour once data exceeds
RAM. That would need a server-class machine with production-like `shared_buffers`, separate WAL
storage, and a replica, to be meaningful. A 10M run on a laptop would not settle it.

## Reproduce

```
npm run bench:onboarding -- --ingest
npx tsx scripts/bench-backfill.ts --db=postgres://postgres@127.0.0.1:54334/bench --rows=1000000
npx tsx scripts/bench-backfill.ts --db=<isolated db> --rows=100000 --crash-after=20
npx tsx scripts/bench-backfill.ts --db=<same db> --rows=100000 --no-reset
```

`bench-backfill` **resets the schema of the database it is given**. Point it only at an
isolated database.
