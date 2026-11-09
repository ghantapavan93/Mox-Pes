# Interview demo

Numbers below come from `npm run demo:numbers` on a fresh `npm run db:seed` (deterministic). All
synthetic. Say "synthetic" out loud once, early.

## 30-second opening

"Marketing and the CRM never agree on conversions. Ad platforms here claimed 7,776 conversions in
October; 1,361 of those prospects became serviced customers so far. Most of that gap is normal —
duplicates, existing customers, people who didn't buy. Some of it is broken plumbing, and broken
plumbing moves budget. I built the piece that tells the two apart, record by record, fixes it safely,
and proves the number changed — on synthetic data shaped like FieldRoutes and CallRail."

## 2-minute business demo (one path)

1. **Overview.** Read the headline sentence. Point at the bridge: claimed 7,776 → 5,195 paid lead
   records → 4,694 unique paid prospects → 1,361 serviced. "Every step is a count from the database;
   the buckets add up, and a test proves it."
2. **The flag.** B20 Heron is first: paid CAC **$490** vs **$267** company, and **41%** of its new
   customers have no known source vs **16%**. "A marketer would cut B20's budget on this number."
3. **Branch page.** Both weekly bars jump from the week of Oct 5. "Customer behaviour doesn't change
   like that in a week. Measurement does."
4. **Exception.** 119 call records quarantined since Oct 6 with one reason —
   `customer_phone_number … received undefined`. 53 sold customers would attach to them; each shows
   "no lead record". Detected at the next daily run (first drifted call Oct 6 15:24 UTC, exception
   Oct 7 08:00 UTC).
5. **Engineer → Dry run.** Whole-period for B20: paid CAC **$365 → $284**, paid customers **88 → 113**,
   unknown **64 → 34**, total customers **246 → 246**, spend unchanged, Google-reportable conversions
   **45 → 51**. "Nothing saved — it ran in a transaction that rolled back."
6. **Replay.** Resolves. Open exceptions for B20 go **up**, 3 → 5: "Three customers were signed by a
   door-to-door rep after a paid call. While the calls were held, that conflict was invisible. The fix
   surfaced it." **Send the same request again** → "Already processed".
7. Close: "Spend didn't change. Revenue didn't change. What changed is that we now know where it came
   from — and Google gets the right conversions back."

## 5-minute technical walkthrough (add after step 7)

- `database/migrations/0001_init.sql`: raw event log, `unique (source, external_id)`, two clocks,
  quarantine status with a check constraint, no FKs between projections (out-of-order is normal).
- `lib/adapters/marketing.ts`: `calls@1.0` vs `calls@1.1` — the whole fix is one schema union.
- `lib/ingest/replay.ts`: idempotency key bound to the request; conditional UPDATE claims each record
  once; dry run = same code in a rolled-back transaction.
- `0002_attribution_views.sql`: first evidenced touch, unknown stays unknown, attribution never stored.
- Integrations page: 134k raw events, 66k duplicate deliveries absorbed; the Oct 9 CRM 503 and
  the run that recovered its window.

## 10-minute engineering deep dive (if asked)

- Tests: `tests/integration/replay.test.ts` (four concurrent replays claim each record exactly once on
  real Postgres), `scenario.test.ts` (collected revenue equals generated payment truth to the cent),
  `review-regressions.test.ts` (one test per finding from an independent review).
- The review: 53/100 first round, the findings, what changed (docs/review-response.md).
- Performance: the 33-second query and the fix (docs/testing.md).
- What production would change: read the lake instead of ingesting; incremental detection; SSO.

## ChangeGuard, 90 seconds (only if the conversation turns to marketing data or Google changes)

Say first: "Google's change is real. The failure is one I engineered. I don't know that you run Local
Services Ads."

1. **B09 branch page.** Budget signal: Search costs **8.6×** Local Services per customer. Marked
   **not trustworthy yet**. "The branch total looks normal. The money moved between channels."
2. **Incident.** Local Services spend stopped after Oct 12; **45** Local Services leads kept arriving;
   a new campaign appeared in the same ad account, typed `PERFORMANCE_MAX` with local services on.
   `ads@1.0` filed **$2,124** of it as Search. "Nothing failed. The meaning was wrong."
3. **Engineer → Dry run → Re-map 22 records.** Search spend down, Local Services up, by the same
   amount. Company spend, customers, invoices, payments unchanged. Signal now **2.9×**, sound.
   Send again → stored result.
4. Close: "When Google re-typed Local Services campaigns, did your channel reports notice, and who
   would have?"

## Likely questions

| Question | Short answer |
|---|---|
| Why this schema? | A raw log keyed by record version gives exactly-once writes, replay from stored payloads, and an audit of what each source said. Projections are disposable views of it. |
| Why Next.js? | Your internal portal runs on it (public headers); server components keep data access on the server. |
| Why custom software? | No product decides which cross-system records are right and routes the rest to an owner. CallRail doesn't integrate with FieldRoutes; BI tools show tables, not disagreements. |
| How do you prevent duplicates? | `unique (source, external_id)` + `on conflict do nothing`; version-guarded upserts; content-versioned records for sources without a clock. |
| How does replay work? | Stored (redacted) payloads re-run through a newer mapper; claimed by a conditional UPDATE; reconciled and measured in the same transaction. |
| Where does attribution become uncertain? | No evidence on any touch; identity mismatch (typo'd phone); D2D after paid; platform view-throughs. Each is labelled, none is guessed. |
| What if an API is down? | The run fails, the cursor stays, the next run re-reads the window. Shown on the Integrations page. |
| With real systems and volume? | Read the lake; incremental detection keyed by changed customers; partition the raw log; SSO; alerting on freshness. |
| How would you integrate your real CRM? | Implement `SourceClient` over the FieldRoutes API (search → get, `dateUpdated` windows, per-office keys, rate limits); the mapper is already in its shape. Validate against recorded, scrubbed fixtures first. |
| SQL rules vs AI? | Rules decide; numbers come from SQL. AI earns a place only where a person currently reads free text to decide — e.g. classifying "how did you hear about us" notes — with a validator and abstention. Not built here; ADR-10. |

## Questions to ask them

1. "When a Google Ads number and a FieldRoutes number disagree, who decides which is right today — and where do the records that don't match go?"
2. "How does a CallRail call become linked to a FieldRoutes customer, and how often does that link fail silently?"
3. "For this role, is the first need new marketing capability or making existing integrations and reporting dependable — and does it report into technology or marketing?"
