# EGM resolution log: release design

Target: `docs/agent-work/release/RELEASE-DESIGN.md`. Each finding, what changed, and where.
"Accepted" means the design now does what the finding asked; "Adapted" means the finding's
problem is fixed another way; "Rejected" gives the reason.

## Stage 5 (zoom-out `zoom_out_report.md`, inventive catalyst `inventive_catalyst_report.md`)

Resolved in version 2 of the design, 2026-11-18.

| Finding | Severity | Decision | Where in v2 |
|---|---|---|---|
| ZO-1 / IC-1 Visitors share the mapping registry | Blocker / Major | Accepted. Preview mappings belong to their upload (`drafted_on_upload`), carry the owner, and every layout-wide query excludes them; dry runs require matching ownership; a preview mapping cannot be approved; two-visitor tests. A new `Viewer` per request; the cookie set only in route handlers | §5.1, §5.2, WP-D |
| ZO-2 `ActionButton` re-creates `useAction`, reverses rule 13 | Major | Accepted. No new request component; `useAction` gains the missing states; `Working` moves to `ui.tsx`; busy stays `aria-disabled` and focusable | §5.5, WP-A |
| ZO-3 / IC-6 Chart tab stops, tap both previews and opens, a "held" state with no data | Major / Nit | Accepted. Select and open stay separate; points are not tab stops; week and channel buttons are the keyboard path; the chart's own cell states; Back test; focus restored | §5.7, WP-C |
| ZO-4 Freshness: fix the missing run record | Major | Accepted. Sync attempts write `ingestion_runs`; `freshness()` and `StreamFreshness` unchanged; a separate `dataTimes()` adds the named times | §5.4, WP-B |
| ZO-5 Fallback exists; Ollama speculative | Major | Adapted. The brief requires Ollama, so it stays, through the existing `ModelClient` and existing columns (`mode`, `model`); no new mode enum or column; the fallback becomes a catch-all classification | §5.9, WP-F |
| ZO-6 / IC-2 Sandbox lifecycle and caps | Major | Accepted. Whole-graph deletion at 24 h on the wall clock; one result per preview; no shared audit entries; a row budget with oldest-first eviction; a global per-minute limit as the only load refusal; messages written. Per-network keys rejected (personal data) | §5.2, §8 |
| ZO-7 / IC-4 §9 rehearses the wrong path; one database for Preview and Production; secret via a file | Major | Accepted. A Neon branch for the release, used by Preview and then promoted with the code; rehearsal is exactly the loader plus both builds; "not all additive" stated; secrets only through the clipboard (Vercel refuses to release the sensitive variable); `deploy.md` updated in WP-J | §5.11, §9, WP-J |
| ZO-8 Scope and order | Major | Accepted. Order A-primitives → D → B → C → E → G → F → H → I → J; one-primary-action gate on the cold reviewer's routes; legend filters dropped; command menu fixed only where the audit fails | Plan order, §5.5, §5.6, §6 |
| IC-3 Recomputing although the hosted ledger never changes | Major | Adapted. Per-request dedupe and the top query's plan first; a read-through cache only if the preview still misses 1,500 ms, only with no writer reachable, keyed by the data load | §5.10, WP-G |
| IC-5 Red CI or skip is a false choice (quarantine lane) | Nit | Rejected: the brief asks for root causes; a red suite blocks promotion | §7, WP-I |
| IC-7 Fallback allow-list; local model inherits the Anthropic request | Nit | Accepted. Per-provider profiles; unknown errors classified, never rethrown; tolerant usage | §5.9, WP-F |
| IC-8 Outcomes judged from the response, not stored state | Nit | Accepted. 409 and dropped connections refresh to stored state; reconciliation status read from the outbox, never claimed | §5.3, §5.5 |
| ZO-9 Index on a missing column | Nit | Accepted. 0037 indexes real columns | §9 |
| ZO-10 A second identity concept | Nit | Adapted. The owner key is `Viewer.subject` (`visitor:<sha256>`), stored as `sandbox_owner`, a separate column because the existing `*_subject` columns record who acted, not who may read | §5.1, §9 |
| ZO-11 Where the cookie is set | Nit | Accepted. Route handlers only; `getViewer()` read-only | §5.1, WP-D |
| ZO-12 Access rule in three places | Nit | Accepted. `lib/onboarding/access.ts` | WP-D |
| ZO-13 Implementation detail in the design; behaviour that exists | Nit | Accepted. Class strings moved out; existing behaviour credited | §5.5, §5.7 |
| ZO-14 DOM unit test without a setup | Nit | Accepted. Browser spec only | WP-A |
| ZO-15 Badges and variant names | Nit | Accepted. `StateBadge` on `Badge`; held amber; blue stays actionable; names unchanged | §5.5, §5.8 |
| ZO-16 "Nothing was written" untrue | Nit | Accepted. "Nothing was added to the ledger." | §5.2 |
| ZO-17 / IC other errors: cross-references, J4, zoom, rollback, `RELEASE_COMMIT`, snapshot period, `StreamFreshness`, ledger links with no target | Nit | Accepted. J1–J4 defined; zoom defined in §6; rollback verified in WP-J; `RELEASE_COMMIT` removed; period snapshots computed at replay time; `StreamFreshness` unchanged; `ledger_target` stored at dry-run time | §5.3, §5.8, §6, WP-E, WP-J |

