# EGM Stage 5: inventive catalyst report

- **Target:** `docs/agent-work/release/RELEASE-DESIGN.md` (first draft, 759 lines)
- **Reviewer:** `egm:egm-inventive-catalyst`, fresh context, read-only
- **Date:** 2026-11-18
- **Verdict:** 4 Major, 4 Nit, all advisory

Line numbers below refer to the first draft. Resolutions are recorded in
[`resolution_log.md`](resolution_log.md).

## 1. Major. Per-visitor ownership added to a mapping namespace shared by the whole company

**Scope:** §5.1 "Whose upload it is" and "Mappings"; WP-D files, interfaces and tests.

**False compromise.** Per-visitor isolation is treated as a column plus a rule that every read
takes the viewer. But mapping identity is shared across the whole company, not per upload:

- versions are numbered per (dataset, layout) across all uploads (`lib/onboarding/service.ts:302–303`;
  unique constraint at `database/migrations/0013_onboarding.sql:60`);
- an identical spec is reused whoever proposed it (`service.ts:299–300`);
- the upload page treats `mappings[0]` for the layout as "latest" (`service.ts:252–257`;
  `app/onboarding/[id]/page.tsx:59, 229, 247`).

Every "Try the sample" visitor has the same layout fingerprint, and visitors who give the same two
answers produce the same spec hash. So the most common hosted path reuses another visitor's
mapping, and a per-visitor filter then hides it: the visitor's own result reads "This dry run used
an earlier mapping version" and "Available after a dry run". The planned tests do not cover two
visitors giving the same answers.

The key is also passed by hand. `viewerFromRole` returns the module-level `VIEWERS.guest` object
(`lib/viewer.ts:73, 119–121`); attaching a per-request key to it would leak one visitor's key to
concurrent requests. `getViewer` also runs during page renders, where Next.js cannot set a cookie,
so "issue and read `rs_visitor`" cannot be one function.

**Proposed resolution.** Segmentation plus Extraction:

- make the visitor part of a sandbox mapping's identity; reuse only the visitor's own proposals or
  company-approved mappings; number sandbox versions per visitor, or show a per-visitor ordinal;
- enforce ownership in one place (row-level security keyed to a transaction setting, or one scoped
  data-access module);
- issue the key in one place that may set cookies, and build a new Viewer per request.

**Secondary liabilities.** Row-level security needs `FORCE ROW LEVEL SECURITY` and `set local` in a
transaction for every read; a scoped module still relies on discipline; per-visitor numbering
replaces a unique constraint, which is not additive while Preview and Production share a database;
middleware adds work to every request.

## 2. Major. The storage caps limit the wrong thing and refuse every reviewer when they trip

**Scope:** §5.1 "Limits"; the threat-model row "Storage exhaustion"; the risk row; migration 0037.

**False compromise.** (a) The caps limit uploads and staged rows, not the storage that grows. Purge
deletes `onboarding_rows` and blanks text (`service.ts:124–138`), but each upload's profile,
assistant output, every mapping, every dry run and one `onboarding_row_results` row per source row
per dry run stay as the accountable record (`0013:6–9`). Nothing limits dry runs, and each dry run
of a 50,000-row file adds 50,000 permanent rows. That record protects nothing for sandbox uploads,
which can never be published. (b) The per-visitor cap is keyed on a cookie a script can drop, so in
practice only the global cap applies; when it trips, every cold reviewer is refused for the day.

**Proposed resolution.** Make sandbox data disposable by construction: at expiry delete the whole
sandbox graph; keep only the latest dry run per sandbox upload; cap dry runs per upload; give the
built-in sample its own budget; evict the oldest sandbox uploads instead of refusing new visitors;
size the pool in bytes; add a hashed, coarse network key beside the cookie.

**Secondary liabilities.** A visitor's upload can vanish early, so the page needs a "removed" state
rather than a bare 404; deletes must run in order or cascade; the retention rule in 0013 narrows to
publishable uploads; network keys throttle a shared NAT together and are personal data.

**Defect:** 0037's index on `(visitor_key, created_at)` names a column neither table has
(`uploaded_at` at `0013:20`, `proposed_at` at `0013:55`). As written, the migration fails.

## 3. Major. Recomputing on every request is accepted although the hosted ledger never changes

**Scope:** §4 method and targets; §5.8; the risk "Neon free tier cold start"; WP-G.

