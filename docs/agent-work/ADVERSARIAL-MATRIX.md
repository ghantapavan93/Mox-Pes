# Adversarial matrix

The reviewer's challenge: *"Your demo works because you invented the data. I want to bring data
you've never seen, give you broken exports, change the schemas, and see whether your conclusions
survive."*

Every row below was exercised through the **real code path**: the live intake (`prepare` → raw
ledger → projection) or the onboarding pipeline (parse → profile → assistant → compile with the
deployed mapper → ledger comparison → publication). Nothing here is a fixture counted as a
success. Status:

- **PASS**: the safe behaviour held on first contact.
- **FIXED**: the case failed on the code as found (the red test was run against `HEAD`, see
  [VERIFICATION.md](VERIFICATION.md)), and the fix is in this change with a regression test.
- **BY DESIGN**: the behaviour is deliberate and documented.
- **UNSUPPORTED**: the capability does not exist.
- **NOT TESTABLE**: no way to test it here without credentials or systems we do not have.

## 1. The live intake path (`tests/integration/adversarial-intake.test.ts`, 36 cases)

| Id | Challenge | Expected (safe) | Observed | Status | Where |
|---|---|---|---|---|---|
| ADV-01 | Export-style renamed columns pushed to a webhook mapper | Kept, quarantined `MISSING_IDENTITY` | As expected | PASS | `lib/adapters/marketing.ts` identifyBy |
| ADV-02 | Required column missing | Quarantined `SCHEMA_VIOLATION` | As expected | PASS | zod schemas |
| ADV-03 | Unknown extra / nested fields | Projected; extra fields kept in the raw ledger | As expected | PASS | `raw_events.payload` |
| ADV-04 | Conflicting field type | Quarantined | As expected | PASS | |
| ADV-05/06 | Unknown status / source codes | Quarantined | As expected | PASS | enums in mappers |
| ADV-07 | Unknown CRM entity | Quarantined `UNKNOWN_ENTITY` | As expected | PASS | |
| ADV-10 | US date on an ISO feed | Quarantined, not reinterpreted | As expected | PASS | |
| ADV-11 | Zone-less timestamp on an ISO feed | Quarantined, not assumed UTC | As expected | PASS | |
| **ADV-12** | `2026-02-30 10:00:00` in a CRM clock field | Refused | **Rolled to March 2 and projected** | **FIXED** | `lib/primitives.ts` `isRealCalendarTime`, `wallTimeToInstant` |
| **ADV-13** | Impossible date in a non-clock CRM field (`dateAdded`) | Quarantined | **Projected with a different day** | **FIXED** | `crm-fieldroutes.ts` `wallTime` refine |
| ADV-14 | `"$1,234.00"` text money on the CRM feed | Quarantined | As expected | PASS | money regex |
| **ADV-15** | `99999999999999999.99` | Refused | **Silently rounded (float)** | **FIXED** | `parseMoneyToCents` (BigInt + safe-range), 13-digit schema bound |
| ADV-16 | Negative ticket total | Quarantined | Quarantined by the mapper (`SCHEMA_VIOLATION`; the DB check stands behind it). My first expectation named the wrong code. | PASS | |
| ADV-17 | Orphan refund (negative, no original) | Quarantined | As expected | PASS | |
| ADV-18 | Scientific-notation id | Quarantined | As expected | PASS | |
| **ADV-19** | `"0042"` and `"42"` | One canonical record; the padded one refused | **Both projected into customer 42 as two ledger versions** | **FIXED** | `CANONICAL_ID` in `crm-fieldroutes.ts` (identify + schema) |
| ADV-20 | 16-digit id | Quarantined | As expected | PASS | |
| ADV-21 | Unicode note; NUL byte | Unicode stored exactly; NUL removed (Postgres cannot store it) | As expected (NUL removal is by design in `redact.ts`; first expectation was wrong) | BY DESIGN | `redact.ts` |
| ADV-22 | Placeholders `N/A`, `""`, `null` in a phone | No fake identity hash | As expected | PASS | |
| ADV-23 | Impossible ad-spend date | Quarantined | As expected | PASS | |
| **ADV-24** | `2026-02-30T10:00Z`, `T24:00`, `+25:00` on push feeds | Refused | **The JS Date parser rolled them to another day; projected** | **FIXED** | `isValidIsoInstant`, `isoInstant` refine, `identifyBy` |
| **ADV-25** | Appointment `2026-11-31` / start `25:10:00` | Quarantined | **Accepted** | **FIXED** | appointment schema |
| ADV-30 | Same delivery three times | Counted once, `delivery_count` = 3 | As expected | PASS | |
| ADV-31 | Older CRM version after a newer one | Never overwrites | As expected | PASS | |
| ADV-32 | Same version, different content | `payload_conflict` exception | As expected | PASS | |
| ADV-33 | Unknown branch | Quarantined, reconciliation still runs | As expected | PASS | |
| ADV-34 | One bad record in a batch | The batch still lands | As expected | PASS | |
| **ADV-35** | A mapper that throws on one record | That record quarantined `MAPPER_ERROR`; batch lands | **The whole batch failed** | **FIXED** | `guarded()` in `lib/ingest/ingest.ts` |
| ADV-40 | Wrong ingest key | 401 before reading | As expected | PASS | |
| ADV-41 | Push to a pull-only source | 404 | As expected | PASS | |
| **ADV-42** | 3 MB push body | 413, nothing stored | **Accepted; then hung (see ADV-46)** | **FIXED** | `readBodyBytes` in `lib/http.ts`, 2 MB cap |
| ADV-43 | Declared `Content-Length` 50 MB | 413 without reading | As expected after the fix | FIXED | same |
| ADV-44 | Malformed JSON / empty batch | 400 | As expected | PASS | |
| ADV-45 | `__proto__` key in a payload | Stored as data; no pollution | As expected | PASS | |
| **ADV-46** | 1 MB free-text note | Linear redaction | **Quadratic: 200 KB took 36 s; 3 MB would hold an ingest transaction open for hours** | **FIXED** | bounded `EMBEDDED_EMAIL` in `redact.ts` (3 MB now 0.8 s) |

