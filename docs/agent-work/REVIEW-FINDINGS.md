# Independent review findings

Two reviewers, each a separate agent with read-only access to the code (not to my reasoning),
attacked the onboarding pipeline and the intake hardening after it was built and tested. Each
finding came with a reproduction (pure-function scripts in their scratch folders; the race was
argued from the code). **Every finding below was accepted** (none was rejected as invalid), fixed,
and given a regression test that uses the reviewer's own counterexample
(`tests/unit/onboarding-review.test.ts`, `tests/integration/onboarding.test.ts`).

The builder had already run 36 adversarial intake tests, 21 parser tests, 8 integration tests
and a browser walk, all green, when these reviews found 21 real defects. That gap is the
argument for independent review.

## Data-correctness review (12 findings)

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| D1 | High | An unterminated quote swallowed the rest of the CSV into one cell; "every row accounted for" still said true | Refused as `UNTERMINATED_QUOTE` with the line | review D1 |
| D2 | High | A date-only Excel cell got an invented midnight, so it would publish where the same CSV value was refused | Number formats classified date / time / datetime; a date-only cell reads `YYYY-MM-DD` | review D2 |
| D3 | Med-High | A header with blank names could be skipped as a "title", turning the first data row into headers | Header detection by written width; only single-value lines are ever skipped | review D3, S6 |
| D4 | Med-High | A formatted empty Excel cell (or a trailing comma) made a valid row "ragged" | Ragged only if a value lies beyond the header; trailing empties trimmed | review D4 |
| D5 | Medium | Ledger-only payments on the file's last day were missed for date-only exports | Window runs to the next office-local midnight | integration (payment 880097) |
| D6 | Medium | Per-row amount differences did not add up to the cash difference when status also differed | Per-row "collected cash" fact; the sum is asserted to equal the matched difference | integration |
| D7 | Medium | A live webhook between comparison and insert could be overwritten by the file's copy | `lock table leads in share row exclusive mode` for the publication | code; documented (concurrency not unit-testable deterministically) |
| D8 | Medium | A translation to an unknown branch, or an impossible offset (`+25:00`), crashed the dry run; money could be a constant | `INVALID_TRANSLATION`, `IMPOSSIBLE_DATE` row issue, `CONSTANT_NOT_ALLOWED` | review D8 ×2 |
| D9 | Medium | "Total Home Protection - Dallas" (a campaign) excluded as a report total | Only "Total", "Totals", "Grand total", "Total: …" | review D9 |
| D10 | Medium | 1904-dated workbooks shifted every date by 1,462 days; cells without `r` collapsed into column A | `date1904` honoured; running column index | review D10 |
| D11 | Low-Med | `Name, Name, Name (2)` produced two "Name (2)" columns; sorted fingerprint reused mappings on reordered duplicates | Renames avoid every real header; fingerprint keeps order | review D11 |
| D12 | Low | `--12`, `-$-12`, `(-12)` read as positive; colliding JSON keys silently merged; dashed dates never asked about | Refused / refused / classified | review D12 |

## Security review (9 findings)

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| S1 | High | A 21 KB workbook referencing one 10,000-character shared string from every cell expanded to 600M characters and crashed staging | Budget on decoded characters (20M) and per-cell limit inside the reader | review S1 (stored, uncompressed workbook) |
| S2 | High | Lazy regexes over XML rescanned to the end from every unclosed tag (80 KB: 0.7 s; 5 MB: about 45 min) | Linear `indexOf` element scanner; unclosed element refused | review S2 (timed) |
| S3 | High | The whole-value email pattern in redaction and profiling was quadratic (40 KB: 2 s; a 2 MB push about an hour inside a transaction). My ADV-46 fix had missed it | Bounded pattern plus a 320-character guard | review S3 (timed) |
| S4 | Medium | Retention ran only on page reads; dry runs and publication worked on expired rows; row-result details and dry-run examples kept cell text forever; deleted uploads' results stayed readable | Purge committed before every operation and from the worker loop; details and examples scrubbed with the cells; 404 for deleted uploads | integration (retention on every path) |
| S5 | Medium | Publication used whatever dry run was latest, not the one the approver reviewed | `dryRunId` required and checked | integration |
| S6 | Medium | Warnings and notes were unbounded (50k ragged rows gave 4.6 MB of metadata, loaded on every list view) | Capped per code with a count; list reads summary columns only | review S6 |
| S7 | Medium | The CSV row limit was checked after the whole parse (+555 MB for a 4.9 MB file) | Checked while parsing | review S7 |
| S8 | Low | Top values could store names or addresses that the personal-data heuristics missed | Only short, repeating (code-like) values are stored | review S8 |
| S9 | Low | `raggedRows.includes` per row; spec validation per mapping version on every view | Set; latest three versions only | — |