**False compromise.** Every visit recomputes the Overview from the database, yet the design makes
the hosted ledger immutable between resets (no guest ledger write, no `DEMO_MODE`, no
`INGEST_API_KEY`, no worker). Every hosted visitor has the same guest role and scope, so the
Overview depends only on the data snapshot and the URL. The targets are measured locally, which
leaves the success criterion's own scenario (a reviewer opening the hosted demo cold) without a
target.

**Proposed resolution.** Cache the first-screen data at the data layer, keyed by scope, period,
brand, branch and a data version; turn it on only when no ledger writer is reachable; have the
hosted reset bump the version; warm it in the smoke tests. The cache cannot sit at page level,
because `getViewer` reads cookies first on purpose.

**Secondary liabilities.** Stale numbers are this product's worst failure, so the switch must be
exactly the write gate; every first-screen read must go through it; `measure.cjs` must report
hits and misses; keys must include scope; the cache stores outputs of the same functions, never a
reimplementation; a reset that forgets the version bump serves old numbers.

## 4. Major. One database for Preview and Production is presented as a fixed constraint

**Scope:** §5.9 Providers; the release path; the risk row; §9; WP-J steps 5–8.

**False compromise.** Sharing the database is a configuration choice. Its costs: production is
reset and migrated before the release branch is previewed; if the preview fails, production keeps
the old build on new data; the rehearsal only checks that old pages still render; restoring the
database also rewinds the preview. Neon branches were rejected only as one per visitor.

**Proposed resolution.** A persistent Neon branch (or database) for Preview, reset from production
at the start of each release, migrated and seeded there, pushed and smoke-tested against. Change
production only at promotion.

**Secondary liabilities.** Preview needs its own `DATABASE_URL`, which takes effect on the next
deploy; the branch drifts unless reset; its compute counts against the free plan.

## 5. Nit. "Red CI" or "skip the tests" is a false choice

A quarantine lane (the seven specs, assertions unchanged, in a separate required job with an owner
and expiry) would let the main job block on any new failure. Liability: quarantines tend to become
permanent.

## 6. Nit. A chart point is asked to both preview and navigate on one activation

On touch, the tap that shows the tooltip is also the click that opens the evidence, and a tab stop
on every point adds one stop per channel and week. The current component already keeps selecting
(points, rows) apart from opening (the panel's single "Open evidence" link,
`components/overview/MovementChart.tsx:295–298`). Keep them apart; make the plot one composite
widget with a single roving tab stop and arrow keys.

## 7. Nit. The investigator's fallback is an allow-list, and the local model inherits the Anthropic request shape

The loop sends a fixed model id, a beta flag, `fallbacks`, adaptive thinking, `output_config.effort`
and `cache_control` (`lib/ai/model.ts:174–183`). The fallback reasons have no slot for a 400 on an
unsupported field or a 5xx; `describeApiError` rethrows anything unrecognised (`model.ts:270`);
`addUsage(usage, response.usage)` runs outside the `try`, so a response without `usage` throws.
Proposed: a circuit breaker around the whole provider path (any exception or malformed response
returns the deterministic answer, with the reason classified), and a per-provider profile setting
which fields are sent and the time budgets.

## 8. Nit. Outcomes are judged from the HTTP response, not from what was stored

`ActionButton` shows success only on a 2xx. A timeout after the commit followed by a 409 ("This
upload is published") reads as a failure although the intended state holds. "Reconciliation
pending" has no deadline, so a dispatch that never ran looks like one still running. Proposed: after
a network failure or a 409, re-read the stored state; give "pending" a deadline and a final "did not
run" state. A real conflict ("A newer dry run replaced the one you reviewed") stays an error.

## Other errors found (outside this persona's scope)

- The `MetricSnapshot` change is credited to WP-F; it is in WP-E.
- WP-B's `StreamFreshness` is called "same name, adds the sync-job source", but it is a breaking
  change: it drops `lastRunAt`, `latestEventAt` and `quarantined`, changes `lastSuccessAt` to a
  string and gives `source` a new meaning (`lib/metrics/scorecard.ts:450–458`); the quarantined
  count is a full table scan the planned index does not serve.
- The row-to-ledger links have no stored target: row results keep only `external_id` and a
  `raw_event_id` set at publication (`0013:89–90`; `service.ts:523`); no migration adds a ledger
  reference; the staged rows needed to recompile are deleted at purge.

## Checked and sound

- Rejecting `DEMO_MODE` and a database per visitor.
- The guest boundary: no ledger write is reachable (`service.ts:477–498`).
- Compare-only handling for spend and payment files (`lib/onboarding/targets.ts:125, 144`).
- The deterministic investigator as the hosted default.
- Additive migrations with the old build rehearsed against them.