**Severity of what was found:** ADV-46 + ADV-42 together are a **high**-severity denial of service: one
authenticated push stalls intake and blocks every writer that needs the same locks. ADV-12/13/24/25 and ADV-19
are **high** data-integrity defects (silently wrong facts). ADV-15 and ADV-35 are **medium**.

## 2. The onboarding pipeline (held-out exports, `tests/integration/onboarding.test.ts`, `tests/unit/onboarding-parse.test.ts`)

The held-out files and their expected outcomes (`tests/fixtures/onboarding/holdout/EXPECTED.md`) were
written by an independent labeler from the field definitions alone, before the pipeline saw them.

| Challenge | Observed | Status |
|---|---|---|
| Renamed columns, other column order, unknown extra fields | Mapped by meaning with evidence; extras left unmapped | PASS |
| Duplicate / blank headers | Renamed `Total (2)`, `Column 2`, warned | PASS |
| Multiple worksheets | Listed; the chosen one read; warned | PASS |
| Nested JSON, envelopes, arrays | Flattened to dotted columns; arrays kept as flagged text | PASS |
| Report title lines above the header; `Total:` rows | Preamble skipped (warned); total rows `SUMMARY_ROW` | PASS |
| US dates with unknown order | Dry run blocked until the order is stated (`DATE_ORDER_REQUIRED`) | PASS |
| Zone-less local times | Blocked until "branch-local" is confirmed; converted per branch zone (Arizona has no DST) | PASS |
| DST gap / repeated hour | `NONEXISTENT_LOCAL_TIME` / `AMBIGUOUS_LOCAL_TIME`, never guessed | PASS |
| `12:05 AM` | 00:05 the same day | PASS |
| Impossible dates (`02/30/2026`) | `IMPOSSIBLE_DATE` | PASS |
| Excel serial dates in CSV | `SPREADSHEET_SERIAL` | PASS |
| `$1,234.00`, `(50.00)`, `-$12` | Parsed exactly | PASS |
| `1.234,56`, `€12`, `12.345` | Refused with the reason | PASS |
| Scientific-notation ids (`1.23457E+17`) | `MANGLED_ID` (the original cannot be recovered) | PASS |
| Leading-zero CRM id (`00417`) | `PADDED_ID`, not stripped. **The labeler expected "accept as text"; we deliberately differ** (numeric CRM ids; stripping is a guess) | BY DESIGN |
| Ambiguous `Total` / `Contract Value` as cash | Never suggested; the stated meaning is validated (`WRONG_MONEY_MEANING`) | PASS |
| Fractional conversions (`1.50`) | `FRACTIONAL_COUNT`, not rounded | PASS |
| Unknown branch name / unknown source (`Yelp`) | Quarantined unless a person maps the value | PASS |
| Exact duplicate rows / same record with other content | `duplicate_in_file` / `conflict_in_file` | PASS |
| Prompt injection in a note / in a header | Stored as data; the header was not used as evidence; nothing changed | PASS |
| A file that is not any dataset / mixes record types | Dataset abstained | PASS |
| Record dated after the business clock | `FUTURE_TIMESTAMP` (found in the browser walk, fixed, tested) | FIXED |
| Re-importing the same file | Every row `matches_ledger`; nothing published | PASS |
| A row the ledger gained between dry run and publication | Skipped, not overwritten | PASS |
| Macro workbook, ActiveX, external links, encryption | Refused | PASS |
| Decompression bomb; size that lies | Refused by ratio; inflation bounded by the declared size | PASS |
| Relationship target escaping the archive | Refused | PASS |
| Path traversal / control characters in the filename | Sanitised (display only; storage is by id) | PASS |
| `.xlsx` that is CSV, `.csv` that is a zip | `CONTENT_MISMATCH` | PASS |
| Oversized upload | 413 before buffering past 5 MB | PASS |
| Partner / brand / guest reading an upload | 403 / Forbidden page | PASS |
| Proposer approving their own mapping | Refused by the service **and** by a database check constraint | PASS |
| PII in profiles and audit | Phone/email/free-text values never shown; audit holds counts and codes only | PASS |

## 3. Not covered (stated, not hidden)

| Challenge from the brief | Status | Why |
|---|---|---|
| API 429/503, expired credentials, paging boundaries, stale/lost worker, two workers, rollback mid-replay, double execution, out-of-order references | PASS (pre-existing, re-run green) | `connectors.test.ts`: "a 429 without Retry-After…", "503s back off…", "an expired key fails the job at once…", "pages searches at the cap…", "a stale job is re-queued…", "concurrent runners claim every job exactly once"; `changeguard.test.ts`: "a failure mid-replay rolls everything back…"; `action-center.test.ts`: "executing twice runs once"; `invariants.test.ts`: "…clears itself when the reference arrives (out of order)" |
| Same external customer id in two brands (two CRM accounts) | **UNSUPPORTED** | `crm_customers` is keyed by `crm_customer_id` alone: the model assumes one CRM account. Namespacing by account is a schema change (REMAINING-RISKS R-3) |
| Merged / deleted CRM customers | **UNSUPPORTED** | Open since the audit (G-7/G-8) |
| Live vendor API behaviour (FieldRoutes, Google, Meta, CallRail) | **NOT TESTABLE** | No credentials, by rule; only mocks and published specs |
| Spreadsheet macros executed | N/A | Never executed: refused before reading |