Also confirmed sound by the security reviewer: access control on all eight routes and both pages,
separation of duties (service and database), parameterised SQL, path handling, bomb defences,
no XML entity expansion, body limits, XSS, no export sink, the audit content, `guarded()`.

**Reviewer notes not acted on:** `/api/ingest` falls back to the documented dev key outside
production (pre-existing; production fails closed without `INGEST_API_KEY`). Marketing can
dry-run an onboarding mapping without the `dryRun` permission: an onboarding dry run writes only
its own record, so it is allowed deliberately.

## The pattern behind the misses

Most of these are **resource and boundary** defects (quadratic scans, unbounded growth,
transactions that roll back their own side effects) and **format semantics** (Excel number
formats, 1904 dates, empty styled cells). They are invisible to happy-path and even adversarial
*content* tests, and they need either a hostile-input generator or a reviewer who thinks in bytes
and transactions. Both reviews should be repeated after any change to `lib/onboarding/xlsx.ts`,
`parse.ts` or `lib/adapters/redact.ts`.

## Independent review of the continuation (2026-11-11, commits c6ed3e3..f3d123f)

One reviewer agent, given the diff and no conclusions. Eight findings, each checked against the
code before acting.

| # | Finding | Severity | Disposition |
|---|---|---|---|
| 1 | The opportunities page showed an old override even after a non-overridable check (stale feed) started failing at the same level | High | **Fixed.** `activeOverride()` applies an override only if every check failing now is one it accepted; unit-tested |
| 2 | Existing customers who called were counted as prospects who "did not convert" | Medium | **Fixed.** Excluded; integration test; mutation fails it. Seeded single-contact rate moved 38.4% → 40.7% |
| 3 | Missed follow-up value at stake ignored the observed gap, so an override past "pattern" inherited an unearned materiality pass | Medium | **Fixed.** Only the supported gap is valued, as in retention |
| 4 | Replay wrote leads without the lead-write lock, re-opening the publication compare/write race | Medium | **Fixed.** `lockLeadWritesShared()` in replay; deterministic test A4 is red without it ("no backend blocked on advisory") and green with it |
| 5 | A unit was the first contact in the period and scope, not the prospect's first contact | Medium-low | **Fixed.** First contact across all time and branches; tested with a September prospect calling again in October |
| 6 | Freshness used last delivery, not the platform's last-successful-run rule, and scanned `raw_events` | Low-medium | **Fixed.** `ingestion_runs` success per source; delivery time only for a source with no runs |
| 7 | Staged calls@1.2 cannot retract a lead already projected; its quarantine also blocks the branch | Low (not active) | **Documented** as a precondition for activation (VENDOR-CONTRACTS.md C-3, REMAINING-RISKS R-17) |
| 8 | `criticalUnsafeRate` mixed misfiled datasets (per case) into a per-suggestion rate | Low | **Fixed.** Field rate and `wrongDatasets` reported separately; gate covers both |

The reviewer confirmed as sound: scope enforcement (`resolveScope` refuses), server-side
recomputation of the assessed level, the statistics' directions, migrations 0014/0015,
subject-based separation of duties, the publication lock order, the CSRF proxy and the checksum
rule.
