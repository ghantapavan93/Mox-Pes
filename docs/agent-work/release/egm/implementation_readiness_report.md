# EGM Stage 9: implementation readiness report

- **Target:** `docs/agent-work/release/RELEASE-DESIGN.md`, DetailedRange (the Detailed
  Implementation Plan, lines 1003–1493 of the reviewed version)
- **Reviewers:** `egm:egm-implementation-readiness` and `egm:egm-codebase-details` (standard:
  `implementation-readiness-standard.md`), `egm:egm-style`; each with fresh context
- **Owner's requirement for this stage:** verify the actual write boundaries and runnable tests
- **Date:** 2026-11-18
- Resolutions: [`resolution_log.md`](resolution_log.md)

## Style review

14 Major, 5 Nit.

**Major**

- **Y1.** "The B03 check (§5.8)" points to the wrong section and says nothing about how to run it.
- **Y2.** The file-owner paragraph and the packages' Owns lists disagree: `lib/jobs/sync.ts` given to
  WP-B but unchanged; `/audit`, `FindingsView`, `JourneyTimeline` claimed twice; WP-0's files owned
  again later; "asks for it in the owner's section" names no place, and a finished package cannot
  act. Fix: one path-to-package table; WP-0's ownership ends at its commits; the package that needs
  a change makes it and names the owner in the commit body.
- **Y3.** WP-G needs WP-D too, and must own the Overview and the components §5.10 step 1 lists.
- **Y4.** The route audit hands failures to WP-D and WP-F, which have no step to fix them; run WP-C
  step 0 right after WP-A and make D, E and F depend on it.
- **Y5.** "The primitives" undefined; no step builds the segmented track, the hit-area utility,
  `docs/design-system.md` or `StateBadge`; no package tests the one-primary-action rule or sets
  `maxDuration`.
- **Y6.** WP-D step 3 lists twelve actions in an order that does not match §5.3; "one dry run per
  workspace upload" reads as a refusal; `stageUpload`'s refusal type lacks 503.
- **Y7.** How a replay's `period` is chosen is unstated.
- **Y8.** J3 depends on another spec's mutation, so WP-E's own gate can fail alone; the spec is
  `golden-path.spec.ts` in one place and `os-golden-path` in another.
- **Y9.** The seven spec files are never named; "the mirror" is ambiguous; WP-I step 4 needs the pull
  request that WP-J opens while WP-J needs WP-I.
- **Y10.** "Returns no `usage`" is listed as a fallback case, contradicting "counts zero tokens".
- **Y11.** `git checkout --detach` in the build mirror keeps untracked files and local edits, so the
  checks may not run on exactly the release SHA.
- **Y12.** WP-J step 4 loads from the release worktree that step 5 creates; `git worktree add` fails
  on a rerun; the loaded SHA is recorded nowhere.
- **Y13.** Records made between the release SHA and promotion fit neither step 1 nor step 11.
- **Y14.** Step 2 gives no trigger or record for loading, empty and failed states; step 8 runs J2,
  whose expiry case writes to the database, which is not possible on production.

**Nit:** three forms of the harness path; three things with two names each; "the owner's Chrome"
clashes with "Owner" in Terms; Codex X1 targets differ; "4 MB + 1 byte" should be
`WORKSPACE.maxBytes + 1`; name the file for each test.

## Codebase-details review

3 Blocker, 12 Major, 5 Nit.

**Blocker**

- **C1. The B20 receipt does not read the snapshot the plan changes:** `FixResult.tsx:27-73` reads
  `execution.before/after.branch`, the `StateSnapshot` from `captureState()`
  (`lib/workflow/snapshot.ts:60-124`, over `PERIODS.all`), stored in `action_executions`
  (`lib/workflow/proposals.ts:505-523, 580`); `replay.ts`'s `snapshot()` is private and writes only
  `replays.metric_*`; no `ReplaySnapshots` type exists. Fix: add an October `BranchSnapshot` to
  `StateSnapshot`/`captureState`, own `lib/workflow/snapshot.ts` in WP-E, drop the replay interface,
  say that earlier executions lack the field.
- **C2. `lib/metrics/movement-copy.ts` already exists** (`explainCell`, `pointTitle`, `weekLabel`,
  `dollars`, used by `MovementChart.tsx` and the trace page); `MovementCell` does not exist (the
  type is `Cell`, which holds only `week`). Fix: Modify; build `cellSentence` from `pointTitle` and
  `explainCell` with `Cell`, `WeekInfo` and markers.