Also added for the refined brief: investigation previews for guests (§5.2, WP-F), the four data
times (§5.4), fixtures and databases (§11), the benchmark method (§10), five distinct states (§5.8),
320 px, 200% zoom and reduced motion (§6, §10).

## Stage 6 (comprehension, `comprehension_report.md`)

Resolved in version 3 of the design, 2026-11-18.

| Finding | Severity | Decision | Where in v3 |
|---|---|---|---|
| 1 The clipboard path loads data when only a variable should change | Blocker | Accepted. Two procedures, "load a database" (the release database only) and "set a variable" (Preview, promotion, rollback); who does each step; `env add` for the git-branch Preview record, `env update --yes` for the shared record; `env rm` never used (it needs a person's approval in this CLI, checked on a probe variable) | §5.11, WP-J 6 and 8 |
| 2 Rollback confirmed by a field the old build lacks; short vs full SHA | Major | Accepted. Deployment id, the old response shape and migrations ending at 0034; SHA compared in full or by prefix | §5.11, §9 |
| 3 How a request becomes a staff role | Major | Accepted. Viewer resolution in precedence order, the flag combinations table, "staff" and "company" defined | Terms, §5.1 |
| 4 Ownership of child rows; the key's stored form | Major | Accepted. Children are reached only through an owner-checked parent; the stored form is the subject, `visitor:<64 hex>` | §5.1, WP-D |
| 5 Clocks | Major | Accepted. A table per item kind: created, expires, trigger, removed, kept; business fields keep the business clock; the wall-clock column comes from the database; every time names UTC | §5.2 |
| 6 Lifecycle gaps | Major | Accepted. The cookie is re-set on every start; one deletion call covers investigations; investigation limits added; the row budget reserves twice the rows at staging | §5.1, §5.2 |
| 7 Data times | Major | Accepted. "Data as of" stays in `freshness()`; `/audit` shows all four; the test's wording; expected hosted values; the stored fact named; "polling run" defined | §5.4, Terms |
| 8 "Preview" and "promote" overloaded | Major | Accepted. The visitor feature is the "workspace" (`PUBLIC_WORKSPACE`, `workspace_owner`); "Preview deployment" is Vercel's; promotion defined once; B09 "not featured as a headline result" | Terms, throughout |
| 9 Implementation order | Major | Accepted. A dependency table; WP-0 for the work already in the tree; WP-B before WP-D; the route audit in WP-C step 0; WP-I after WP-G with its baseline done during the design; one owner per file | Plan |
| 10 Which commit is released | Major | Accepted. The release SHA is the last commit, made before the checks; a fix restarts step 1; `deploy.md` before it; post-release records on the git release branch only | WP-J 1 and 11 |
| 11 Rehearsal step 3 unclear | Nit | Accepted. It protects a rollback by redeploy, which builds with current variables | §9 |
| 12 Undefined references; "busy" overloaded | Nit | Accepted. A Terms table; "full" for the budget, "at capacity" for the rate limit | Terms, §5.2 |

Also corrected: B03's figures (the seeded data gives October $227.42 over 50 paid customers in the
scorecard and in Decision Lab, September $253.83 over 51); the Overview's doubled reads traced to
the request-time prerender, with the measured effect of `connection()` (§4, §5.10).

