# EGM Stage 5: zoom-out report

- **Target:** `docs/agent-work/release/RELEASE-DESIGN.md` (first draft, 759 lines)
- **Reviewer:** `egm:egm-zoom-out`, fresh context, read-only, Zoom-Out Standard
- **Date:** 2026-11-18
- **Verdict:** 1 Blocker, 7 Major, 9 Nit. Not ready for implementation as written.

Line numbers refer to the first draft unless a file is named. Resolutions are recorded in
[`resolution_log.md`](resolution_log.md).

**Context sufficiency:** passes. Goal, motivation, audiences, success criteria and non-goals are
explicit.

**Already meets the standard (keep):** the sandbox reuses the existing service, tables and
screens; `Drawer` is extracted from `EvidenceDrawer`; the export table is generated from
`targets.ts`; performance work starts by measuring; no Switch is added; reconciliation status
reads the existing `reconciliation.run_completed` event.

## Blocker

### 1. The sandbox isolates uploads, but visitors share the mapping registry

**Scope:** §5.1 "Mappings", threat model, WP-D.

Mappings are keyed by dataset and export layout, not by upload
(`database/migrations/0013_onboarding.sql:42-64`). Everyone who presses "Try the sample" uploads
the same bytes and gets the same layout fingerprint. In `lib/onboarding/service.ts`:

- **Reuse.** `proposeMapping` reuses any proposed or approved mapping with the same dataset,
  layout and spec hash (299-300). With a per-visitor rule the second visitor's dry run cannot find
  its mapping; without it, the dry run runs on another visitor's row.
- **Listing and prefill.** `getUpload` lists every mapping for the layout (252-257, 267-268); the
  page treats the newest as current (`app/onboarding/[id]/page.tsx:228, 247, 374, 407`). One
  visitor's later proposal prefills another visitor's editor, including free-text `valueMaps` and
  `constants` any client can POST (`lib/onboarding/compile.ts:31-34`), and flips the other
  visitor's result to "This dry run used an earlier mapping version".
- **Version numbers** are per layout (302-303), so each visitor sees how many came before.
- **Hints are already safe:** `approvedHint` returns approved mappings only (143), so the planned
  hint test would pass without testing anything.
- **No seed mappings exist:** no seed or script creates a mapping.
- **No two-visitor test** runs two visitors on the same sample.

**Simpler path:** make a sandbox mapping belong to its upload. The existing `drafted_on_upload`
column (0013:52) already records it. Key reuse, listing, "latest" and the dry-run lookup on that
column for sandbox viewers, and keep sandbox mappings out of layout-wide queries. Add a
two-visitor case to the WP-D integration test and to J2.

## Major

### 2. `ActionButton` re-creates `useAction` and reverses the busy-state rule

**Scope:** §5.3; WP-A.

`components/actions/useAction.ts:16-42` already tracks the busy state, shows the server's message,
refreshes the page and treats a 2xx with `outcome: "failed"` as a failure (28-30). `Working` and an
always-mounted status region live in `components/actions/ProposalControls.tsx:8-15, 144-149`.
The draft makes a pending button `disabled`; the codebase deliberately keeps busy buttons
focusable with `aria-disabled` and ignores a second press in code (`ProposalControls.tsx:69-77`,
`components/ReplayPanel.tsx:85, 119-127`, rule 13 in `docs/design-system.md:119-124`). `disabled`
drops keyboard focus mid-request. The reduced-motion spinner is already handled
(`app/globals.css:141-148`).

**Simpler path:** move `Working` into `ui.tsx`; make `ActionButton` a thin view over `useAction`;
keep `aria-disabled` for busy buttons; drop the spinner item.

### 3. Chart: a tab stop on every point and a "held" state with no data

**Scope:** §5.5; WP-C; §7.

The chart already offers keyboard and touch selection through its channel and week buttons and a
data table (`components/overview/MovementChart.tsx:8-15, 132-151, 226-268`) and restores the
selection from the URL after Back (`MovementChart.tsx:66-93`; `MovementSection.tsx:104`). What is
missing is a Back test and names on the points.

- A tab stop per point adds one stop per channel per week; the codebase pattern is one roving tab
  stop (`components/incidents/DecisionWindow.tsx:104-123`; design-system.md:48).
- Tap shows the tooltip but click opens the evidence: J1's "by tap" step cannot test both, and
  navigating on click skips the explanation panel (`MovementChart.tsx:271-310`).
- "held" is not a chart cell state (`lib/metrics/movement.ts:33`); "partial" and "not delivered"
  were dropped; a missing week is drawn as a gap, so a dashed point has no y-value.
- "paid CAC $1,201" names a metric the chart does not plot (it shows spend per week).
- Legend filters are new behaviour no success criterion needs.

**Simpler path:** keep points pointer-only or one roving-focus group; add the Back test; use the
existing cell states.

### 4. Freshness: fix the missing run record, not one of four readers

**Scope:** §3; §5.4; WP-B.

CRM sync jobs ingest with `runId: null` (`lib/jobs/sync.ts:520`), so they never write an
`ingestion_runs` row; polling streams do, through `runStream` (`lib/ingest/ingest.ts:640-675`).
At least four places compute "last success per stream" from `ingestion_runs`:
`lib/metrics/scorecard.ts:460-482`, `lib/decision/verdicts.ts:637-643`, `lib/ai/tools.ts:548-551`,
`app/api/health/route.ts:12`. Patching only `freshness()` makes the header say "fresh" while
Decision Lab and health say "stale". `sync_jobs` has no stream column
(`database/migrations/0005_connectors.sql:34-63`).

