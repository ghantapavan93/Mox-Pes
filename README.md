# Revenue Signal

**An independent proof-of-work** by Pavankalyan Ghanta, built unprompted before any interview for
the marketing Software Engineer role at Moxie Pest Control. It is **not** affiliated with, endorsed
by, or built from any Moxie system. **All data is synthetic**: fictional branches, generated
customers, generated incidents.

**Start here:** the two-minute case file, `docs/case-file/index.html` (rebuild it with
`npm run export:snapshot` on a fresh seed, then `node docs/case-file/build.mjs`, then
`npm run db:seed`). Sending plan: `docs/outreach.md`.

> Don't just report how many leads a campaign produced. Show whether those leads became customers,
> find where the records stopped agreeing, fix it safely, and prove what changed.

## The 30-second version

Ad platforms claim more conversions than the CRM can find. In this synthetic 44-branch business, one
branch's paid CAC suddenly reads far above every other branch. Revenue Signal shows why: that branch's
call-tracking feed changed shape, so its calls were held in quarantine and the customers they produced
look like they came from nowhere. An engineer dry-runs the fixed mapper, replays the held records, and
the branch's numbers recompute — spend and collected revenue unchanged, attribution restored, the
corrected conversions now eligible to report back to Google Ads. Sending the same request again
changes nothing.

## What it is (and is not)

- A **reconciliation module**: cross-system rules, an exception queue with evidence, audited
  decisions, idempotent replay, and metrics recomputed from the database.
- Postgres here is a **stand-in for lake tables**. A company with a data lake would run the rules on
  the rows it already lands (docs/architecture.md).
- Not a dashboard product, not an ingestion platform, not an AI feature (docs/decisions.md ADR-10).

## Run it

Requirements: Node 22, and Postgres 17 (local install or Docker).

```bash
docker compose up -d
```

```bash
npm install
```

```bash
npm run db:seed
```

```bash
npm run dev
```

Open http://localhost:3000. The seed replays ~11 weeks of daily polling runs across 44 branches
through the real pipeline (≈100 s; 134k raw events, 66k duplicate deliveries absorbed, one simulated
API outage recovered). Same seed, same numbers, every time.

Without Docker, point `DATABASE_URL` at any Postgres 17 (see `.env.example`).

## Demo path (2 minutes)

1. **Overview** — "Where did the conversions go?" The bridge goes from platform-claimed conversions
   to verified serviced customers. B20 Heron is flagged first: paid CAC and unattributed share far
   above the median branch.
2. **B20 Heron** — weekly bars show both jump from the week of Oct 5. Open the quarantine exception.
3. **Exception** — 119 call records held with `call.customer_phone_number: … received undefined`;
   the sold customers they would attach to are listed, each with "no lead record".
4. Switch **Viewing as → Integration engineer**. **Dry run** (rolled back): CAC, unattributed
   customers and Google-reportable conversions before/after; total customers and spend unchanged.
5. **Replay**. Exception resolves; the panel keeps the before/after. **Send the same request again**:
   "Already processed".
6. Back to **Overview**: B20 is no longer flagged for unattributed customers.

Full scripts (30 s / 2 / 5 / 10 min) and likely questions: docs/interview-demo.md.

## ChangeGuard (the second incident, 90 seconds)

A **real** 2026 Google change, a **hypothetical** pipeline failure. Google is migrating Local
Services Ads into Performance Max campaigns with pay-per-lead goals (pest control in phase 1), and
migrated campaigns report as `PERFORMANCE_MAX` with local services enabled. In the synthetic world,
branch **B09** migrates on Oct 13 and mapper `ads@1.0`, which types channels by platform, files its
Local Services spend as Google Search. Nothing fails validation.

1. **B09** branch page: the **Budget signal** says Search costs 8.6× Local Services per customer, and
   is marked **Not trustworthy yet**, linking to the incident.
2. **Channel coverage gap**: Local Services spend stopped after Oct 12 while 45 Local Services leads
   kept arriving; a new campaign started in the same ad account. Lineage and the raw records show it.
3. As engineer: **Dry run**, then **Re-map 22 records** through `ads@1.1`. Spend moves between
   channels; company spend, customers, invoices and payments do not change. The signal becomes 2.9×,
   marked sound.

Evidence and the go/no-go: research/16-changeguard-go-no-go.md (with 16a Google, 16b Moxie signals).
Case file: `docs/changeguard/index.html` (rebuild: `npm run export:changeguard` on a fresh seed,
`node docs/changeguard/build.mjs`, then `npm run db:seed`). Nothing here claims Moxie uses Local
Services Ads or has this failure.

## Tests

```bash
npm test
```

```bash
npm run test:e2e
```

Unit, database-backed integration (real Postgres, including concurrent replays), a full-seed scenario
test that checks collected revenue against generated payment truth to the cent, review-regression
tests, and a Playwright golden path. Details and measured performance: docs/testing.md.

## Repository map

| Path | What |
|---|---|
| `research/` | Not in this repository: the interview research notes (company, people, sources) are kept private. Code comments that cite `research/NN` refer to them. |
| `docs/` | domain model, architecture, decisions (ADRs), reporting contract, metric definitions, testing + performance, interview demo, executive one-pager, independent code reviews |
| `database/migrations/` | the schema and the attribution views — the domain model in SQL |
| `lib/adapters/` | source contract, redaction, CRM + marketing mappers (versioned) |
| `lib/ingest/` | exactly-once ingestion, projection, replay |
| `lib/reconcile/` | the six cross-system detectors (including the ChangeGuard coverage gap) |
| `lib/metrics/` | metric registry and SQL; `decision.ts` is the budget-signal gate |
| `lib/sim/` | deterministic synthetic world and seed |
| `app/` | Next.js 16 pages and REST routes |
| `tests/` | unit, integration, scenario, e2e |

## Known limitations

- Synthetic data only. The mock clients return current state per record like a polling API, but
  select changes by a simulator clock rather than by the payload fields a real FieldRoutes client
  would filter on (review F15).
- Two independent code-review rounds (53 → 68/100); every finding since has a regression test, but a
  third round was not run.
- Demo roles have no passwords; enforcement is real, identity is not (ADR-11).
- Periods are UTC, not branch-local. Period CAC only (no lead-cohort view).
- D2D commission cost and LSA credits are not modelled.
- Reconciliation runs over all history on every call; fine at this scale, would need incremental
  detection at production volume (docs/testing.md).
- Google conversion feedback is a dry run; field names must be verified against Google's reference.
- Next.js is pinned to 16.4.3; upgrade after the 2026-11-03 security release.

## Research sources

The research behind this build is kept private: it includes notes on real people. Every research
claim there carries a label (VERIFIED / REPORTED / INFERRED / HYPOTHESIS / UNKNOWN), a URL and a
retrieval date. Public facts the code relies on are cited where they are used.