- **C3. Workspace investigation ids collide with company ids:** routes look up a bare number
  (`lib/ai/queries.ts:125-129, 235-237`). Fix: one id form, a `W-<id>` reference or one sequence
  shared by both tables, with the route changes listed.

**Major**

- **C4. Repeat detection breaks call sites and tests not listed:** the `repeatOf` result breaks
  typecheck in `onboarding.test.ts:42-44`, `concurrency.test.ts:75-77`, `security.test.ts:25-27`;
  `onboarding.test.ts:130-139` re-stages a published file; `stageSample` asserts 201;
  `z-layout.spec.ts:50-56` stages one file at four widths; BYOF's "valid file again" expects a second
  upload; `z-onboarding.spec.ts:38` expects "New, eligible6"; `:73` expects 403.
- **C5. Shared mocks and fixtures break; helpers not reused:** `review-regressions.test.ts:108-111`
  compares the guest's permissions with a nine-key object; `ai-investigator.test.ts:33-38` mocks
  `@/lib/server` without `viewerForWorkspaceStart`; `withDemoPool` is private in `tests/e2e/db.ts`;
  reuse `tests/helpers.ts` and `setRole`; seed in `beforeAll` as `scenario.test.ts` does.
- **C6. WP-D's Writes line is incomplete:** every onboarding call runs `purgeExpired` (company
  uploads' cells); cleanup and eviction delete other owners' uploads, workspace investigations and
  quota rows; the `audit_log` call sites to skip are `service.ts:154, 181, 310, 397, 446, 548`.
- **C7. Quota and lock signatures allow the wrong connection:** an advisory transaction lock taken on
  the pool serialises nothing; counts written inside a refused transaction roll back. Fix: `tx:
  PoolClient` inside `stageUpload`'s transaction; counts committed in their own transaction first;
  name the lock key.
- **C8. `stageUpload`'s refusal type leaves out 503.**
- **C9. `UploadSummary` lacks the workspace start; `uploadFor` would create an import cycle**
  (`summary()` is private to `service.ts`). Fix: add `workspaceStartedAt`; move `summaries` into
  `access.ts`.
- **C10. The parser row limit and the 4 MB check are undeclared:** `parseUpload` takes no limit
  (`parse.ts:361`, `LIMITS.maxRows` at `:248, 331, 407, 409`); XLSX has its own cap (`xlsx.ts:351`);
  the route reads the body at 5 MB and `readBodyBytes` throws "Body over 5 MB".
- **C11. `LedgerTarget` needs design decisions:** `compareLeads` does not select `leads.id`;
  `leads` has no customer column (identity links; prospects use `P-<id>`); spend rows take their
  branch only from `campaign_branch_map`; the trace shows a selection only for
  `metric=paid_spend`; no period exists outside September–October.
- **C12. The WP-F interfaces do not fit `lib/ai/model.ts`:** `CreateParams` is unexported, `BaseRequest`
  does not exist, `ModelClient.create` returns a `BetaMessage`, the request is built inline,
  `ModelRunInput` has no profile, `describeApiError` already classifies; `contract.ts` and
  `scripts/eval-ai.ts` must change; `StepRecorder` hard-codes its table; the audit and failure writes
  and the permission checks must admit the workspace guest; the streamed response must set the
  cookie.
- **C13. WP-E and WP-G change files they do not own:** `CaseQueue.tsx`, `badges.tsx`;
  `ShellStatus.tsx`'s `FreshnessIndicator` reads data without `getViewer`; `app/page.tsx`; the
  "first" orderings live in the `v_acquisitions` view (`0026_latest_identity_decision.sql:62-77`),
  whose appointment ordering is not total, and a second `period_acq` is in
  `lib/metrics/eligibility.ts:150`.
- **C14. File boundary errors:** `components/investigator/FindingsView.tsx` and
  `components/customers/JourneyTimeline.tsx` are the real paths; `Drawer` comes from WP-E's
  `EvidenceDrawer.tsx`; `vercel.json` is new; new or modified is unmarked for scripts and records;
  the two new specs have no owner; open-ended file lists (28 components call `fetch(`);
  `z-layout.spec.ts:85-93` asserts `aria-pressed`.
- **C15. The sample-exemption hash is undefined across platforms:** `file_sha256` hashes the base64
  text, and the sample may be CRLF on Windows and LF on Vercel.