The new `StreamFreshness` is a breaking change (drops `lastRunAt`, `latestEventAt`,
`quarantined`; changes `lastSuccessAt` to a string; changes `source`), read in `app/page.tsx:372`,
`app/audit/page.tsx:440-444`, `app/exceptions/[id]/page.tsx:468`, `components/ShellStatus.tsx:15`.
Three views use the raw-events scan. A cheap indexed per-source maximum exists
(`verdicts.ts:631-636`).

**Simpler path:** write one `ingestion_runs` row per sync job through the existing `runId`
parameter; every reader becomes correct with no interface change.

### 5. Investigator: the fallback already exists, and the Ollama mode is speculative

**Scope:** §5.7; WP-F.

Fallback with a labelled reason already covers API errors, 429, 401, timeouts, refusals, invalid
output and budget limits (`lib/ai/investigate.ts:120-158`, `lib/ai/model.ts:53-61, 261-271`,
`lib/ai/contract.ts:235-243`), tested in `tests/integration/ai-investigator.test.ts:626-642`. The
model loop hardcodes `claude-opus-5-5`, Anthropic-only beta parameters and prices
(`model.ts:28, 35, 172-186`). `investigations.mode` allows `deterministic` or `model`, and a
`model` column records which model ran (`database/migrations/0008_investigations.sql:22-23`); a
new `InvestigatorMode` and `answeredBy` would duplicate that and need an unlisted migration.

**Simpler path:** keep only the new rules (shorter timeouts, fall back when no verified statement
is left, a structured reason) inside `investigate.ts` and its existing fields; defer Ollama.

### 6. Sandbox data lifecycle: the caps limit the one table that is already purged

**Scope:** §5.1; §8.

Purge deletes staged cells but keeps the profile (with top values), assistant output, dry-run
summaries and one result row per source row per dry run, deliberately (`service.ts:102-138`;
`0013:6-9`). Every step adds an append-only `audit_log` entry
(`database/migrations/0014_subjects_and_append_only_audit.sql:43-50`) that /audit shows to every
visitor. The caps count staged rows, which purge already deletes, not the up to 50,000 result rows
per dry run (`lib/onboarding/limits.ts:9`). The per-visitor cap is keyed on a cookie anyone can
drop. One client can exhaust the global cap and lock out the cold reviewer, and the draft does not
say what a capped visitor sees. Strangers' files should not inherit a retention model built for
accountable internal records.

**Simpler path:** drop the per-visitor cap; at expiry delete sandbox uploads with their dry runs,
results and mappings; put one global cap on the rows actually kept; decide whether anonymous
previews belong in the shared audit log; write the capped visitor's message.

### 7. §9 rehearses a path the release does not take, on a premise that does not hold

**Scope:** §9; §2; §5.9.

The hosted database is reset by dump and restore, but the rehearsal tests an in-place `db:migrate`
from 0035, which no target database is on. "All additive" is false: 0035 rewrites brand names and
0036 replaces `v_quarantine_holds` with a different branch rule (the hosted build runs 0034's
view). Pulling the URL with `vercel env pull` into a temporary file breaks the rule "never into a
chat or a file" (`docs/deploy.md:18-19`); the loader already asks at a hidden prompt
(`deploy.md:31-32`). `deploy.md` still describes Render and says to leave every other variable
unset, and no package updates it.

**Simpler path:** rehearse exactly what will run (the loader into a disposable database, then the
live build against it); use the hidden prompt; update `deploy.md` in WP-J.

### 8. Scope and order do not follow the root problem

**Scope:** §1; package order; WP-A; §6.

The first stated gap is that a hosted visitor cannot upload, yet WP-D comes fourth while WP-A
restyles 49 files first. Items serving none of the five success criteria: Ollama, command-menu
changes, the sidebar button, the segmented restyle, legend filters, the one-solid-action gate on
all 25 routes. "Controls look different on every page" has no success criterion.

**Simpler path:** order WP-A step 1, then WP-D, C, E, G, then H, I and J; limit the one-action gate
to the cold reviewer's routes; defer the rest or add a criterion that justifies it.

## Nit

9. **Index on a missing column:** `(visitor_key, created_at)`; the tables have `uploaded_at` and
   `proposed_at` (`0013:20, 55`).
10. **A second identity concept:** `Viewer.subject` already means "who is acting"
    (`lib/viewer.ts:48-53`); give a sandbox guest the subject `visitor:<sha256>` and add an
    `uploaded_subject` column to uploads only.
11. **Where the cookie is set:** `getViewer` runs in server components, which cannot set cookies;
    set `rs_visitor` in `app/api/onboarding/uploads/route.ts` and keep `getViewer` read-only.
12. **The onboarding access rule lives in three places** (`service.ts:91-95`,
    `app/onboarding/page.tsx:38-40`, `app/onboarding/[id]/page.tsx:212-214`); export one check.
13. **Implementation detail in the design, and behaviour that already exists:** Tailwind strings
    belong in WP-A; the plot's reserved height, the chart's streaming and `PeriodTabs`' `extra`
    parameter already exist; baseline CLS is already 0.003.
14. **No DOM unit-test setup:** `tests/unit/action-button.test.tsx` needs one; the planned
    Playwright spec covers the same states.
15. **Badges and variant names:** "Held" is amber in the chart but red in the badge; blue means "you
    can act here" (design-system.md:23); build `StateBadge` on `Badge`; do not rename
    primary/secondary.
16. **Inaccurate copy:** "Nothing was written" is untrue (staging rows, audit entries); the
    existing "Nothing was added to the ledger." is exact.
17. **Broken cross-references:** line 350 says WP-F (it is WP-E); J4 undefined; the 200% zoom
    column does not exist; the "recorded rollback" has no step; `RELEASE_COMMIT` is not a hosted
    setting; replay snapshots are stored when the replay runs, so the snapshot period must be fixed
    then; reuse `snapshot()` with a period scope.
