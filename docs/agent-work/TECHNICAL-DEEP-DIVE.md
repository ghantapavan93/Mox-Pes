# Technical deep dive: unfamiliar data, end to end

## One validation path

An uploaded row is never validated by onboarding-specific rules alone. The approved mapping
**compiles** each row into the payload the source's live feed would send (a CallRail-shaped call,
a FieldRoutes payment with `officeID` and `"YYYY-MM-DD HH:MM:SS"` wall time, a spend day in
micros), and the deployed mapper validates it through `prepare()`, the same function live intake
uses (redact → identify → map). The dry run therefore quarantines what production would
quarantine, with the same codes. Compilation is pure, so a replay with the same mapping version
gives the same result.

```
bytes ─► parse (CSV/XLSX/JSON, bounded) ─► profile (every row) ─► assistant (suggests, abstains)
      ─► person: mapping version (spec hash; date order; zone; money meaning; value translations)
      ─► compile row ─► prepare() with the deployed mapper ─► in-file duplicates/conflicts
      ─► future-timestamp check ─► compare with ledger (same grain only)
      ─► different role approves the exact spec hash
      ─► publish: re-compile, re-compare, ingestRecords() for rows the ledger still lacks
      ─► intake.records_stored (same transaction) ─► identity + reconciliation consumers
```

## Decisions worth defending

| Decision | Why | Alternative rejected |
|---|---|---|
| Reuse the source mappers through compiled payloads | One set of validation rules; dry run equals production | A second, generic "file mapper" (two truths about validity) |
| Payments and spend are compare-only | The CRM and the ad platforms own those facts; an export is a copy that can be stale | Let approvers publish them (a stale export would overwrite newer API data) |
| A file may add, never change | Changing a recorded fact is a correction: Action Center (proposal, dry run, approval) | "Latest file wins" |
| Deterministic assistant, evaluated on three independent sets | Reproducible, free, private; its error rate is measured | An LLM mapper with no evaluation and data egress |
| Small bounded XLSX reader | Refusing macros, bombs, encryption and escaping paths is the job | A large dependency whose limits we would have to trust |
| Stage cells apart from metadata; purge after 24 h | Cells are personal data; the accountable record (profile, dispositions) must outlive them | Keep raw uploads |
| Separation of duties in a CHECK constraint | A bug in the service cannot let a proposer approve | Service-only checks |

## Performance (measured; `docs/agent-work/evidence/bench-onboarding.txt`)

AMD Ryzen 9 5900HX (16 threads), Node 22.14, Postgres 17.8 with **`fsync=off` and
`synchronous_commit=off`** (so write numbers are an upper bound).

| Rows | Parse | Profile | Assistant | Compile + mapper | Publish through intake |
|---|---|---|---|---|---|
| 1,000 | 9 ms | 28 ms | 22 ms | 192 ms | 163 ms (about 6,100 rows/s) |
| 10,000 | 41 ms | 190 ms | 34 ms | 1.19 s (about 8,400 rows/s) | 1.24 s (about 8,100 rows/s) |
| 50,000 (the upload limit) | 199 ms | 1.04 s | 251 ms | 5.62 s (about 8,900 rows/s) | 6.46 s (about 7,700 rows/s) |

The benchmark found and fixed one bottleneck: building an `Intl.DateTimeFormat` on every wall-time
conversion held the compile step to about 2,100 rows/s; caching one formatter per zone gave about 4×.
**Not measured:** 1M or 10M rows through any path. Uploads are capped at 50,000 rows by design;
backfills at that scale belong in the warehouse's bulk path (REMAINING-RISKS R-8).