## Stage 7 (critic: structural, style, design; `critic_report.md`)

Resolved in version 3 of the design (revised in place), 2026-11-18.

| Finding | Severity | Decision | Where |
|---|---|---|---|
| S1 / T2 Company visibility stated several ways | Major | Accepted. One read rule in §5.1: a workspace guest reads company investigations read-only and no company upload, mapping or approved hint | Terms, §5.1, §5.2 |
| S2 The brief's requirements not in §1; quarantine rejection restates the decision | Major | Accepted. "What the brief requires" list in §1; the quarantine lane would hide the real Decision Lab layout shift | §1, §7 |
| S3 Risks split; idle compute missing | Major | Accepted. §8 points to the threat model; an idle-compute row; §4 records "first request after idle" without a target | §4, §8 |
| S4 J1–J4 undefined; Back claim too wide | Major | Accepted. A journeys table in §6 mapped to the success criteria; only J1 and J2 test Back; shell checks moved to `release-controls.spec.ts` | §6, §8, WP-B |
| S5 `PUBLIC_WORKSPACE` on Production unspecified | Major | Accepted. Git-branch-scoped for the Preview deployment; Production at promotion; it stays after a rollback | Terms, §5.11, §9, WP-J |
| S6 / T10 Which rollback steps are verified; git `main` after a real rollback | Major | Accepted. Verified: the deployment step only; a real rollback also reverts git `main`'s tree to `1814616`; "Neon branch `main`" and "git `main`" always named | §9 |
| S7–S15 Terms, measurement definitions, baseline contents, alternatives outside §7, cross-references, formatting | Nit | Accepted | Terms, §2, §4, §5.2, §5.7, §5.8, §7, §10, §11 |
| T1 The owner's four names; cookieless first item; `Secure` | Major | Accepted. "Owner" defined once; the handler creates the token before storing; `demo:guest` never stored; same token re-sent; `Secure` on every HTTPS deployment | Terms, §5.1 |
| T3 Times in copy | Major | Accepted. Absolute UTC dates, "available until … then deleted within a day" | §5.2 |
| T4 Undefined demos in copy | Major | Accepted. "Local demo" defined and linked; "Would count after staff approval (local demo only)" | Terms, §5.2 |
| T5 The 10-mapping message | Major | Accepted. "Delete it, then upload the file again" | §5.2 |
| T6 The 409 rule | Major | Accepted. Every 409 is an error in the server's words and refreshes the page; a dropped connection refreshes with its own words | §5.5 |
| T7 Primary-action count | Major | Accepted. At most one, none when the viewer cannot act; Try the sample primary | §5.5, §6 |
| T8 200% zoom | Major | Accepted. 720 × 450 CSS px at device scale 2 | §6, §10 |
| T9 Release worktree undefined | Major | Accepted. Defined; only the loader uses it | Terms, §5.11, WP-J |
| T11 Targets lack tolerance; "warm" undefined | Major | Accepted. 10% tolerance; Preview warm = median of runs 2–5; targets are goals, regressions block | §4, §5.10, §10 |
| T12 No correlation key for reconciliation | Major | Accepted (with D8). Plain words for a marketing user | §5.3 |
| D1 Sync attempts as runs | Major | Accepted. A run only for a job that ends succeeded, in that transaction; `id desc` in the four readers; one office's failure never blocks every branch; the rate-limit test | §5.4, §7, WP-B |
| D2 Rollback by redeploy leaks investigations | Major | Accepted. Workspace investigations in their own tables (fail closed); uploads stay shared because every build refuses onboarding to the guest; rehearsal step 3 seeds workspace items; a guard test | §5.1, §5.2, §7, §9, WP-F |
| D3 Limits cap the wrong things | Major | Accepted. `workspace_quota` by minute and day, items and rows, refusals counted and not audited, an advisory lock, a 30-minute residency, a flood test | §5.2, §8, WP-D |
| D4 Hosting limits | Major | Accepted. A 4 MB workspace limit in the browser and on the server, Vercel's 413 read as the same refusal; `maxDuration` measured and set; Preview behind Vercel Authentication (checked), so the Preview smoke and cold review run in the owner's Chrome and the Playwright two-session run and measurements run on the production URL after promotion, with a production-mode local run before | §5.2, §5.11, §10, WP-J |
| D5 Deletion not guaranteed | Major | Accepted. Unreadable at expiry; a daily public, idempotent cleanup cron; Neon's restore window read and stated; `purgeExpired` skips workspace uploads | §5.2, WP-D, WP-J |
| D6 Overview target reachability | Major | Accepted. Trace what gates the verdict and split it; total orderings first; tie fixtures; targets are goals and a miss is reported, regressions block; precomputation listed as an alternative | §5.10, §7, WP-G |
| D7 Investigator key leak; catch-all hides defects | Major | Accepted. Explicit `apiKey: "ollama"`, loopback only unless allowed, precedence stated, a fallback row, "other" logged and failing tests and `eval:ai` | §5.9, WP-F |
| D8 Publication and reconciliation | Major | Accepted. `onboarding_publications.txid` and the outbox's snapshot predicate | §5.3, §9 |
| D nits | Nit | Accepted, except the 409 code (not needed: every 409 is an error and refreshes) and `--skip-domain` (considered; the git flow with a verified rollback kept) | §5.2, §5.7, §5.10, §5.11, §7 |