**Nit:** J3 reads the state `os-golden-path.spec.ts` leaves, not `golden-path.spec.ts`'s; the
publish route starts reconciliation only when rows were published; `PeriodTabs` builds links from
`extra` values; `visitorCookie` cannot work out `secure` from the token (reuse
`app/api/role/route.ts:16-18`); `lib/jobs/sync.ts` still in WP-B's owner line.

## Implementation-readiness review

Verdict: not ready. 3 Blocker, 9 Major, 5 Nit.

**Blocker**

- **R1. Staff repeat detection breaks existing test assets no package lists:** `stageSample`
  (`tests/e2e/onboarding.ts:14-16`) expects 201 and is called four times in `z-layout`, from every
  axe, layout-shift and hydration test, and by `z-onboarding` after `z-layout`; `onboarding.test.ts:130-139`
  re-stages a published file; BYOF's "valid file again" fills the editor of a repeat that opens
  result-first; `measure.cjs` runs 2–4 would stop measuring staging.
- **R2. Workspace investigation ids collide with company ids;** "the columns a deterministic run
  fills" is not a column list. Fix: share `investigations_id_seq`; read the workspace row only for
  its owner; give the full column list.
- **R3. The browser runs outside the suite cannot run as specified:** the Playwright config hard-codes
  `localhost` and starts a `DEMO_MODE=1` server; `global-setup` reseeds `DATABASE_URL ?? revenue_signal`
  unless `SKIP_SEED`; J2's expiry needs a database helper; the rehearsal load names no target and
  needs the database to exist; no commands for the previous build. Fix: `tests/e2e/hosted.config.ts`
  (base URL from `BASE_URL`, no web server, no global setup); J2 split into core and edge;
  `expireWorkspaceItem()`; exact commands.

**Major**

- **R4. Undeclared writes:** `purgeExpired` on workspace requests; workspace deletion and eviction on
  staff requests; the cleanup's quota deletes; where WP-E stores October snapshots.
- **R5. Existing assertions broken but not listed:** `z-onboarding:38` ("New, eligible6"), `:73`
  (403→404); `z-layout:85,87,93` (`aria-pressed`); the `VISUAL=1` baselines; `tests/unit/get-viewer.test.ts`
  does not mock `next/server`, and `connection()` throws outside a request; no `customers` table
  (it is `crm_customers`).
- **R6. The file boundary cannot be enforced:** open-ended Owns lists; unnamed test files; files that
  must change with no owner (`tests/e2e/onboarding.ts`, `tests/e2e/db.ts`, `onboarding.test.ts`,
  `get-viewer.test.ts`, screenshots, the BYOF spec, `measure.cjs`, `scripts/eval-ai.ts`); the two
  new specs edited by four packages with no owner.
- **R7. Quota tests and the flood cannot behave as specified:** minute buckets with no time argument;
  31 deterministic investigations exceed vitest's 30 s timeout; the daily cap cannot be reached in a
  test; filling the budget collides with the per-minute cap; 4 MB call files hold about 35,000 rows,
  so every flood upload is refused at parse. Fix: define bucket keys; insert quota rows and backdate
  directly; flood with 10,000-row files.
- **R8. J3's precondition does not exist:** `os-golden-path` reseeds and fixes both replayable
  incidents; refused-revision holds offer no replay. Fix: name J3's incident (a quarantine fixture).
- **R9. Checks may not run on exactly the release SHA** (untracked leftovers; no build listed).
- **R10. `maxDuration` is circular.** State values now; confirm on the Preview deployment.
- **R11. Execution order:** nothing runs Linux CI after WP-F and WP-H land.
- **R12. Interface gaps:** 503 missing from refusals; the earlier upload's page is never told to
  show the repeat notice (`UploadForm` navigates only on `upload`); no delete for workspace
  investigations; `useAction` only POSTs while upload deletion is a DELETE; `release-controls.spec.ts`
  names no page or responses; no package tests the primary-action count or 200% zoom.

**Nit:** define the sample hash with `file_sha256`'s function and pin the bytes in
`.gitattributes`; the B03 check is in §3; `PeriodTabs` takes `extra`; the lead's customer needs a
rule through `identity_links` and each link's `metric=`; server-component words are asserted in
`z-onboarding`, not vitest; `movement-copy.ts` exists.

**Verified runnable and sound:** test discovery (vitest `include`; both `release-*` specs run after
`os-modules` and before every `z-*`); every script exists; ports, mock URL and `revenue_signal_rc`
line up; the loader protects the right databases and accepts the rehearsal database with
`ALLOW_LOCAL_TARGET=1`; the counted-import predicate; `sync_jobs` columns; the planner creates no
proposal for a guest; children-first deletion is required.
