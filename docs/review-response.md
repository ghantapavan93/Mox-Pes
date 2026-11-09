# Response to the senior-engineer review (round 1, 53/100)

Rule followed: name the invariant, fix the shared primitive, keep the reviewer's failing input as a
permanent regression test (`tests/integration/review-regressions.test.ts`, test name = finding id).

| # | Sev | Invariant now held | Fix (shared primitive) | Regression |
|---|---|---|---|---|
| F1 | CRITICAL | An exception references a known branch or none | `payload_branch()` SQL function returns only known branches; used by the detector and the replay group query | F1 |
| F2 | HIGH | For a source without a version clock, the latest observation wins (incl. A → B → A) | `versionClock: "received"` on the record identity: content-hash versions ordered by receipt; re-observation re-projects; upserts skip rows already at that raw event | F2 |
| F3 | HIGH | No number depends on the database session time zone | UTC-pinned connections + explicit `at time zone 'UTC'` date casts | F3 (Chicago and UTC+14 sessions) |
| F4 | HIGH | Redaction never changes a value a mapper needs; free text holds no contact details | Bare digit strings are phones only under a phone-ish key; formatted phones/emails anywhere; embedded ones in free text removed | F4 |
| F5 | HIGH | One bad record never blocks its batch | Range-checked ids/ints in mappers; savepoint-isolated projection → `PROJECTION_FAILED` quarantine | F5 |
| F6 | HIGH | No role → no permission to act | Read-only `guest` default; prototype keys rejected; demo nature stated in code and docs | F6 |
| F7 | MED | Revenue at risk counts each customer once; company-wide exceptions count | `customer_ids` on exceptions; distinct-customer sum; totals include null-branch exceptions | F7 |
| F8 | MED | An idempotency key identifies one request | Request fingerprint stored with the key; mismatch → 409; UI mints a new key for new work | F8 |
| F9 | MED | A call updated after the fact is a new version, not a conflict | Same primitive as F2 | F9 |
| F10 | MED | Conflicts are recorded wherever they occur | In-batch conflicts raise `payload_conflict` too | F10 |
| F11 | MED | Permanent conditions can be closed by a person without lying about the data | `acknowledged` status survives re-detection; acknowledge action (audited) | F11 |
| F12 | MED | Period boundaries are explicit | Labels say "(UTC)"; docs/metric-definitions.md written; branch-local periods listed as a limitation | — |
| F13 | MED | A production deploy without an ingest key accepts nothing | Fails closed when `NODE_ENV=production` | — |
| F14 | MED | — | **Not fixed**: reconcile still runs in the ingest transaction; documented bottleneck | — |
| F15 | MED | Cursors never move backwards | `greatest()` on cursor upsert. **Not fixed**: mock clients still filter on the simulator clock | — |
| F16 | MED | Concurrent reconciles cannot re-open each other's resolutions | `pg_advisory_xact_lock` | — |
| F20 | LOW | Health never leaks connection details | generic 503 body, details logged | — |
| F21 | LOW | Malformed ids are 404, not 500 | id validated in the actions route | — |
| F22 | LOW | Mapper labels match the source | `source` prop | — |
| F24 | LOW | Labels match coverage | "Oct 1–30, 2026 (UTC)" | — |
| F25 | LOW | Campaign renames keep the newest name | ordered by newest in the upsert | — |
| F28 | LOW | Weekly series follows the period | derived from `PERIODS` | — |

Not addressed: F23 (bridge wording is still causal-sounding for unmapped-campaign leads), F26
(partner sees the other branch's lead id inside an in-branch mismatch — kept as evidence), F27 (raw
driver errors on the company-only integrations page).

---

# Round 2 (68/100) — findings and fixes

| # | Sev | Invariant now held | Fix | Regression |
|---|---|---|---|---|
| R2-H1 | HIGH | Inside one batch, a re-delivered old version never beats a new one | Per-record receipt time = batch time + delivery index; mock sources now return **current state** per record (a polling API never re-sends history) | R2-H1 |
| R2-H2 | HIGH | A replayed record competes with its ORIGINAL receipt time | Replay maps with `received_at` of the held raw event | R2-H2 (both directions) |
| F2 (partial) | — | Without a source clock, the latest observation wins | Kept as the documented rule: a current-state API cannot re-send a stale version; sources that can (webhook retries) must carry a version stamp | F2, R2-H1 |
| F5 (partial) | — | No value can block a batch | NUL stripped at redaction; source times outside 1970–2100 quarantined; raw insert retries row by row and stores an `UNSTORABLE_PAYLOAD` placeholder | R2-F5 |
| F4 (partial) | — | Free-text contact details removed in any format; id/money/time fields never hashed | Unseparated numbers scrubbed in free text; key exemptions for ids, accounts, campaigns, dates, money | R2-F4 |
| R2-M1 | MED | Decisions cannot deadlock against reconciliation | `lockReconcile()` taken first in every decision and replay transaction | R2-M1 |
| R2-M2 | MED | Only data errors quarantine a record | `isRecordLevelError`: SQLSTATE 22/23 quarantine; everything else fails the run for retry; quarantines are logged | R2-M2 |
| F14 | MED | Pushes don't queue behind a full reconcile | Push ingestion no longer reconciles inline; `POST /api/reconcile` runs it on a schedule | — |
| F6 (partial) | — | — | Accepted for a labelled demo: guest reads all synthetic branches; anyone can pick a role. Production uses SSO | — |