## Stage 8 (intermediate zoom-out, `intermediate_zoom_out_report.md`)

| Finding | Severity | Decision | Where |
|---|---|---|---|
| 1 Visitor investigations | Major | Kept, justified: the brief's promotion gate requires the hosted URL to pass a "keyless investigator" check, and the hosted demo has only guests; now listed in §1. The read rule says plainly that the hosted list holds only the visitor's own items | §1, §5.1 |
| 2 Quota grid | Major | Accepted. Per-visitor caps dropped; one counter of rows written by staging and dry runs (minute and day), the sample exempt; per-minute start caps per kind; `WORKSPACE` holds every limit | §5.2, WP-D |
| 3 Sync runs overstate freshness | Major | Accepted. No new runs; `dataTimes()` reads `sync_jobs` beside the runs, labelled with office and clock; readers untouched | §5.4, §7, WP-B |
| 4 Hosted cache and `data_loads` | Major | Accepted. Both removed; the cache listed as deferred in §7 | §5.10, §7, §8, §9 |
| 5 Actor table contradiction | Major | Accepted. The row lists the workspace tables and `workspace_quota` | §5.1 |
| 6 Publication coverage | Nit | Accepted. `txid` and coverage tracking dropped; the card's overclaim replaced by a true sentence and the Audit & Health link | §5.3, §7, §9, WP-D |
| 7 Deletion wording | Nit | Accepted. One sentence from `availabilitySentence()` | §5.2, WP-D |
| 8 Package order | Nit | Accepted. WP-D needs WP-A steps 1–3 and WP-B step 1 | Plan |
| 9 Linux suite twice; branch recreated | Nit | Accepted. GitHub CI is the gate; the branch is created if missing and reloaded only when migrations or the seed changed | WP-J |
| 10 Cold review not cold | Nit | Accepted. Smoke items deleted first | WP-J |
| 11 `OLLAMA_ALLOW_REMOTE`; clipboard helper | Nit | Accepted. Loopback only; the loader's reader moved to `scripts/clipboard.ts` and reused | §5.9, §5.11, WP-F, WP-J |

## Stage 9 (implementation readiness, `implementation_readiness_report.md`)

Resolved in version 4 (the Detailed Implementation Plan rewritten; design sections corrected),
2026-11-18.

| Finding | Severity | Decision | Where |
|---|---|---|---|
| C1 The B20 receipt reads `captureState`'s snapshot | Blocker | Accepted. `StateSnapshot.month` from `captureState()`, stored in `action_executions`; the replay interface dropped | §5.8, WP-E |
| C2 / Y-nit `movement-copy.ts` exists; `Cell`, `WeekInfo` | Blocker | Accepted. Modify; `cellSentence(series, cell, week, markers, scopeLabel)` from `pointTitle` and `explainCell` | WP-C |
| C3 / R2 Investigation ids collide; no column list | Blocker | Accepted. `like investigations including defaults …` shares `investigations_id_seq`; reads check the owner | §9, WP-F |
| R1 / C4 Staff repeat detection breaks existing tests | Blocker | Accepted by narrowing: repeat detection for workspace uploads only; the staff flow unchanged, so `stageSample`, `z-layout`, BYOF, `onboarding.test.ts` and `measure.cjs` are untouched | §5.2, WP-D |
| R3 Browser runs outside the suite | Blocker | Accepted. `tests/e2e/hosted.config.ts` (base URL from `BASE_URL`, no server, no global setup); J2 split `@core`/`@edge`; `expireWorkspaceItem()`; exact rehearsal commands | WP-D, WP-J |
| Y2 / R6 / C14 Ownership and boundaries | Major | Accepted. One Files table with Create or Modify for every path, the real paths, both new specs' owners, the 28 `fetch(` files listed, the rule for changing another package's file | Plan |
| Y3 / Y4 / R11 Order and dependencies | Major | Accepted. WP-C step 0 right after WP-A; WP-G after C, D, E; WP-I after F and H | Plan |
| Y5 / R12 Primitives undefined; untested rules | Major | Accepted. WP-A step 1 names each primitive; `data-variant` lets J1–J4 count primary actions; 200% zoom, keyboard-only and reduced motion in J1; `release-controls.spec.ts` names pages and responses; `useAction` gains `DELETE` | WP-A, WP-C, WP-D, WP-F |
| Y6 / C7 / C8 / C9 / C10 Staging order, locks, types, limits | Major | Accepted. Ordered sub-steps; counts committed first; the lock inside the staging transaction; `QuotaRefusal["status"]`; `workspaceStartedAt`; `summaries` moved to `access.ts`; `maxRows` through the parser and XLSX; the body limit per viewer with `content-length` | WP-D |
| Y7 / R4 Snapshot period and storage | Major | Accepted. The latest calendar month the business clock has reached, inside the stored JSON | §5.8, WP-E |
| Y8 / R8 / C16 J3's precondition | Major | Accepted. `seedReplayableIncident()` makes an incident that offers a replay; B20's receipt comes from `os-golden-path.spec.ts`'s fix | WP-E |
| Y9 Seven files unnamed; CI circularity | Major | Accepted. Named; WP-I ends at the full suite in the CI mirror; GitHub CI checked in WP-J | WP-I |
| Y10 "No usage" listed as a fallback | Major | Accepted. Zero tokens, the model's answer kept | WP-F |
| Y11 / R9 Checks not on exactly the SHA | Major | Accepted. `checkout --force`, `clean -fdx -e node_modules`, empty `status`, `npm ci`, `npm run build` | WP-J |
| Y12 Worktree rerun; loaded SHA | Major | Accepted. Created or checked out; loads recorded in `checks/loads.md` | WP-J |
| Y13 Records after the SHA | Major | Accepted. One docs-only commit for everything under `docs/agent-work/release/` made after the SHA | WP-J |
| Y14 States; production J2 | Major | Accepted. `harness/states.cjs` with triggers and records; production runs `@core` only | WP-J |
| C5 / R5 Broken mocks and assertions | Major | Accepted. `review-regressions`, `ai-investigator` mock, `get-viewer` (mock `connection`), `z-onboarding` lines 38 and 73, `z-layout` lines 85–93, `crm_customers`, visual baselines refreshed in WP-J step 1 | Plan |
| C6 / R4 Undeclared writes | Major | Accepted. WP-D's and WP-F's Writes list every table, including `purgeExpired`, cleanup, eviction and the skipped audit call sites | WP-D, WP-F |
| C11 Ledger targets | Major | Accepted. Lookups through `identity_links`, `P-<identity id>` for prospects, `campaign_branch_map`, `metric=paid_spend`, `period=all` outside September and October | §5.3, WP-D |
| C12 WP-F types and files | Major | Accepted. Profiles return the SDK's own request type; `ModelClient` unchanged; `describeApiError` becomes `classifyModelError`; `contract.ts`, `eval-ai.ts`, `steps.ts`, routes and tests listed; the beta endpoint checked against Ollama | WP-F |
| C13 WP-E and WP-G files; `v_acquisitions` | Major | Accepted. `CaseQueue.tsx` and `badges.tsx` to WP-E; `ShellStatus`, `app/page.tsx` changed by WP-G under the rule; step 3 conditional, as migration 0038 on the view, with `eligibility.ts` | WP-E, WP-G |
| C15 / R-nit The sample's hash | Major | Accepted. `.gitattributes` pins the sample; the hash form named; a unit test recomputes it | §9, WP-D |
| R7 Quota tests and flood | Major | Accepted. Buckets defined; tests preset quota rows and backdate; 10,000-row flood files | WP-D, §11 |
| R10 `maxDuration` circular | Major | Accepted. 60 s stated now; confirmed in WP-J step 7 | §5.11, WP-J |
| Nits | Nit | Accepted: one name per thing (`harness/`, "the project owner's Chrome", the 404 message); the published card's sentence depends on rows published; `PeriodTabs` uses `extra`; the cookie's `secure` decided from the request | Throughout |

## Stage 9 re-audit (one pass, `egm:egm-implementation-readiness`)

No Blockers; R2, R3, R4, R7 and most Majors resolved. Ten Majors left (N1–N10), resolved in
version 4 the same day:

| Finding | Decision |
|---|---|
| N1 `repeatOf` in `stageUpload`'s type breaks staff callers | `stageWorkspaceUpload` is its own function; `stageUpload`'s type is unchanged |
| N2 §5.3 still called a staff re-upload a repeat | Reworded: it stages anew and publishes nothing |
| N3 J3's fixture used calls@1.2 and the default clock | `mapper: mapperFor("calls", "1.0")`, reconciled at `getNow`; WP-E runs J3 with `os-golden-path.spec.ts` |
| N4 `z-onboarding` line 72 | The guest leaves the refused loop; a new assertion expects the workspace form and a 404 |
| N5 / N6 WP-F's writes | Every investigator route runs the cleanup; the investigation's own failure update goes to its table; only `audit_log` writes are skipped |
| N7 Per-package browser command | Stated once in "How the work is done" |
| N8 The states run's server | Its own start command and arguments |
| N9 Pages still check `can.propose` | The pages' flags follow `onboardingAccess` |
| N10 Limits presets leak | An `afterEach` resets quota rows and workspace uploads |
| R6 / R8 / R12 / Y4 leftovers | Globs replaced by file names; the sample-hash test named; J3's spec named; 200% zoom and "exactly one primary for the acting role" in the states run; route-audit failures in WP-D and WP-F |

Stage 9 is closed with this pass; implementation continues under the plan's rule that a changed
interface or write boundary updates the plan first.
