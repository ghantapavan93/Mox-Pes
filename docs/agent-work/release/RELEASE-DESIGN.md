# Revenue Signal OS: design through hosted release (2026-11-18)

**Status:** plan, version 4. EGM Stages 5–9 reviewed versions 1–3; every finding is resolved here,
and `docs/agent-work/release/egm/resolution_log.md` records how. A focused re-check of the Stage 9
resolutions (write boundaries and runnable tests) precedes the code changes after WP-0. Owner: Claude
Code. All data is synthetic, and brand names are fictional (migration 0035).

## Terms

| Term | Meaning here |
|---|---|
| EGM | The review method used on this plan: stages 5–9, each run by reviewers with fresh context; reports in `docs/agent-work/release/egm/` |
| The brief | The owner's release instructions of 2026-11-18; what they require is listed in §1 |
| Hosted demo | The public copy on Vercel and Neon. Used for every public deployment; "public demo" appears only in words shown to visitors |
| Local demo | The app run on a laptop with `DEMO_MODE=1`, where the role picker gives staff roles (README, "Run the demo locally"). The only place a file can be counted |
| Release worktree | A clean detached worktree at exactly the release SHA, used only to run the loader; never the build mirror, which holds uncommitted files |
| Guest | A visitor with no role: the only viewer on the hosted demo |
| Workspace guest | The guest when `PUBLIC_WORKSPACE=1`: it may use its own workspace (§5.1) |
| Staff role | Any other role: marketing analyst, integration engineer, revenue ops approver, branch partner (one branch), brand marketing lead (one brand). Reachable only in demo mode, through the role picker (§5.1) |
| Company upload, company mapping | Made by a staff role; no owner; visible only to staff roles that may onboard |
| Company investigation | Made by a staff role; no owner; visible to staff whose scope covers it, and shown read-only to guests as examples |
| Company scope | All 44 branches, the scope of every company-wide role |
| Workspace | A workspace guest's own uploads and investigations. Private to its owner, deleted 24 hours after each item starts, never counted |
| Owner | The subject that owns a workspace item: `visitor:` followed by the 64-character hex SHA-256 of the visitor's cookie token. Stored as `workspace_owner` |
| Preview deployment | The deployment Vercel builds from the git release branch, in Vercel's Preview environment |
| Git release branch | `feature/audit-enterprise-redesign` |
| Release database | The Neon branch `release-2026-11-18`, loaded from the release SHA's seed |
| Release SHA | The one commit that is verified, previewed and made live (WP-J step 1) |
| Promotion | Making the release live: update the shared `DATABASE_URL` record (Production and Preview) to the release database, add `PUBLIC_WORKSPACE=1` for Production, then fast-forward `main` to the release SHA, which builds Production |
| Build mirror | `C:/Temp/rso-release`, a detached worktree where builds and test runs happen (the plan's preamble) |
| CI mirror | `harness/linux-ci-repro.sh`: GitHub's Linux job reproduced in Docker |
| B20, B09, B03 | The demo's scenario branches. B20: a renamed call-feed field held calls at intake, and a replay repairs October's CAC. B09: Local Services spend moving into Performance Max, with refused spend revisions holding its decision. B03: the branch used to check that Decision Lab's baseline equals the scorecard |
| Hold hardening | The 2026-11-18 fixes to the refused-revision hold (findings K1–K6), migration 0036 and their tests: `tests/integration/refused-revision.test.ts` (22 tests, 11 new), an overlap test in `b09-recovery.test.ts`, `tests/unit/refused-revisions.test.ts` (10 tests). Verified in that pass (`docs/agent-work/HOLD-TO-DECISION.md` §10); WP-0 runs the checks again before committing it |
| Approved hint | The newest approved mapping for an export layout, offered as suggestions to the next upload with that layout |
| Spec hash | The hash of a mapping's rules; two mappings with the same hash are the same mapping |
| Outbox, worker | Domain events are written to `domain_events` and handled by `dispatchEvents`, which the worker (`npm run worker`) runs on a schedule. The hosted demo runs no worker |
| Polling run | One scheduled read of one source stream through `runStream`, recorded as one `ingestion_runs` row; the seed simulates them |
| Release regression | WP-J step 1: every suite on the release SHA |
| Eval packs, BYOF | `npm run eval:ai` runs the investigator's five frozen evaluation packs; `npm run acceptance:byof` is the bring-your-own-file acceptance run |
| Codex task X1 | An outside cold review of the Preview deployment by another agent, requested through `docs/agent-work/release/AGENT-BOARD.md` |
| `NONE` | The all-false permission set in `lib/viewer.ts` |

## 1. The problem, and what success looks like

Revenue Signal OS is a working demo of one claim: it tells a marketing team when a jump in customer
acquisition cost (CAC) comes from the data rather than the market, before budget moves. It
reconciles ad spend, calls, web leads, CRM customers and payments for a synthetic 44-branch
pest-control company. When the evidence behind a budget decision is incomplete, it holds the
decision, says why, and shows what a correction changed.

The hosted demo shows that to nobody who arrives cold:
- every hosted visitor is a read-only guest, who can neither upload a file nor ask the
  investigator a question;
- on a phone, neither Decision Lab nor the upload result shows its next action on the first
  screen (§4);
- the Overview takes about 2 seconds to answer locally, and longer on the hosted database;
- GitHub CI has been red since 2026-11-17.

**Success.** A reviewer opens the hosted demo cold, on a phone or a desktop, and without help:

1. understands in one screen what the product does;
2. loads the built-in sample or uploads their own compatible export;
3. sees what was read, what would count, what did not and why, what repeats, and what matches the
   ledger;
4. traces a held metric to the source record behind it;
5. sees what an approved correction changed, and what it did not.

| Audience | Must be able to answer |
|---|---|
| VP | Should we act on this number? |
| Marketing manager | Why is the number what it is, and can I defend it? |
| Engineer | Can I reproduce it? |

**What the brief requires,** beyond the success criteria:
- Hosted upload: a sample and a real file chooser; formats, columns, currencies, limits and what
  happens to the file stated before upload; the existing parser and validation; results private to
  the visitor, with ownership and expiry enforced on the server, readable again later; accepted,
  rejected (with reasons) and matching rows; never "booked"; repeat detection, useful retry
  feedback, source-row links that respect scope; no write-capable role for guests.
- Counting only through the existing staff flow with a separate approver; spend and payment files
  compare-only; a retried staff import never applied twice.
- Proof in two real browser sessions, and of malformed, oversized, duplicate and expired files.
- Freshness that tells the demo snapshot, the last successful sync and the last counted import
  apart, never moved by a preview, rejection, repeat, queued job or compare-only file.
- Controls to the reference's sizes and states; charts with the same facts on hover, tap and
  keyboard; Back restoring filters, selection and focus; the verdict and its next action on a
  390 px first screen; 320 px, 200% zoom, keyboard-only and reduced motion checked.
- The deterministic investigator by default, which a visitor to the hosted demo can ask with no
  key (promotion requires the hosted URL to pass a "keyless investigator" check); Ollama only
  through the existing provider interface; fallback on timeouts, invalid answers and quota
  failures; uploaded rows never sent to a model.
- Linux CI failures fixed at their cause; Vercel and Neon only; a Preview deployment on isolated
  data before promotion; a verified rollback; a short recording if capture works.

**Rubric.** The Software Engineer, Marketing posting (§2). The demo is judged on what it proves,
partly proves, or does not claim.

**Non-goals.**
- Real ad or CRM accounts.
- A per-visitor counted ledger on the hosted demo: a visitor's file is never counted.
- Lifetime value, retention modelling.
- A hosted language model (no paid or unverified free inference).
- Data warehouse exports (Snowflake, Fabric, Power BI).
- New features copied from the visual reference. Only its sizes and behaviours are copied.
- Restyling every page. Shared primitives change; routes off the cold reviewer's path keep their
  layout and only lose defects the route audit finds (§6).

## 2. The posting, mapped to what the demo shows

The posting text is the candidate's copy, kept outside this repo. Lines are paraphrased.

| Posting asks for | Verdict | Where the demo shows it |
|---|---|---|
| Find why marketing data does not match sales results | **Proves** | B20: October CAC $490.11 → $271.31 after a replay repairs the denominator; reconciliation incidents (`/exceptions`) |
| Attribution and funnel reporting: spend → leads → bookings → revenue → lifetime value | **Partly proves** | Spend → leads → customers → cash per branch and channel (`/`, `/branches/[id]`, trace). Stops at cash collected; lifetime value is not claimed |
| Dashboards for acquisition cost, conversion, retention, channel performance | **Partly proves** | Overview, branch scorecard, Decision Lab. Retention is not modelled |
| Integrations with marketing platforms, CRM, REST APIs, designed for failure | **Partly proves** | Versioned mappers, a FieldRoutes-compatible connector against a mock, retries, quarantine and replay (`/integrations`), the workspace upload (§5.2). Never run against a real account |
| Multiple branches, brands and departments | **Proves** | 44 branches, fictional brands, roles enforced on the server (`lib/viewer.ts`) |
| Shared pipelines and consistent business metrics | **Proves** | One definition per number (`/definitions`); the same functions feed every view |
| Monitoring; resolve failed jobs, inaccurate data, broken integrations | **Proves** | Audit & Health, sync jobs with retry, data times (§5.4), incidents with dated evidence |
| Safe production migrations | **Proves** | Numbered migrations; this release's upgrade is rehearsed on a disposable copy and the previous build is run against it (§9) |
| CI/CD, testing, release process | **Partly proves** until CI is green on the release SHA, then **Proves** | Vitest, Playwright, acceptance runners, a Preview deployment on its own database, promotion, a verified rollback (WP-I, WP-J) |
| Discovery → release → production support | **Proves** | This document: baseline, plan, fresh review, release, smoke test, rollback exercised (WP-J) |
| Use AI thoughtfully | **Proves** | Read-only investigator. The deterministic evidence path is the only hosted path; a local model runs only through the same interface; no model writes or approves; uploaded rows never reach a model (§5.9) |
| Reporting definitions and data limitations clearly understood | **Proves** | Every hold names its limitation; missing, held, zero, corrected and approved look different (§5.8) |
| Next.js, PostgreSQL, role-based access, Vercel | **Proves** | The stack itself |
| Google Ads, Local Services Ads, marketing attribution | **Partly proves** | B09: Local Services moving into Performance Max, modelled on synthetic data, claimed only inside its verified window (Oct 13–30). Repeated refusals neither multiply dollars nor clear a live hold (`refused-revision.test.ts`). B09 is not featured as a headline result until the release regression passes |
| Snowflake, Fabric, Power BI, Azure, Python | **Does not claim** | — |
| Work with executives and stakeholders | **Does not claim** | A demo cannot show it |

## 3. Where the product is today

From a code survey on 2026-11-18. Files are cited so a reviewer can check them.

- **Roles** (`lib/viewer.ts`, `lib/server.ts:9-20`, `lib/demo-mode.ts`):
  - Demo mode is on in development and tests, or when `next start` gets `DEMO_MODE=1`. In demo
    mode a role picker in the header sets the cookie `rs_role` (`POST /api/role`); there are no
    passwords. A missing or unknown role is the guest.
  - Outside demo mode the cookie is ignored: everyone is the guest. The hosted demo runs this way.
  - The guest's permissions are all false (`VIEWERS.guest`, one shared module constant).
- **What the guest cannot do today:**
  - Upload: onboarding requires `propose` or `approve` and company scope
    (`lib/onboarding/service.ts:91-95`, repeated in `app/onboarding/page.tsx:38-40` and
    `app/onboarding/[id]/page.tsx:212-214`).
  - Ask the investigator: it requires `investigate` (`lib/ai/investigate.ts:108`), which also
    unlocks writes elsewhere: experiment analyses, inquiries and their notes, checks against other
    systems, budget scenarios (`lib/decision/experiment.ts:272`, `lib/inquiry/store.ts:37-86`,
    `lib/shadow/store.ts:89`).
- **Business clock.** One row, `app_clock.now`, set by the seed to 2026-10-31 13:00 UTC
  (`lib/db.ts:108-111`). Locally only simulation scripts move it (for example the B09
  acceptance's deliveries); on the hosted demo nothing does. Every onboarding time, including the
  24-hour expiry of staged rows, is on this clock, so nothing staged on the hosted demo would ever
  expire.
- **Upload path** (`lib/onboarding/service.ts`):
  - `stageUpload` → `proposeMapping` → `runDryRun` → `decideMapping` → `publishUpload`.
  - Mappings are versioned per (dataset, layout fingerprint), across all uploads
    (`database/migrations/0013_onboarding.sql:42-64`). `proposeMapping` reuses any proposed or
    approved mapping with the same spec hash (`service.ts:299-300`); `getUpload` lists every
    mapping for the layout and the page treats the newest as current (`service.ts:252-268`).
  - Only call and web-lead files can count. They count when a different role approves the mapping
    and publishes (`service.ts:432-539`). Ad-spend and payment files are compare-only
    (`lib/onboarding/targets.ts`).
  - Publishing is once per upload: `onboarding_publications.upload_id` is unique and a second
    publish answers 409 "This upload is published" (`service.ts:484`). A row the ledger already
    holds is compared as "matches ledger" and never published again (`service.ts:507-514`).
  - A repeat of the same file is not detected: `file_sha256` (the hash of the file's base64 text)
    is written and never read (`service.ts:168`).
  - Every step writes `audit_log`, which is append-only (migration 0014) and shown to every
    visitor on `/audit`.
  - Retention: at expiry or publication, staged cells and every text quoting them are deleted; the
    profile, mappings, dry-run summaries and one result row per source row stay as the accountable
    record (`0013:6-9`, `service.ts:102-138`).
  - Result rows keep `external_id`; `raw_event_id` is set only at publication. Nothing records
    which ledger record a row was compared with.
  - Result wording says rows were "counted" before anything is published
    (`app/onboarding/[id]/page.tsx:132-152`).
- **Freshness** (`components/ShellStatus.tsx:13-33`, `lib/metrics/scorecard.ts:450-482`):
  - "Data as of" is the earliest, across streams, of each stream's last succeeded `ingestion_runs`
    finish. The indicator is hidden below the `md` breakpoint.
  - CRM sync jobs ingest with `runId: null` (`lib/jobs/sync.ts:520`) and write no
    `ingestion_runs` row, so a succeeded sync never moves it. A publication ingests with
    `runId: null` too (`service.ts:517`).
  - Four readers compute "last success per stream" from `ingestion_runs`: `scorecard.ts:460-482`,
    `lib/decision/verdicts.ts:637-643`, `lib/ai/tools.ts:548-551`, `app/api/health/route.ts:12`.
- **Controls** (`components/ui.tsx`, `components/actions/`):
  - `ButtonLink` has variants and no sizes. There is no `<button>` primitive; files style their own
    buttons, with heights from 28 to 40 px.
  - `useAction` (`components/actions/useAction.ts`) already runs one request: busy label, the
    server's message, `outcome: "failed"` shown as a failure, and a refresh. `Working` and an
    always-mounted status region live in `ProposalControls.tsx:8-15, 144-149`.
  - Design rule 13 (`docs/design-system.md:119-124`) keeps a busy button focusable with
    `aria-disabled` and ignores a second press in code.
- **Chart** (`components/overview/MovementChart.tsx`): channel and week buttons select by keyboard
  and touch; a data table holds the exact values; the selection is restored from the URL after
  Back (`MovementChart.tsx:66-93`). Points respond to pointer only. Back is untested, and focus is
  not restored.
- **Drawers:** `FindingsView` and `JourneyTimeline` lack a focus trap and scroll lock;
  `EvidenceDrawer` has both.
- **CI:** seven Playwright specs fail on GitHub's Linux runner on `main` (`1814616`). Six wait 5 s
  for text that still reads "Loading…" (slow server rendering on two vCPUs); one is CLS 0.156 on
  `/decisions?branch=B09`. A Docker mirror of the runner reproduces them
  (`docs/agent-work/release/harness/linux-ci-repro.sh`; WP-I).
- **Hosting:**
  - Vercel project `revenue-signal-os` serves `1814616`. One `DATABASE_URL` record, marked
    sensitive, covers Production and Preview; the CLI cannot read it back.
  - In this CLI version (66.1.0), `vercel env rm` refuses to run without a person's approval, while
    `vercel env add` and `vercel env update --yes` run; `env update` changes the whole record
    (Production and Preview together). Checked 2026-11-18 on a probe variable, `RSO_ENV_PROBE`,
    which stays until a person removes it.
  - Neon project `revenue-signal` (free plan: 1 GB storage and 10 branches per project) uses
    185 MB. Its data was loaded from a seed before the hold hardening, so its stored incidents
    carry the old rules' evidence, and it is on migration 0034.
- **Already in the working tree, uncommitted:** the hold hardening and migration 0036 (this
  session); a Decision Lab layout-shift fix (`app/decisions/page.tsx`) and a B03 baseline fix
  (`lib/decision/scenario.ts`, `tests/integration/scenario.test.ts`) from another session. The B03
  fix makes Decision Lab's observed baseline equal the scorecard's; checked on the seeded data,
  October is $227.42 over 50 paid customers in both, September $253.83 over 51 in both. WP-0
  verifies and commits all of them.

## 4. Baseline and targets

Measured 2026-11-18 with the method in §10 on build `QqL3Kc7yocI0X4uYh3RQT`: `c445311` plus the
hold hardening, without the other session's Decision Lab layout-shift fix and B03 fix. Data
reseeded before the run. Results: `docs/agent-work/release/measurements/before.json`.

| Page | Cold verdict | Warm verdict (median of 3) | CLS | Phone (390 × 844): verdict top / next action top |
|---|---|---|---|---|
| Overview `/` | 3,054 ms | 1,925 ms | 0.003 | 318 px / 434 px: **first screen** |
| Decision Lab B20 | 925 ms | 906 ms | 0.003 | 654 px / 850 px: **not first screen** |
| Decision Lab B09 | 913 ms | 905 ms | 0.003 | 654 px / 890 px: **not first screen** |

| Upload: sample click → result counts | First of 3 | Median of 3 | CLS | Phone: result card top |
|---|---|---|---|---|
| Marketing analyst, server already warm from the page runs | 1,166 ms | 1,311 ms | 0 | 4,216 px: **not first screen** |

The first draft reported the Overview's action at 2,695 px. That measurement used the wrong
selector (the first link in the holds list); the headline's own next action sits at 434 px. The
harness was corrected before any layout change.

**Where the Overview's time goes** (slow-query log, one load): the scorecard query runs four
times (1.3–1.6 s each, concurrently), and the holds, paid-leads, evidence-holds and weekly-series
queries twice each. Cause, proved: every document request also runs a request-time prerender of
the route (the session App Shell that `cacheComponents` with `partialPrefetching` builds for a
route that reads cookies). Next cannot see `pg` queries, so the prerender runs every read and
discards the results, and the dynamic render runs them again. With `await connection()` in
`getViewer()`, an experiment on the build mirror, the holds query ran once per load and the
document time fell from 1.8–2.0 s to 1.4–1.6 s warm (`measurements/steps.md`). The remaining
scorecard pair is October and September: different arguments, both used.

**Targets, same method and data:**
- Overview: warm verdict ≤ 1,000 ms; cold ≤ 1,500 ms.
- Decision Lab: verdict and next action on the phone's first screen; cold and warm verdicts no more
  than 10% above baseline (run-to-run noise on this machine is about ±5%).
- Upload: the result card on the phone's first screen after the dry run; first and median times no
  more than 10% above baseline.
- CLS below 0.1 on every measured page; no sideways scroll at 320 px.
- Preview deployment: Overview warm verdict ≤ 1,500 ms (§10 defines it), recorded beside the local
  numbers.
- Not targeted, recorded: the first request after the hosted database has been idle. Neon's free
  compute suspends after 5 minutes without queries and resumes on the next one; that wait is
  outside the app (§8).

## 5. Design

### 5.1 Who may do what

**How a request gets its viewer**, in order (`getViewer()`; it only reads cookies):

1. **Demo mode on** (development, tests, or `DEMO_MODE=1`): the role named by the `rs_role` cookie;
   none or unknown → the guest. **Demo mode off** (the hosted demo): the guest.
2. **If the result is the guest and `PUBLIC_WORKSPACE=1`:** the workspace guest, a new object per
   request: `{ ...VIEWERS.guest, subject, can: { ...NONE, workspace: true } }`. Its `subject` is
   the owner (`visitor:` followed by the 64-character hex SHA-256 of the `rs_visitor` cookie's
   token), or `demo:guest` when there is no valid cookie. `demo:guest` owns nothing and is never
   stored: a handler that starts an item first creates the token (below).
3. **Otherwise** the role as resolved. Staff roles never get `workspace`, and the flag changes
   nothing for them.

| Deployment | `DEMO_MODE` | `PUBLIC_WORKSPACE` | Who can be who |
|---|---|---|---|
| Hosted demo (Production, Preview deployment) | unset | 1 | Workspace guest only |
| Local demo, interview recording | 1 | unset | Role picker; guest read-only |
| Browser tests (e2e) | 1 | 1 | Role picker; the guest has a workspace |
| Any other install | unset | unset | Read-only guest |

**What a workspace guest may read,** stated once: every demo page read-only; its own workspace;
company investigations, read-only (the hosted seed creates none, so there the list holds only the
visitor's own). It reads no company upload, company mapping or approved hint, and staff roles read
no workspace item.

**Two new rules,** and no staff permission changes:

1. **A workspace item is not a write to shared data.** A guest's upload (with its rows, mapping,
   dry run and row results) and investigation (with its steps) are stored only under that guest's
   owner, readable only by it, deleted 24 hours after they start (the clocks table in §5.2), never written
   to `audit_log`, never approved, published or executed.
2. **The workspace exists only when the deployment asks for it** (`PUBLIC_WORKSPACE=1`). Default
   off, so an install never takes anonymous files by accident.

| Actor | Reads | Writes | Never |
|---|---|---|---|
| Workspace guest | Every demo page, read-only; its own workspace | Its own workspace only: `onboarding_uploads`, `onboarding_rows`, `onboarding_mappings`, `onboarding_dry_runs`, `onboarding_row_results`, `workspace_investigations`, `workspace_investigation_steps`; and the counters in `workspace_quota` | Approve, publish, replay, sync, decide, run a model, any ledger table, `audit_log`, another visitor's workspace, any company upload or investigation it was not shown read-only |
| Guest without a workspace | Every demo page, read-only | Nothing | Everything above |
| Marketing analyst, integration engineer | As today | As today: propose mappings, dry-run, investigate (with a model when one is configured: an Anthropic key, or the local Ollama provider) | Approve their own proposal |
| Revenue ops approver | As today | Approve a mapping another role proposed; publish calls and web leads | Publish compare-only files; approve its own |
| Branch partner, brand marketing lead | Their branches | As today | Onboarding (an export spans branches) |

Both directions of the read rule are tested (WP-D).

**Ownership is stored once, on the parent.** `onboarding_uploads.workspace_owner` and
`onboarding_mappings.workspace_owner` hold the owner exactly (`visitor:<64 hex>`). Child rows
(`onboarding_rows`, `onboarding_dry_runs`, `onboarding_row_results`) carry no owner: they are
reached only through their parent's id, and the parent is resolved through the owner check first
(`lib/onboarding/access.ts`). No query reads a child table by anything but a parent id that has
passed that check.

**Workspace investigations have their own tables,** `workspace_investigations` and
`workspace_investigation_steps` (migration 0037), with the owner and start time on the parent.
Every build since migration 0008 lists `investigations` to any guest, so an older build meeting an
owner column there would show visitors' questions to everyone; separate tables fail closed,
because no older build reads them. Workspace uploads can share the onboarding tables: every build
since 0013 refuses onboarding to the guest, so an older build fails closed there too.

**The cookie.** Only the two handlers that start a workspace item, `POST /api/onboarding/uploads`
and `POST /api/investigations`, may set `rs_visitor`: a random 32-byte token, `HttpOnly`,
`SameSite=Lax`, `Secure` on every HTTPS deployment, `Path=/`. With no valid cookie, the handler
creates a token, stores the item under its owner and sets the cookie in the same response. Every
later start re-sends the same token with `Max-Age=86400`, so the cookie always outlives the newest
item. Server components never set cookies.

### 5.2 The visitor workspace

**Clocks, per kind of item:**

| Item | Created (shown to the visitor) | Expires | Trigger | Removed | Kept |
|---|---|---|---|---|---|
| Company upload (staff) | `uploaded_at`, business clock | `expires_at` = +24 h, business clock (unchanged) | The existing purge, on every onboarding request and in the worker | Staged cells and quoted text | Profile, mappings, dry-run summaries, one disposition per row (unchanged) |
| Workspace upload | `workspace_started_at`, database `now()` | +24 h, wall clock | Unreadable from expiry (every read checks the time); deleted by `deleteExpiredWorkspace()` at the start of every onboarding and investigator request, and by a daily Vercel Cron call to `GET /api/workspace/cleanup` | Everything: the upload, its rows, mappings, dry runs, row results | Nothing |
| Workspace investigation | `workspace_started_at`, database `now()` | +24 h, wall clock | The same | The investigation and its steps | Nothing |

`stageUpload({ now })` keeps receiving the business clock for business fields (`uploaded_at`,
`expires_at`, dry-run times), so a workspace upload's data reads like the rest of the demo. The
wall-clock column comes from the database's `now()` inside the insert, never from the client.
Pages show the workspace's own lifecycle from `workspace_started_at`, with absolute UTC dates:
"Started Nov 18, 3:41 PM UTC · available until Nov 19, 3:41 PM UTC, then deleted within a day"
(the budget can remove it earlier). Business dates are shown as they are today, on the business
clock.

So an expired item can no longer be opened, and its rows leave the tables within a day of expiry
(the daily cleanup bounds it when the demo is quiet). Deleted rows then remain in Neon's restore
history for the plan's restore window, which WP-J reads from the project's Backup & Restore page
and `/onboarding` states. The business-clock purge (`purgeExpired`) skips workspace uploads
(`workspace_owner is null`), so a script that moves `app_clock` locally cannot expire them a second
way. `GET /api/workspace/cleanup` is public and idempotent: it deletes only what has already
expired, so it needs no secret.

**Workspace uploads** use the same service functions, tables and screens as company uploads, with
these differences, all enforced in `lib/onboarding/service.ts` through `lib/onboarding/access.ts`:

- **Resolution.** A workspace guest resolves only uploads whose `workspace_owner` equals its
  subject. Anything else (another visitor's id, an expired item, a company upload) answers 404 with
  one message: "This workspace item is not available. Items last 24 hours, and the oldest may be
  removed when the demo is full. Upload the file again." A staff viewer resolves only uploads with
  no owner; a workspace id answers 404.
- **No approved hint.** `stageUpload` passes no approved company mapping to the assistant for a
  workspace upload; its suggestions come from the file alone.
- **Mappings belong to their upload.** A mapping drafted on a workspace upload carries its owner.
  - Reuse, listing, "latest" and the dry-run lookup use `drafted_on_upload = <this upload>` for
    workspace uploads. Every layout-wide query (company listing, reuse, the approved hint, supersede
    on approval) adds `workspace_owner is null`.
  - Version numbers stay in the one per-layout sequence, so the unique constraint
    `(dataset, layout_fingerprint, version)` is untouched; a workspace upload shows its own ordinal
    ("Mapping 2 of this upload"), never the global number.
  - A dry run uses a mapping only if both agree: a workspace upload's mapping must be drafted on it;
    a company upload's mapping must have no owner. Otherwise 404.
  - `decideMapping` refuses a workspace mapping (409, "A workspace mapping cannot be approved").
- **Repeat detection** (workspace uploads only). Before staging, the same `file_sha256` from the
  same owner is looked up among its live uploads. If one exists, nothing is staged: the response is
  200 with `repeatOf`, and `UploadForm` opens that upload with `?repeat=1`, where the page says "You
  uploaded this exact file on Nov 18 at 3:41 PM UTC. Its result is below." An expired or deleted
  upload is gone, so the file stages again (a real retry). Company uploads keep today's behaviour:
  a re-upload stages a new upload, and publishing the same rows again adds nothing, because every
  row dry-runs to "matches ledger" (`onboarding-publish-once.test.ts` proves it).
- **One result per upload.** A new dry run of a workspace upload replaces the previous one in the
  same transaction. An upload may hold at most 10 mappings ("This upload has reached the 10-version
  limit. Delete it, then upload the file again." with "Delete it now" beside it).
- **Delete now.** The visitor can delete an item at once ("Delete it now"); everything goes.
- **No shared audit entries.** Workspace items change no shared data, and `/audit` is public on the
  demo, so they are not written to `audit_log`. Each item carries its own dated steps until it is
  deleted.
- **Words.** The result names the mode, and nothing says a visitor's rows were booked, counted or
  added:
  > Comparison workspace on the public demo. Nothing was added to the ledger. Files are counted
  > only in the [local demo](README link), after a second person approves the mapping and
  > publishes; ad-spend and payment files are compared, never counted. This upload and its file are
  > available until Nov 19, 3:41 PM UTC and deleted within a day after (sooner if the demo is
  > full). [Delete it now]

  The availability sentence is generated from `WORKSPACE` and used everywhere a workspace item's
  lifetime is stated.

  The disposition "eligible" reads "Would count after staff approval (local demo only)" on a
  workspace upload and "Would count after approval" on an unpublished company upload, for calls and
  web leads; for spend and payments it reads "New to the ledger (compare-only)".

**Workspace investigations.** A workspace guest may ask the investigator. It always runs the
deterministic evidence path (no model, whatever keys exist), and the investigation is stored in
`workspace_investigations` with its owner and start time, its steps in
`workspace_investigation_steps`. It resolves only for its owner (404 otherwise), is deleted after
24 hours with its steps, and is not audited. The guest's investigator list shows the
demo's stored company investigations (read-only examples) and its own items; never another
visitor's. `can.investigate` is not granted to the guest, so inquiries, notes, experiments,
scenarios and checks against other systems stay closed.

**Limits and quotas.** Every value lives in `WORKSPACE` (`lib/workspace.ts`), which the
`/onboarding` page reads too. Counters live in `workspace_quota` (migration 0037), one row per
(kind, minute) and per (kind, day), incremented before any work, refusals included, and never
decreased when items are deleted. One advisory lock serialises the budget check and the insert.
"Full" means the storage budget; "at capacity" means a rate limit.

| Limit | Value | When reached |
|---|---|---|
| Bytes per workspace file | 4 MB, checked in the browser from the file's size before sending, and on the server (Vercel refuses bodies over 4.5 MB with its own 413, which the form shows as this same refusal) | Refused (413): "This file is 4.6 MB; the public demo takes files up to 4 MB." |
| Rows per workspace file | 10,000 (staff keep 50,000), checked on the parsed table; the parser's own 50,000-row bound caps the work, and a 4 MB file parses in well under a second | Refused (422): "The public demo takes files up to 10,000 rows; this file has 12,345. Upload one month at a time, or run the local demo for files up to 50,000 rows." ("more than 50,000" when the parser stopped at its bound) |
| Mapping versions per workspace upload | 10 | Refused (409): "This upload has reached the 10-version limit. Delete it, then upload the file again." |
| Rows held by all workspace uploads | 100,000, counting each upload as twice its rows (its staged rows plus its one set of results) | At staging, the oldest uploads that are more than 30 minutes old are deleted to make room; if none is old enough, refused (503): "The public demo is full right now. Try again in a few minutes." |
| Rows written by staging and dry runs, all visitors | 50,000 a minute, 500,000 a day; the built-in sample is exempt | Refused (429): "The public demo is at capacity. Try again in a minute." The daily limit says "The public demo has handled its share of files for today; the built-in sample still works. Try again after midnight UTC." |
| Uploads started, all visitors | 30 a minute | Refused (429): "The public demo is at capacity for uploads. Try again in a minute." |
| Investigations started, all visitors | 30 a minute | Refused (429): "The public demo is at capacity for questions. Try again in a minute." |
| Columns, cell size, XLSX bombs, encoding | The existing `LIMITS` | Refused (422) with the parser's reason |

A refusal writes nothing but its quota count: no `audit_log` row, no upload row. The row counter
covers every row a visitor's file makes the database write, dry runs included, so 500,000 a day is
a true bound; the sample's 12 rows are exempt so that "Try the sample" keeps working for a cold
reviewer after a flood. There are no per-visitor caps: a script can drop its cookie, so they would
not protect anything. The 30-minute residency keeps a flood from evicting a reviewer's item
mid-review. Held rows stay under about 30 MB; with the release database's full copy (185 MB) beside
Neon branch `main` (185 MB) for seven days, the project stays near 400 MB of its 1 GB. Compute is
not capped directly: Neon bills compute while the database is awake, and even a refusal is a write,
so a sustained flood costs compute (accepted; §8). WP-D floods the rehearsal database (35 uploads a
minute for 3 minutes, each a different 10,000-row file) and records refusals, table sizes and WAL
growth.

**Threat model:**

| Threat | Answer |
|---|---|
| A visitor reads another's file or result | The owner, from an `HttpOnly` cookie, checked on the parent before any read, with expiry; 404 for any mismatch, indistinguishable from expiry |
| An older build shows workspace items | Workspace investigations live in tables no older build reads; every older build refuses onboarding to the guest. Rehearsal step 3 seeds workspace items and asserts the previous build shows none |
| A visitor's mapping leaks into another's editor | Workspace mappings are keyed to their upload; layout-wide queries exclude them |
| A visitor changes shared figures | No ledger table, `audit_log`, company upload or company investigation is written by a workspace item; tested by row counts and by the Overview's figures and data times before and after (WP-D) |
| Storage exhaustion on the free database | Whole-item deletion within a day of expiry, one result per upload, the 100,000-row budget, minute and daily caps on rows written |
| A flood of uploads or questions | Counted before any work: 30 starts a minute per kind and the row caps; a refusal stores only its count; the 30-minute residency protects items in use; the sample stays available |
| A malicious file | The existing parser limits: XLSX bombs, cell size, encoding, header size |
| Cross-site writes | The upload API takes raw bytes with `content-type: application/octet-stream`, and the cookie is `SameSite=Lax`; no route accepts a form post (`proxy.ts` refuses cross-site API writes) |
| Uploaded rows reach a model | No model reads onboarding tables (`lib/ai` has no onboarding query; a unit test keeps it so), the mapping assistant is deterministic, and workspace investigations never run a model |

### 5.3 Upload to ledger: the data flow

**Before the upload,** `/onboarding` states, generated from `lib/onboarding/targets.ts`,
`lib/onboarding/limits.ts` and `lib/workspace.ts` so it cannot drift:
- the formats (CSV, XLSX, JSON), size and row limits, and the encodings read;
- per export: the required and optional columns, the date forms it reads, the currency rule (US
  dollars only; another currency is refused, never converted), and the effect (counted after
  approval, or compare-only);
- what happens to the file: profiled on the server, compared with the ledger, never sent to a
  model; available for 24 hours and deleted within a day after (workspace), or its rows deleted at
  expiry or publication (staff).

**1. Stage.** `UploadForm` checks the file's size against the limit for this viewer (4 MB for the
workspace) and then sends the chosen file, or `public/samples/demo-calls.csv`, to
`POST /api/onboarding/uploads` as raw bytes with `x-filename`; a response that is not JSON (Vercel's
own 413) is shown as the size refusal. The route sets or refreshes the visitor cookie for a
workspace guest (§5.1). `stageWorkspaceUpload` counts the start against the quotas, runs repeat
detection, then `parseUpload` (format, encoding, delimiter) and the row limit for this viewer on the
parsed table, then `profileTable`, makes room within the budget under the advisory lock, and writes
the upload and its rows.

**2. Map.** `/onboarding/[id]` shows the profile and the suggested mapping. The person answers what
the file cannot say (date order, local time), then saves a mapping version (`proposeMapping`).

**3. Dry run.** `runDryRun` compiles every row with the deployed mapper and compares it with the
ledger (`compareWithLedger`). Each row gets one disposition: eligible, invalid, quarantined,
duplicate in file, conflict in file, matches ledger, differs from ledger. New: for a row that
matches or differs, the comparison also returns the ledger record it was compared with, stored as
`ledger_target jsonb` on `onboarding_row_results` (migration 0037):

```ts
type LedgerTarget =
  | { kind: "lead"; leadId: number; branchId: string | null; journey: string | null } // "<crm customer id>" or "P-<identity id>"
  | { kind: "payment"; branchId: string | null; journey: string }                    // "<crm customer id>"
  | { kind: "spend_day"; branchId: string | null; channel: string; day: string };
```

How each is found, in the same comparison query that already reads the ledger row:
- **lead** (calls, web leads): the lead by `(source, source_lead_id)`, then its live identity through
  `identity_links` (`record_table = 'leads'`, `record_id = leads.id`) and `identities`
  (`retired_at is null`). `journey` is the identity's `crm_customer_id` for a customer, `P-<id>` for
  a prospect, and null when the lead has no identity yet (then no link).
- **payment**: the payment's customer (`journey`) and its office's branch (`BRANCH_BY_OFFICE`).
- **spend_day**: the campaign's branch from `campaign_branch_map`, the channel and the day.

**4. Result.** After a dry run the result card is the first thing on the page at every width
(profile and mapping move below it, collapsed). It shows one conclusion, the counts (each linking
to its rows), the mode label, the limitation, and one next action. A row with a ledger target links
to its record: a lead or a payment to its journey (`/customers/<journey>`); a spend day to its
branch's trace with `metric=paid_spend`, the channel and the week's Monday, in the calendar month
(`sep` or `oct`) that contains the day, or `period=all` without a week when neither does
(`/branches/<branch>/trace?period=oct&metric=paid_spend&channel=…&week=…#selection`). A link appears
only when `canSeeBranch(viewer, target.branchId)` holds.

**5. Count** (staff only, unchanged rules): an approver approves the exact rules the dry run used;
`publishUpload` re-compiles, re-compares and ingests only rows still new. A second publish answers
409; a re-upload of a published file stages a new upload whose rows all dry-run to "matches
ledger", so publishing it adds nothing; a different file holding the same rows behaves the same.

New: the published card stops claiming that reconciliation already ran. The publish route starts
identity resolution and reconciliation right after it responds when it published rows
(`afterResponse`, `app/api/onboarding/uploads/[id]/publish/route.ts`). So the card says "Identity
resolution and reconciliation run right after publication; Audit & Health shows their last runs,"
with the link, when rows were published, and "Nothing new was added, so there was nothing to
reconcile" when none were.

**Retry feedback.** Every refusal names the limit, the file's own value and what to do next (§5.2).
A dry run that cannot run names each incomplete field, and the page keeps the person's answers. A
repeat opens the earlier result. A 409 or a dropped connection refreshes the page so it shows what
the server stored (§5.5).

### 5.4 Data times

The header keeps one time; `/audit` shows four, each read from what is persisted:

| Time | Read from | Moves when | Never moves for |
|---|---|---|---|
| **Data as of** (header and `/audit`; `freshness()`, unchanged) | The earliest, across streams, of each stream's last succeeded `ingestion_runs.finished_at` | The stream that is currently oldest succeeds again | Workspace items, refused or repeated files, queued, running or failed jobs, compare-only files, publications |
| **Synthetic snapshot** (`dataTimes()`) | `app_clock.now` | A reseed or reload | Anything a visitor, a role or a job does |
| **Last successful source sync** (`dataTimes()`) | The later of the latest succeeded `ingestion_runs.finished_at` (a polling run, business clock) and the latest `sync_jobs.finished_at` with state `succeeded` (a CRM sync job, wall clock), shown with its source, entity and office and the clock it is on | A polling run succeeds, or a CRM sync job ends succeeded | Queued, running, failed or cancelled jobs |
| **Last counted import** (`dataTimes()`) | The latest `onboarding_publications.published_at` whose stored result shows at least one new raw event (`(stats -> 'stats' ->> 'inserted')::int > 0`) | A publication adds a record | Workspace items, dry runs, publications that added nothing |

The sync write path, `freshness()` and the four readers listed in §3 stay as they are. A CRM sync
job covers one office, so writing it into the company-wide stream (`crm.<entity>`) would let one
office's sync stand for all 44 branches; it appears as the last successful source sync instead,
named with its office. Polling-run times are on the business clock, sync-job times on the wall
clock, and each is labelled with its own.

**Expected values on the hosted demo** (frozen clock): Data as of Oct 31, 2026 8:00 AM UTC;
synthetic snapshot Oct 31, 2026 1:00 PM UTC; last successful source sync Oct 31, 2026 8:00 AM UTC;
last counted import "none". None of them changes while the release database is live.

The header link keeps its text and gains all four in its accessible name. Below `md`, where the
header hides the indicator, `/audit` is one tap away under "Audit & Health".

### 5.5 Controls

The reference is the light-mode Settings page of `abderrahimghazali/shadcn-fintech` and its
`src/components/ui` (read-only clone, remote verified): buttons 32 px regular and 28 px compact,
16 px icons, an 8 px radius, solid, outline and ghost, a 1 px press, disabled at 50%, an enlarged
invisible hit area. Only these are copied; the product keeps its own focus ring (2 px accent
outline, offset 2), which already passes the contrast tests.

- **One button primitive.** `buttonClass({ variant, size })` in `components/ui.tsx`, used by a new
  `Button` (`<button>`) and the existing `ButtonLink`.
  - Variant names stay `primary` (solid accent: the one main action), `secondary` (outline),
    `ghost` (toolbar) and `danger` (outline, red words: reject, delete). No call site renames.
  - Sizes: `md` 32 px (desktop default), `sm` 28 px (dense rows and toolbars). On coarse pointers
    an invisible pseudo-element extends the hit area to at least 44 × 44 px; the visual size stays.
  - States: hover one step darker; pressed 1 px down; focus the global accent ring (kept); disabled
    50% with a reason in words beside it; busy per rule 13.
- **One request hook.** `useAction` stays the one request hook for action buttons (the upload
  form keeps its own request state). It gains:
  - the busy state shown by `Working` (moved to `components/ui.tsx`): spinner and working words, the
    button keeping its width and focus, `aria-disabled`, a second press ignored;
  - success only after the server answers 2xx and `outcome` is not `"failed"`; the success words
    show until the refreshed page replaces them;
  - error: the server's message in the always-mounted status region, the button back to default;
  - a 409 is always an error, shown in the server's words (for example "This upload is published"
    or "A newer dry run replaced the one you reviewed"), and the page refreshes so it shows the
    stored state behind the conflict;
  - a dropped connection (no response) refreshes the page too, with the words "The connection
    dropped. The page now shows what the server stored." Nothing is ever shown as a success without
    a 2xx.

  Buttons that send a request with no busy state (about a dozen, listed by the silent-button audit,
  WP-A step 5) move onto `useAction` or the upload form's own request state; there is no second
  request component.
- **At most one main action per decision state.** On the cold reviewer's routes (★ in §6) a page
  shows at most one `primary` action for its current state, and none when the viewer cannot act;
  every other action is `secondary` or `ghost`. The test asserts at most one, and exactly one for a
  role that can act.
- **Segmented controls** stay links with `aria-current`, so the URL holds the state and refresh and
  Back work. The track becomes 32 px; the current item stays dark (`bg-text text-white`). Switching
  period or brand keeps `branch`, `channel` and `week` where they still apply.
- **No switch is added:** no current control is an on/off preference. The sidebar collapse is a
  disclosure: `aria-expanded` with a constant name, "Navigation sidebar".

### 5.6 Shell: command menu and drawers

- **Command menu** (`components/CommandMenu.tsx`): checked by keyboard (Ctrl+K, arrows, Enter,
  Escape) and touch (the header's search button). After a result opens, focus lands on the new
  page's `h1`; Escape returns focus to what opened the menu. Fixed only where the check fails.
- **Drawers:** one `Drawer` component, extracted from `EvidenceDrawer`, with a focus trap, Escape,
  scroll lock, focus return and `role="dialog" aria-modal="true"`. `FindingsView` and
  `JourneyTimeline` use it.

### 5.7 Overview chart: select, then open; Back restores

Selecting and opening stay separate, as the chart already does:

- **Select** (no navigation): a pointer hover shows the point's tooltip; a click or tap on a point,
  a channel button or a week button selects it. The selection panel shows the same facts in the
  same words for every input: value and unit, the week's dates, the scope (brand or branch), and
  the cell's state. `history.replaceState` records `branch`, `channel` and `week`.
- **Open:** with a branch chosen, the panel's one link, "Open evidence", opens that branch's trace
  for the channel and week (`/branches/[id]/trace?…&channel=…&week=…`). With no branch chosen the
  chart shows company totals, which have no single record trail, and the panel asks the reader to
  choose a branch instead of offering the link (as today). Before it navigates, the link stores its
  own id under the current URL in `sessionStorage`.
- **Back** returns to the same URL; the server restores filters and selection from it, and on mount
  the chart moves focus back to the stored control, then forgets it.
- Points are not tab stops: the channel and week buttons (one roving group per row) are the
  keyboard path, and the data table holds exact values. A point's tooltip text equals the panel's
  sentence for that point.
- Cell states stay the chart's own: recorded, partial, zero (recorded $0.00), missing (a gap with
  "no record"), not delivered. The chart plots spend per week; its words never name a metric it
  does not plot.

### 5.8 Five states that look different, and the B20 receipt

| State | Where | How it reads |
|---|---|---|
| **Missing** | Chart, scorecard, trace | No mark or a dashed gap, and the words "no record"; never drawn as zero |
| **Held** | Incident, queue rows, Decision Lab | Amber badge with a lock: "Held", the evidence date, and what lifts it |
| **Zero** | Chart, trace | A solid baseline tick and "$0.00 recorded" |
| **Corrected** | Incident receipt, replay receipt | Green badge with a check: "Corrected", with the before and after figures |
| **Approved** | Proposal and publication receipts | Neutral badge with a signature: "Approved by Revenue ops approver, Oct 31 1:12 PM UTC". Only after an approval action |

`StateBadge` is built on the existing `Badge`, like `StatusBadge` and `SeverityBadge`
(`components/ui.tsx:360-382`). Colours follow the design system: amber and green are data states,
blue stays "you can act here", and every state also has a word.

- **B20.** The fix receipt leads with October: CAC **$490.11 → $271.31**, the same spend
  ($15,193.47) and the same 109 serviced customers, shown together. Paid customers rise 31 → 56: of the 33
  customers whose channel changed, 30 had none and 3 were door-to-door; 25 now count as paid media
  and 8 as organic Business Profile. The replay's own window (Sep 1–Oct 30, $364.75 → $284.06) sits
  below, labelled "Replay window". The receipt (`FixResult.tsx`) reads the execution's stored state
  (`action_executions`, written from `captureState()` in `lib/workflow/snapshot.ts`), which today
  covers the whole demo window. `captureState` gains `month`: the branch's figures for the latest
  calendar month the business clock has reached (`PERIODS.oct` on the seeded data, whose clock is
  Oct 31), computed by the same `branchRows`. Executions stored before this release have no `month`,
  and their receipt shows the window only.

### 5.9 Investigator

| Mode | When | Stored as |
|---|---|---|
| Deterministic evidence path | Default; every workspace investigation; no model configured | `mode = 'deterministic'`, `model` null |
| Anthropic model | `ANTHROPIC_API_KEY` set, staff role | `mode = 'model'`, `model = 'claude-opus-5-5'` |
| Local model | `AI_INVESTIGATOR_PROVIDER=ollama`, staff role | `mode = 'model'`, `model = 'ollama:<model>'` |
| Fallback after a model failed | Any of the classes below | `mode = 'deterministic'`, `model` = the model that was tried, `result.fallback = { class, message }` |

**Which setting wins:** `AI_INVESTIGATOR_MODE=deterministic` first (no model at all), then
`AI_INVESTIGATOR_PROVIDER=ollama`, then `ANTHROPIC_API_KEY`.

- **Through the existing interface.** `ModelClient` stays the one seam. `modelClientFromEnv()`
  returns `{ client, profile }` or null. A profile says which request fields are sent and the time
  budgets:
  - Anthropic: today's request (adaptive thinking, effort, cache control, the fallback beta);
    120 s per investigation.
  - Ollama: the Anthropic SDK with an explicit `apiKey: "ollama"` (so `ANTHROPIC_API_KEY` is never
    sent to it), `baseURL = OLLAMA_BASE_URL` (default `http://localhost:11434`; a host that is not
    loopback is refused), the model `OLLAMA_MODEL` (default
    `qwen3:8b`), the plain Messages endpoint, without thinking, effort, cache control or the
    Anthropic-only model-fallback beta; 45 s per request and 90 s per investigation; no price.
    Ollama 0.40.16 answers Anthropic-format requests at `/v1/messages` (checked 2026-11-18).
- **Fallback covers every failure, and hides no defect.** Any failure of the model path returns
  the deterministic answer with a classified reason: no credentials, unreachable, timeout, rate
  limited, authentication, bad request, invalid output, no verified statement left after
  grounding, or other. A response without `usage` counts zero tokens. The class "other" (anything
  not recognised, a `TypeError` included) is logged with its stack trace, and the fallback tests
  and `npm run eval:ai` fail when it occurs, so a code defect cannot pass as a quiet deterministic
  answer.
- **Words on the page,** from the existing `MODE_LABEL` and `fallbackModeLabel` in
  `lib/ai/contract.ts`, reworded: "Answered by the deterministic evidence path (no model)",
  "Answered by claude-opus-5-5", "Answered by qwen3:8b on this machine (Ollama)"; after a fallback,
  "The local model timed out after 45 s, so this answer came from the deterministic evidence
  path."
- **Never writes.** Tools are read-only; proposals are drafts a person dry-runs and another role
  approves. Workspace investigations never run a model.
- **Hosted inference:** none. No free, existing setup was found in the repo or the hosted project.

### 5.10 Performance

Order, each step measured before the next (method §10; results in `measurements/steps.md`). The
targets in §4 are goals: the release reports the measured numbers either way, and only a regression
(Decision Lab or the upload more than 10% slower, or CLS at 0.1 or more) blocks it.

1. **No reads in the request-time prerender.** `await connection()` in `getViewer()`, right after
   `cookies()`: a prerender stops there, before any read; the dynamic render passes at once. Any
   component that reads data before calling `getViewer()` is listed and given its own
   `await connection()`. Then React `cache()` for any identical call left in one render.
2. **The verdict waits only for what it reads.** Trace which queries gate the Overview's verdict
   (`headline-answer`): today it waits for every read in one `Promise.all`, including the weekly
   series and brand rows it does not show. Reads the verdict does not use move into their own
   `Suspense` sections, and the estimate after the change is written down before step 3.
3. **The top query's plan.** The scorecard's `period_acq` works out every customer's first
   subscription and initial appointment before keeping the period (`steps.md`, step 2 diagnosis).
   First make each "first" ordering total (adding the row id as the last key), which the seeded
   data shows changes nothing; then filter by the period first and work in sets. The result must
   equal the old query's for every branch and period on the seeded data, and on new fixtures with
   ties in `sold_at` and `scheduled_for` and with subscriptions that span periods.
4. **Phones.** Decision Lab puts its next action directly under the verdict (WP-E); the upload
   result leads after a dry run (WP-D). Nothing is hidden.
### 5.11 Hosting, environments and secrets

**Providers:** Vercel Hobby (`revenue-signal-os`, built from `ghantapavan93/Mox-Pes`) and Neon free
Postgres 17 (`revenue-signal`, us-east-1). No paid service.

| Environment | Code | Database | Settings |
|---|---|---|---|
| Production today | `1814616` | Neon branch `main` | `DATABASE_URL` (shared record, Production and Preview) |
| Preview deployment | the release SHA | the release database | git-branch-scoped `DATABASE_URL` and `PUBLIC_WORKSPACE=1` for `feature/audit-enterprise-redesign`, which override the shared records for that branch only |
| Production after promotion | the release SHA | the release database | the shared `DATABASE_URL` record updated to the release database; `PUBLIC_WORKSPACE=1` added for Production at promotion |

Promotion moves the verified code and the verified data together; Neon branch `main` stays
untouched as the rollback. Never set: `DEMO_MODE`, `INGEST_API_KEY`, `ANTHROPIC_API_KEY`.

**Preview deployments are behind Vercel Authentication** (checked 2026-11-18: a deployment URL
redirects to Vercel's sign-in; only the production alias is public). The owner's Chrome is signed
in, so the Preview smoke test and the cold review run there. Playwright contexts are not signed in,
so the two-session journey and the hosted measurements run against the production alias after
promotion, with the rollback ready; before that, the same journey runs locally against a
production-mode server (WP-J step 4). No protection setting or bypass secret is changed or created.

**Run time.** `export const maxDuration = 60` (seconds) on `POST /api/onboarding/uploads`, the
mapping and dry-run routes, and `POST /api/investigations`, inside the Hobby plan's limit. WP-J step
7 confirms on the Preview deployment that a 10,000-row stage plus dry run, and J4, finish well
inside it; a change restarts WP-J step 1.

**Two procedures**, each done by the agent, with the user's Chrome (signed in to Neon) and the
Vercel CLI (signed in); the user does nothing. A database URL is never displayed, read, typed,
printed, written to a file or put on a command line: Neon's Connect dialog masks the password, and
only its copy button is used.

- **Load a database** (only for the release database, in WP-J step 5): in Neon's Connect dialog,
  with connection pooling off (the direct string, which `pg_restore --single-transaction` needs),
  copy the branch's connection string; run `npm run db:load-hosted:clipboard` from the release
  worktree, which seeds a local copy at the release SHA, restores it into that branch in one
  transaction, compares every table's row count, and leaves the verified URL (with its `sslmode`)
  on the clipboard. Use it at once for "set a variable" (Preview deployment), then clear the
  clipboard (`Set-Clipboard -Value $null`).
- **Set a variable** (Preview deployment, promotion, rollback): the URL comes from the loader's
  clipboard, or from Neon's copy button (pooling off, the same form). It is piped to the CLI by
  `npx tsx scripts/clipboard-to-stdout.ts`, which reuses the loader's clipboard reader (moved to
  `scripts/clipboard.ts`) and writes the text with no trailing newline; then the clipboard is
  cleared:
  - Preview deployment: `npx tsx scripts/clipboard-to-stdout.ts | npx vercel env add DATABASE_URL preview feature/audit-enterprise-redesign`
    (a new git-branch record; the shared record is untouched);
  - promotion: `npx tsx scripts/clipboard-to-stdout.ts | npx vercel env update DATABASE_URL --environment production --yes`
    (updates the shared record, so other branches' Preview deployments, which are behind Vercel
    Authentication, also read the release database from then on);
  - rollback of the variable: the same command with Neon branch `main`'s connection string.

  The git-branch variables are set before the release SHA is first pushed, so the first Preview
  deployment already reads the release database. A wrong value shows at once: the Preview
  deployment's `/api/health` would fail.

  `PUBLIC_WORKSPACE` is not secret and is set directly: for the Preview deployment with
  `npx vercel env add PUBLIC_WORKSPACE preview feature/audit-enterprise-redesign` (value `1`), and for
  Production with `npx vercel env add PUBLIC_WORKSPACE production` at promotion, not before. It stays
  after a rollback: `1814616` does not read it.

  `vercel env rm` is never used: it needs a person's approval in this CLI.

**Build identity.** `/api/health` gains `commit` from `VERCEL_GIT_COMMIT_SHA` (the full 40-character
SHA; null locally). Smoke tests compare it with `git rev-parse <release SHA>`; a short SHA is
compared as a prefix.

## 6. Every route: job, first answer, next action

Every route passes the shared gates (`tests/e2e/z-quality-gates.spec.ts`, `z-layout.spec.ts`):
axe at four widths, CLS below 0.1, no sideways scroll at 320 px. Routes marked ★ are the cold
reviewer's path: they also pass the primary-action count (§5.5), 200% zoom (a 720 × 450 CSS-pixel
viewport at device scale factor 2: no lost content, no sideways scroll), keyboard-only operation
and reduced motion
(`tests/e2e/release-journeys.spec.ts`, J1–J4). WP-C step 0 audits every route at 1440 and 390 px
for its first-screen answer and next action (`docs/agent-work/release/route-audit.md`); a route
that fails is fixed in the package that owns it, and the others are left as they are.

| Route | Job (the question it answers) | First-screen answer | Next action | Test |
|---|---|---|---|---|
| ★ `/` | What changed, what is held, and why? | At-risk figure with its hold note | The branch the headline names | `zy-overview-movement`, J1 |
| ★ `/branches/[id]/trace` | Where does this number come from? | Reproduced or discrepancy callout | Open the incident, when one holds | `z-trace`, J1 |
| ★ `/exceptions/[id]` | What was detected, decided, changed? | Verdict, state badge, evidence date | Its one next step for this role | `zz-b09-four-minute-path`, J3 |
| ★ `/decisions` | Can this branch move budget now? | Readiness summary | Open the blocking incident | `os-golden-path`, J3 |
| ★ `/onboarding` | What will my export do? | Upload card and the export table | Try the sample (primary); Choose a file (secondary) | J2 |
| ★ `/onboarding/[id]` | What was read, what would count, why? | Result card (after a dry run) | The step's next action | `z-onboarding`, J2 |
| ★ `/investigator` | Why does a number look wrong? | Ask form, mode named | Investigate | J4 |
| ★ `/investigator/[id]` | What evidence supports the finding? | Conclusion and mode | Open the cited record | J4 |
| `/branches/[id]` | Which step of this branch's path needs investigation? | Budget-signal verdict | Investigate this branch | `z-trace`, `zx-vp-journeys` |
| `/exceptions` | Which cases need a decision? | Counts by state | Open the most urgent case | `os-golden-path` |
| `/decisions/opportunities` | Where is follow-up lost? | Readiness badge | None (read-only) | `os-modules` |
| `/integrations` | Are the feeds healthy? | Feed health tiles | Run sync (engineer) | `os-modules` |
| `/integrations/jobs/[id]` | What did this sync do? | State badge, attempts | Retry, when allowed | `os-modules` |
| `/investigator/inquiries/[id]` | Which CAC hypotheses hold? | Conclusion | Re-test, when allowed | `zx-vp-journeys` |
| `/changes` | Is this configuration change safe? | Form | Check the change | `zzz-changeguard` |
| `/changes/[id]` | What do the eight review questions say? | Status and next action | Approve or release, by role | `zzz-changeguard` |
| `/changes/[id]/checks/[runId]` | Did the post-release check pass? | Outcome | None | `zzzzz-post-release-monitoring` |
| `/assurance` | Does another system's figure match? | Form | Check it | `os-modules` |
| `/assurance/[id]` | Does it match? | Verdict | Open the trace | `os-modules` |
| `/audit` | Is anything broken, and who did what? | Health tiles, data times | Filter | `os-modules` |
| `/customers` | Whose journey explains a number? | Lifecycle tiles | Search | `os-modules` |
| `/customers/[id]` | What is this customer's record trail? | Header and money tiles | Open a record | `os-modules` |
| `/definitions` | What exactly does each number mean? | Index | None | `z-a11y-regressions` |
| `/demo` | The presenter's four-minute path | Ready badge | Start | `demo-video` (skipped unless recording) |
| `/feedback` | Which customers become conversions? | Three groups | None | `os-modules` |

**Restricted stays restricted.** J3 and the role specs assert that a guest or the wrong role sees the
reason and no action, and that a held decision offers no approval.

**The four release journeys** (`tests/e2e/release-journeys.spec.ts`). The suite runs spec files in
name order on one seeded database, and `os-golden-path.spec.ts`, which runs earlier, reseeds and
executes B20's fix; J3 reads that state, so WP-E runs J3 together with it.

| Journey | Routes | Asserts | Owner | Success criteria (§1) |
|---|---|---|---|---|
| J1 Chart to evidence and Back | `/`, `/branches/[id]/trace` | Hover, keyboard and tap show the same facts for a chart point; "Open evidence" opens that channel and week; Back restores filters, selection and focus; also at 390 px with touch and under reduced motion | WP-C | 1, 4 |
| J2 Upload to result, twice | `/onboarding`, `/onboarding/[id]`, a ledger link | Two browser sessions: A uploads an unseen synthetic export, reads the result on the first screen, follows a ledger link and Back, reopens the result; B cannot open A's result and sees unchanged figures and data times; malformed, oversized, repeated and expired files | WP-D | 1, 2, 3, 4 |
| J3 Incident to allowed action to receipt | `/exceptions/[id]`, `/decisions` | As integration engineer on an open incident: the allowed dry run, its busy state, and its receipt ("nothing was saved"); on B20 (fixed earlier in the suite): the stored receipt with Corrected and Approved badges, October first; as guest: the reason and no action; B09's held decision offers no approval | WP-E | 1, 5 |
| J4 Question to cited record | `/investigator`, `/investigator/[id]`, a cited record | A workspace guest asks a question; the answer names the deterministic path and cites records; a cited record opens | WP-F | 1, 4 |

Only J1 and J2 test Back. Shell checks (command menu, drawers) are in
`tests/e2e/release-controls.spec.ts` (WP-A and WP-B), not in a journey.

## 7. Alternatives considered

- **Turn on `DEMO_MODE` for the hosted demo.** Rejected: anyone could approve, publish and execute,
  and the shared data would change for everyone after them.
- **A database per visitor.** Rejected: provisioning time and the free plan's 10-branch limit.
- **Process each upload in one request, store nothing.** Rejected: the workflow asks the person
  questions between steps, and the brief requires reopening a result. The workspace stores the
  minimum, owned and deleted whole at 24 hours.
- **Row-level security for ownership.** Rejected for now: it needs `FORCE ROW LEVEL SECURITY` and a
  per-transaction setting on every read, and several reads are bare `pool.query` calls. One access
  module with tests in both directions is simpler to review.
- **A per-network rate key.** Rejected: it is personal data and throttles shared networks together.
- **A new request component (`ActionButton`).** Rejected: `useAction` already owns the request; it
  gains the missing states instead.
- **Every chart point a tab stop or a link.** Rejected: one stop per channel and week, and a tap
  could not both preview and open.
- **A CI quarantine lane for the seven specs.** Rejected: one of the seven is a real layout shift
  on Decision Lab (CLS 0.156 on Linux); a quarantine would hide it behind a green badge, and §2's CI
  claim would rest on a hidden failure. The brief also asks for root causes.
- **Data times: record CRM sync jobs as `ingestion_runs`.** Rejected: a job covers one office, so a
  run in the company-wide stream would let one office's sync clear staleness for every branch, and
  a run per attempt would mark the stream failed when a retry then succeeds. `dataTimes()` reads
  `sync_jobs` beside the runs instead, and the header's rule is untouched (§5.4).
- **A first-screen cache on the hosted demo.** Deferred: an in-memory cache on serverless
  instances is usually empty when a cold reviewer arrives, and its trigger (the Preview
  deployment's numbers) exists only after the release SHA is fixed. The hosted numbers are
  reported as measured.
- **An owner column on `investigations`.** Rejected: every older build lists that table to any
  guest, so a rollback by redeploy or an older Preview deployment would show visitors' questions.
  Separate workspace tables fail closed (§5.1). **Separate tables for workspace uploads** too:
  rejected, because every older build refuses onboarding to the guest, and parameterising the whole
  onboarding service by table would touch every query in it.
- **Precompute the period's acquisition set at load time.** Considered for the Overview: the hosted
  ledger never changes between loads. Kept in reserve behind §5.10 steps 1–4, because locally every
  write path (replays, publications, syncs) would have to refresh it, and a stale set is the
  product's worst failure.
- **Smoke a production build before it takes the domain** (`vercel deploy --prod --skip-domain`,
  then `vercel promote`). Considered: Production builds from git `main`, which assigns the domain
  itself, and the verified rollback restores the previous deployment in seconds if the smoke test
  fails.
- **Track which reconciliation run covered each publication.** Rejected: only staff on the local
  demo can publish, and the publish route starts reconciliation right after it responds, so an
  honest sentence and the Audit & Health link answer the question (§5.3).
- **A machine-readable code on every 409.** Not needed: every 409 is shown as an error in the
  server's words and refreshes the page (§5.5), so the client never has to tell conflicts apart.
- **Secrets: `vercel env pull` or `vercel env run`.** Impossible: the variable is sensitive, and
  the CLI refuses to read it back. **A Neon API key** for the CLI: rejected, since creating an
  access key needs a person. **Remove and re-add a variable** (`vercel env rm`): rejected, since
  this CLI needs a person's approval for it. The clipboard with `env add` and `env update` needs
  none of these (§5.11).
- **Migrate production in place and keep its data.** Rejected: its stored incidents were built by
  the old hold rules, and nothing on the hosted demo re-runs reconciliation.
- **Reset production with the loader.** Rejected: production would change before its code, and the
  Preview deployment would have been verified on a different load. The release database is
  promoted instead.
- **Turn off `partialPrefetching`.** Rejected: it changes navigation app-wide; `connection()` in
  `getViewer()` removes the doubled reads on its own (§4).

## 8. Risks

Threats from visitors' files and questions are in §5.2's threat model; this table holds the rest.

| Risk | Mitigation |
|---|---|
| A cold reviewer's first request waits while Neon resumes a suspended compute | Recorded, not targeted (§4): the free plan suspends after 5 minutes idle and cannot be kept awake. The smoke test reports "first request after idle" separately, and every page streams its shell before its data, so the wait shows a skeleton, not a blank page |
| The release database drifts from the release SHA | It is loaded from the release SHA's seed, and the smoke test compares `/api/health.commit` and the migration list |
| A secret leaks | The two procedures (§5.11): nothing printed, written or put on a command line; the clipboard cleared |
| The local model gives poor answers | Catch-all fallback; never used on the hosted demo; the page names what answered |
| Linux CI failures outlast the time box | Promotion does not happen, and the blocker is reported |
| An older build or another branch's Preview deployment reads the release database | Workspace investigations are in tables no older build reads; onboarding is refused to the guest in every build; Preview deployments are behind Vercel Authentication. Rehearsal step 3 proves the previous build shows no workspace item |
| A quiet demo keeps an expired file | Unreadable at expiry; the daily cleanup removes it within a day; Neon's restore window is stated on `/onboarding` |
| A flood exhausts the free plans | Starts and rows counted before any work, with minute and daily caps on rows written; refusals store only their count; the sample stays available; compute during a sustained flood is accepted and visible in Neon's usage; WP-D's flood test records the growth |
| A redesign loses state | J1–J4 are release gates; J1 and J2 assert that Back restores filters, selection and focus |
| `connection()` removes content from App Shells that pages relied on | Every page's first screen is checked in the route audit and the quality gates after §5.10 step 1 |

## 9. Migrations, rehearsal and rollback

**Migrations.** Not all additive; each is stated as it is:
- `0035_fictional_brand_names` (committed): rewrites brand names in place. The previous build reads
  them unchanged.
- `0036_spend_branch_from_campaign` (uncommitted, WP-0): adds `raw_event_branch()` and replaces
  `v_quarantine_holds` with the campaign-mapping branch rule; same columns, so the previous build's
  queries still run.
- `0037_workspace_and_ledger_targets` (new, WP-D), additive:
  - `onboarding_uploads`: `workspace_owner text`, `workspace_started_at timestamptz`, a check that
    both are set or both null, indexes `(workspace_owner, id desc)` and `(workspace_started_at)`,
    each `where workspace_owner is not null`;
  - `onboarding_mappings`: `workspace_owner text`, index `(drafted_on_upload)`;
  - `onboarding_row_results`: `ledger_target jsonb`;
  - `workspace_investigations (like investigations including defaults including constraints
    including indexes)`: every column of `investigations`, and its `id` default, so both tables draw
    ids from `investigations_id_seq` and an id never names two investigations; plus
    `workspace_owner text not null`, `workspace_started_at timestamptz not null default now()`, and
    an index on `(workspace_owner, id desc)`;
  - `workspace_investigation_steps (like investigation_steps including defaults including
    constraints including indexes)`, with `investigation_id` referencing
    `workspace_investigations(id) on delete cascade`;
  - `workspace_quota (kind text, bucket text, starts_at timestamptz, items int, rows int,
    primary key (kind, bucket, starts_at))`, kind `upload` or `investigation`, bucket `minute` or
    `day`; rows older than two days are deleted by the cleanup;
  - nothing else: no existing column changes meaning.

`.gitattributes` gains `public/samples/demo-calls.csv -text`, so the sample's bytes, and the hash the
quota exemption compares (`sha256` of the file's base64 text, as `file_sha256` is computed), are
the same on Windows and on Vercel.

**Rehearsal**, exactly what the release runs, never on the demo database:
1. Load: `ALLOW_LOCAL_TARGET=1 HOSTED_DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rehearse npm run db:load-hosted`
   from the release worktree (Terms) into a disposable
   local database `revenue_signal_rehearse`: seed, dump, one-transaction restore, row counts.
2. Run the release build against it in production mode (`next start`, `PUBLIC_WORKSPACE=1`, no
   `DEMO_MODE`): `/api/health` lists 0001–0037; J1, J2 and J4 pass as a guest in two Playwright
   contexts (J3 needs staff roles and runs in the release regression); the flood test runs here.
3. Create workspace items in it (two uploads, two investigations), then run the previous build
   (`1814616`) against it: `/`, `/decisions?branch=B20`, `/exceptions` and `/onboarding` answer 200
   with their verdicts, and `/investigator`, `/api/investigations` and `/onboarding` show none of
   the workspace items. This protects one path: a rollback by redeploying an older commit, which
   builds with the current variables, so after promotion the old code would meet the release
   database. (A `vercel rollback` never does: deployments keep the variables they were built with.)
   It also backs the safe-migrations claim in §2.
4. Record the commands and results in `docs/agent-work/release/rehearsal.md`.

**Rollback:**
- **Before promotion:** nothing in Production changed. The git-branch variables and the Neon
  release branch can stay; they serve only the Preview deployment.
- **After promotion,** two steps:
  1. **Deployment:** `vercel rollback` to the previous production deployment. It runs `1814616`
     against Neon `main`, as before, because deployments keep the variables they were built with.
  2. **Variable and branch:** "set a variable" points the shared `DATABASE_URL` back to Neon branch
     `main`, and a commit restoring `1814616`'s tree is pushed to git `main`
     (`git revert --no-commit 1814616..<release SHA>`, then commit), so the next build matches the
     database it reads. `PUBLIC_WORKSPACE` stays (`1814616` does not read it). The release database
     is kept for seven days.
- **Verified once** (WP-J step 9), step 1 only: roll back; confirm that the production alias serves
  the previous deployment's id (`vercel inspect`), that `/api/health` has no `commit` field and lists
  migrations ending at 0034, and that the Overview answers; then re-alias the release deployment as
  Production (`vercel promote <deployment>`) and re-run the production smoke test. Step 2 is not
  exercised: it is the same `env update` command as promotion, already run once, and running it
  would leave the shared record pointing at `main` while the release is live.

## 10. Benchmark method

- **Harness:** `docs/agent-work/release/harness/measure-cold.sh <builtWorktree> <port> <label>
  <out.json>`: frees the port, reseeds `revenue_signal_measure` (never the demo database), starts
  `next start` with `DEMO_MODE=1`, waits for "Ready", runs `measure.cjs`, stops the server. Before
  and after builds run on the same machine with nothing else heavy running.
- **Pages:** Overview, Decision Lab B20 and B09 (October). Cold: the first load after the server
  starts, in a fresh browser context. Warm: the median of three further fresh contexts. Verdict
  time: from navigation start until the verdict element is visible with settled text (no skeleton,
  no "Loading"). The verdict elements carry `elementtiming` attributes (WP-G), so the browser's own
  Element Timing entry gives the same time wherever the harness cannot drive the page. CLS:
  layout-shift entries without recent input, read 1.5 s after the verdict.
- **First screen:** at 390 × 844, the verdict's top edge is above 844 px and the next action's
  bottom edge is at or above 844 px (the harness records both edges). At 1440 × 900 the same rule
  with 900 px is recorded, not targeted. Next-action selectors are the page's own (`overview-next`,
  the readiness incident link), recorded in the harness.
- **Upload:** as the marketing analyst, the built-in sample from the click to the result counts,
  answering the two questions the file cannot; three desktop runs after the page runs (so the
  server is warm; reported as first and median) and one phone run with the result card's position.
- **Preview deployment:** five loads of each page in the owner's Chrome (the Preview deployment
  is behind Vercel Authentication), the verdict time read from the Element Timing entry after each
  load. Run 1 is reported as "first request after idle" (Neon may have suspended its compute); the
  Preview warm verdict is the median of runs 2–5.
- **Production, after promotion:** `measure.cjs` against the production alias (public), page
  timings only, the same five-run rule; recorded beside the local numbers.
- **200% zoom:** a 720 × 450 CSS-pixel viewport at device scale factor 2, which is what a 1440 × 900
  window shows at 200% browser zoom.
- **Captures:** `captures.cjs`, light mode, 1440 × 900 and 390 × 844, before and after: a focused
  button, a pending action, a selected chart point, and the view that point opens. Side-by-side
  images are composed into `docs/agent-work/release/captures/side-by-side-*.png`.
- **Also checked, after only:** 320 px (no sideways scroll), 200% zoom, keyboard-only J1–J4,
  reduced motion (`prefers-reduced-motion: reduce`: no movement, same information).

## 11. Fixtures and databases

| Fixture | What it is | Used by |
|---|---|---|
| `public/samples/demo-calls.csv` | The built-in sample: 12 calls, one duplicate row, one unmapped branch | J2, measure, captures |
| `tests/fixtures/onboarding/unseen.ts` | `unseenCallsCsv(seed)`: 43 rows — 40 synthetic calls with fresh call ids the ledger has never seen, two rows that match ledger calls, one invalid row; fictional caller numbers; branch names that map to demo branches | The two-session test, J2 |
| Malformed file | 2 KB of random bytes named `calls.csv`, made in the test | J2, `tests/integration/workspace.test.ts` |
| Oversized files | 4 MB + 1 byte (refused 413 in the browser and on the server); 10,001 rows (the workspace row limit) | J2, `tests/integration/workspace.test.ts` |
| Scorecard ties | Customers whose subscriptions share a `sold_at`, appointments sharing a `scheduled_for`, and subscriptions that span September and October, added to a test database | `tests/integration/scorecard-equality.test.ts` (WP-G) |
| Flood | 35 uploads a minute for 3 minutes, each a different 10,000-row file of random calls (about 1.2 MB), from a script | WP-D, against `revenue_signal_rehearse` |
| Repeat | The unseen file uploaded twice by the same visitor | J2, `tests/integration/workspace.test.ts` |
| Expired | The test sets an item's `workspace_started_at` back 25 hours | J2, `tests/integration/workspace.test.ts` |
| Published repeat | A staff publication, then the same file again | `tests/integration/onboarding-publish-once.test.ts` |

| Database | Purpose | Reset by |
|---|---|---|
| `revenue_signal` | The demo and the B20 recording | Never touched by this release |
| `revenue_signal_rc` | Release regression browser runs | Playwright global setup |
| `revenue_signal_test` | Vitest | The test setup |
| `revenue_signal_measure` | Benchmarks | `measure-cold.sh` |
| `revenue_signal_rehearse` | Migration and rollback rehearsal | The loader, with `ALLOW_LOCAL_TARGET=1` |
| `revenue_signal_deploy` | The loader's local copy | The loader |
| Neon `release-2026-11-18` | The release database: the Preview deployment, then Production | "Load a database", once (§5.11) |

## Detailed Implementation Plan

### How the work is done

- **Where.** Code is edited in the repository folder on the git release branch. Builds and test runs
  happen in the build mirror `C:/Temp/rso-release` after
  `bash docs/agent-work/release/harness/sync-mirror.sh C:/Temp/rso-release` (written `harness/` below:
  `docs/agent-work/release/harness/`), never in the folder, whose `.next` is the B20 recording
  build.
- **Done for a package** means: `npm run typecheck`, `npm run lint` and the package's named tests
  pass in the build mirror, and its commits are made (short subject, past-tense first body line, no
  co-author trailer). An existing assertion changes only where this plan lists it, with the reason
  in the commit body.
- **Browser checks per package** run in the build mirror after `npx next build`, against the
  release-candidate database, never the demo's:
  `CI=1 PORT=3989 DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc FIELDROUTES_MOCK_BASE_URL=http://localhost:3989/api/mock/fieldroutes npx playwright test <specs>`
  (with `SKIP_SEED=1` when the database was seeded by an earlier run and nothing since depends on a
  fresh seed). `CI=1` makes Playwright start `next start` itself and never reuse a stray server.
- **Ownership.** The table below gives every file one package. A package that must change a file
  another package owns makes the change in its own commit and names the owner in the commit body;
  WP-0's ownership ended with its commits.
- **Order:** WP-0 → WP-A → WP-B → WP-C step 0 → WP-D → WP-C steps 1–2 → WP-E → WP-G → WP-F →
  WP-H → WP-I → WP-J.

| Package | Needs | Produces |
|---|---|---|
| WP-0 Baseline (done) | — | `138501e` hold hardening and 0036; `3004342` its records; `8c5739c` B03 baseline; `899894c` Decision Lab layout shift |
| WP-A Controls | WP-0 | `buttonClass` with `data-variant`, `Button`, sizes, `Working`, `StateBadge`, the segmented track, the hit-area utility, `useAction` states and methods, the sidebar disclosure, the silent buttons moved, `release-controls.spec.ts` |
| WP-B Data times and shell | WP-A | `dataTimes()`, the `/audit` panel, the command-menu check, `Drawer` |
| WP-C step 0 Route audit | WP-A | `route-audit.md`: each route's first answer and next action at 1440 and 390 px, failures named with their owner |
| WP-D Visitor workspace | WP-A, WP-B step 1, WP-C step 0 | Migration 0037, the workspace viewer and cookie, quotas, cleanup, workspace uploads, ledger targets, the result-first upload page, J2 |
| WP-C steps 1–2 | WP-D | Chart select/open/Back with focus, the Overview's audit fixes, J1 |
| WP-E Incidents and Decision Lab | WP-C step 0 | `StateBadge` in place, the B20 receipt's month, Decision Lab's phone order, J3 |
| WP-G Performance | WP-C, WP-D, WP-E | `connection()` in `getViewer()`, the verdict's own reads, the query fix if needed, Element Timing in the harness |
| WP-F Investigator | WP-D | Model profiles and precedence, fallback classes, workspace investigations, J4 |
| WP-H Build identity | — | `/api/health.commit` |
| WP-I CI on Linux | WP-G, WP-F, WP-H | The seven files and then the full suite green in the CI mirror |
| WP-J Verify and release | all | The release SHA, verified, previewed, promoted; rollback exercised |

### Files

Create (C) or Modify (M). Paths are from the repository root.

| Package | Files |
|---|---|
| WP-A | M `components/ui.tsx`, `components/actions/useAction.ts`, `components/actions/ProposalControls.tsx`, `components/actions/ProposeForm.tsx`, `components/actions/CaseControls.tsx`, `app/globals.css`, `components/SidebarNav.tsx`, `docs/design-system.md`, `tests/e2e/z-layout.spec.ts` (lines 85, 87, 93: `aria-pressed` → `aria-expanded`); M, only those with a request button and no busy state, among the 28 client files that call `fetch(`: `components/CommandMenu.tsx`, `DecisionForm.tsx`, `GuideBar.tsx`, `ReplayPanel.tsx`, `RoleSwitcher.tsx`, `changes/ChangeActions.tsx`, `changes/ChangeForm.tsx`, `changes/RolloutEvaluation.tsx`, `customers/ConflictDecision.tsx`, `customers/JourneyTimeline.tsx`, `decisions/ExperimentRunner.tsx`, `decisions/OverrideForm.tsx`, `decisions/ScenarioBuilder.tsx`, `incidents/DriftDecision.tsx`, `integrations/CurrencyRules.tsx`, `integrations/FaultPanel.tsx`, `integrations/JobActions.tsx`, `integrations/JobsLive.tsx`, `integrations/RecordCompare.tsx`, `integrations/RunSync.tsx`, `investigator/FindingsView.tsx`, `investigator/InquiryActions.tsx`, `investigator/InvestigateForm.tsx`, `investigator/OpenInquiry.tsx`, `onboarding/DecisionPanel.tsx`, `onboarding/MappingEditor.tsx`, `onboarding/UploadForm.tsx`, `shadow/ShadowForm.tsx` (all under `components/`); C `tests/e2e/release-controls.spec.ts` |
| WP-B | M `lib/metrics/scorecard.ts` (`dataTimes`), `components/ShellStatus.tsx`, `app/audit/page.tsx`, `components/CommandMenu.tsx`, `components/incidents/EvidenceDrawer.tsx`, `components/investigator/FindingsView.tsx`, `components/customers/JourneyTimeline.tsx`; C `components/Drawer.tsx`, `tests/integration/data-times.test.ts` |
| WP-C | C `docs/agent-work/release/route-audit.md`, `harness/route-audit.cjs`, `components/useRestoreFocus.ts`, `tests/e2e/release-journeys.spec.ts`; M `app/page.tsx`, `components/overview/MovementChart.tsx`, `components/overview/MovementSection.tsx`, `lib/metrics/movement-copy.ts`; and, where `route-audit.md` fails them, the page file of each route in §6 not listed for WP-D, WP-E or WP-F (each named in the commit that changes it) |
| WP-D | C `database/migrations/0037_workspace_and_ledger_targets.sql`, `lib/workspace.ts`, `lib/onboarding/access.ts`, `app/api/workspace/cleanup/route.ts`, `vercel.json`, `tests/fixtures/onboarding/unseen.ts`, `tests/integration/workspace.test.ts`, `tests/integration/onboarding-publish-once.test.ts`, `harness/flood-workspace.ts`; M `lib/viewer.ts`, `lib/server.ts`, `lib/http.ts` (`readBodyBytes` limit and message), `lib/onboarding/service.ts`, `lib/onboarding/ledger.ts`, `lib/onboarding/limits.ts`, `lib/onboarding/parse.ts`, `lib/onboarding/xlsx.ts`, `app/api/onboarding/uploads/route.ts`, `app/api/onboarding/uploads/[id]/route.ts`, `app/api/onboarding/uploads/[id]/mappings/route.ts`, `app/api/onboarding/uploads/[id]/dry-run/route.ts`, `app/api/onboarding/uploads/[id]/rows/route.ts`, `app/onboarding/page.tsx`, `app/onboarding/[id]/page.tsx`, `components/onboarding/UploadForm.tsx`, `components/onboarding/MappingEditor.tsx`, `components/onboarding/DecisionPanel.tsx`, `.gitattributes`, C `tests/unit/workspace-sample-hash.test.ts`, `playwright.config.ts` (one env line), `tests/e2e/db.ts` (`expireWorkspaceItem`, `seedReplayableIncident`), `tests/e2e/z-onboarding.spec.ts` (line 38: the eligible label; line 73: the guest now sees the workspace form, partner and brand keep 403), `tests/integration/review-regressions.test.ts` (lines 108–111: the permission set gains `workspace: false`), `tests/unit/get-viewer.test.ts` (the workspace guest cases) |
| WP-E | M `lib/workflow/snapshot.ts`, `components/incidents/FixResult.tsx`, `components/incidents/RevisionHold.tsx`, `components/incidents/GapRecovery.tsx`, `components/actions/SnapshotDiff.tsx`, `components/actions/CaseQueue.tsx`, `components/actions/badges.tsx`, `app/exceptions/[id]/page.tsx`, `app/exceptions/page.tsx`, `app/decisions/page.tsx`; C `tests/integration/b20-receipt.test.ts` |
| WP-G | M the `connection()` line in `lib/server.ts` (done, `3087cac`), `components/ShellStatus.tsx` (`FreshnessIndicator` reads data without the viewer, so it gets its own `connection()`; done), the verdict's reads in `app/page.tsx`, `lib/metrics/scorecard.ts`, `lib/queries.ts`, `tests/unit/get-viewer.test.ts` (mock `next/server`'s `connection`, as `tests/integration/identity.test.ts:30` does), `harness/measure.cjs` (Element Timing), `docs/agent-work/release/measurements/steps.md`; step 3 (ran): C `database/migrations/0038_set_based_acquisitions.sql`, `tests/integration/scorecard-equality.test.ts`, M `lib/metrics/scorecard.ts`, `lib/metrics/decision.ts` (eligibility needed no change) |
| WP-F | M `lib/ai/model.ts`, `lib/ai/investigate.ts`, `lib/ai/steps.ts`, `lib/ai/queries.ts`, `lib/ai/contract.ts`, `scripts/eval-ai.ts`, `app/api/investigations/route.ts`, `app/api/investigations/[id]/route.ts`, `app/api/investigations/[id]/evidence/route.ts`, `app/investigator/page.tsx`, `app/investigator/[id]/page.tsx`, `components/investigator/InvestigateForm.tsx`, `tests/unit/ai-model-loop.test.ts`, `tests/integration/ai-investigator.test.ts` (its `@/lib/server` mock gains `viewerForWorkspaceStart`); C `tests/integration/investigator-fallback.test.ts`, `tests/integration/workspace-investigations.test.ts`, `tests/unit/model-profiles.test.ts`, `tests/unit/no-uploads-to-models.test.ts`, `docs/agent-work/release/ollama-run.md` |
| WP-H | M `app/api/health/route.ts`; C `tests/integration/health.test.ts` |
| WP-I | M `docs/agent-work/release/ci-root-causes.md`, `harness/linux-ci-repro.sh`, `.github/workflows/ci.yml` (only if a cause lives there) |
| WP-J | C `tests/e2e/hosted.config.ts`, `scripts/clipboard.ts` (the loader's reader, moved), `scripts/clipboard-to-stdout.ts`, `harness/prev-build-check.cjs`, `harness/states.cjs`, `docs/agent-work/release/rehearsal.md`, `docs/agent-work/release/cold-review.md`, `docs/agent-work/release/checks/*`; M `scripts/load-hosted-db.ts`, `docs/deploy.md`, `README.md` (the "Run the demo locally" section the workspace copy links to), `tests/e2e/__screenshots__/*` (refreshed where the redesign changes them) |

The two new specs: WP-A creates `release-controls.spec.ts` and WP-B adds its shell tests to it; WP-C
creates `release-journeys.spec.ts` with J1, and WP-D (J2), WP-E (J3) and WP-F (J4) add theirs.

### WP-0. Baseline already in the tree (done)

Committed after these checks in the build mirror: `npx vitest run` (87 files, 1,008 passed, 1
expected fail: `checks/wp0-vitest.txt`); the forced Decision Lab race
(`docs/agent-work/product-audit/harness/recording/cls-race.cjs`, 1,500 ms lock): 0.160 before the
fix, 0.003–0.006 after, 0 of 12 runs over 0.1 (`checks/wp0-cls-race*.json`); the B03 check (§3):
`scenario.test.ts` passes, and Decision Lab's baseline equals the scorecard's (October $227.42 over
50, September $253.83 over 51).

### WP-A. Controls

**Writes (runtime):** none.

```ts
// components/ui.tsx
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";
export function buttonClass(opts?: { variant?: ButtonVariant; size?: ButtonSize; className?: string }): string;
export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant; size?: ButtonSize; icon?: React.ReactNode; busy?: boolean; busyLabel?: string; testId?: string;
}): React.JSX.Element; // renders data-variant; busy: aria-disabled, Working in the icon's place, width kept, clicks ignored
export function ButtonLink(props: { href: string; children: React.ReactNode; variant?: ButtonVariant; size?: ButtonSize;
  icon?: React.ReactNode; testId?: string }): React.JSX.Element; // renders data-variant
export function Working(props: { label: string }): React.JSX.Element;
export type ProductState = "missing" | "held" | "zero" | "corrected" | "approved";
export function StateBadge(props: { state: ProductState; detail?: string; testId?: string }): React.JSX.Element; // built on Badge

// components/actions/useAction.ts
export interface ActionMessage { ok: boolean; text: string; refreshed?: boolean }
export function useAction(): { busy: string | null; message: ActionMessage | null;
  run(label: string, url: string, body: unknown, method?: "POST" | "DELETE"): Promise<boolean> };
```

**Steps.**
1. The primitives: `buttonClass` (sizes 32 and 28 px, 16 and 14 px icons, the variants), `Button`,
   `ButtonLink` on `buttonClass`, `StateBadge` on `Badge`, `Segmented` with the 32 px track and the
   dark current item, the coarse-pointer hit-area utility in `app/globals.css`; the sizes and the
   one-primary rule recorded in `docs/design-system.md`. `PeriodTabs` already takes `extra`
   (`components/ui.tsx:136`): the Overview passes `branch`, `channel` and `week` there (WP-C).
2. `Working` moves into `ui.tsx`; `ProposalControls`, `ProposeForm` and `CaseControls` import it.
3. `useAction`: the method argument; every 409 an error that refreshes; a dropped connection
   refreshes with its own words; success only after a 2xx without `outcome: "failed"`.
4. Sidebar collapse: `aria-expanded`, the constant name "Navigation sidebar".
5. Silent buttons: each of the 28 files above whose request button shows no busy state moves onto
   `useAction` or `Button busy`; the commit body lists the files changed and those already correct.

**Tests.** `tests/e2e/release-controls.spec.ts` (new):
- on `/onboarding` as marketing analyst: "Try the sample" is 32 px tall at 1440 px with a 16 px
  icon; with `hasTouch` at 390 px its hit area is at least 44 × 44 px; holding
  `POST /api/onboarding/uploads` with `page.route` shows the working words, `aria-disabled`, the same
  box (x, y, width, height), and a second click sends no second request;
- on `/integrations` as integration engineer, "Run sync" (a `useAction` button after step 5) with
  `page.route` answering 200, then 409 with a message, then aborting: the success words only after
  the 200; the 409's words in the status region and a refresh; the dropped-connection words and a
  refresh;
- an `sm` button on `/integrations` is 28 px tall; focus-visible shows the outline; a disabled
  button shows its reason in words;
- the sidebar toggle reports `aria-expanded`.

### WP-B. Data times and shell

**Writes (runtime):** none.

```ts
// lib/metrics/scorecard.ts (freshness() and StreamFreshness unchanged)
export interface DataTimes {
  snapshotAt: Date | null;
  lastSourceSync: { at: Date; kind: "polling_run"; stream: string; clock: "business" }
    | { at: Date; kind: "sync_job"; entity: string; officeId: number; clock: "wall" } | null;
  lastCountedImport: { at: Date; uploadId: number } | null;
}
export async function dataTimes(db: Queryable): Promise<DataTimes>;
// components/Drawer.tsx ("use client"): extracted from components/incidents/EvidenceDrawer.tsx
export function Drawer(props: { open: boolean; onClose(): void; title: string; children: React.ReactNode;
  returnFocusTo?: React.RefObject<HTMLElement | null>; testId?: string }): React.JSX.Element | null;
```

**Steps.** 1. `dataTimes()`. 2. The header's accessible name and the `/audit` panel with all four
times. 3. The command-menu check (Ctrl+K, arrows, Enter, Escape, touch) and fixes where it fails.
4. `Drawer`, adopted by `EvidenceDrawer`, `FindingsView` and `JourneyTimeline`.

**Tests.**
- `tests/integration/data-times.test.ts` (new; seeds in `beforeAll` like `scenario.test.ts:5`,
  with the in-process CRM mock that `connectors.test.ts` uses): a queued, a running, a failed and a
  cancelled sync job, a refused file, a compare-only dry run and a publication that adds nothing
  leave all four times unchanged; a succeeded sync job moves the last source sync to that job
  (entity, office, wall clock) and leaves "Data as of" unchanged; a publication that inserts a call
  moves only the last counted import.
- `release-controls.spec.ts` (added): Ctrl+K opens the menu, Enter opens a result with focus on its
  `h1`, Escape returns focus to the opener; the header's search button opens it with `hasTouch`; a
  drawer (the customer journey's) traps focus, locks scroll and returns focus on close.

### WP-C. Overview, chart, Back, route audit

**Writes (runtime):** none (URL and `sessionStorage` only).

```ts
// lib/metrics/movement-copy.ts (exists: explainCell, pointTitle, weekLabel, dollars)
export function cellSentence(series: Series, cell: Cell, week: WeekInfo, markers: Marker[], scopeLabel: string): string;
// pointTitle(...) + explainCell(...) in one sentence: value, unit, the week's dates, the scope, the cell's state
// components/useRestoreFocus.ts ("use client")
export function rememberFocus(id: string): void; // before navigating away
export function useRestoreFocus(): void;         // on mount: focus the remembered element for this URL, then forget it
```

**Steps.**
0. Route audit, right after WP-A: every route in §6 at 1440 and 390 px, as guest and as the role
   that can act; its first-screen answer and next action; pass or fail with the reason, and the
   owning package for each failure, in `route-audit.md`.
1. The chart: `cellSentence` for the tooltip and the panel; roving week and channel groups; the
   selection read with `useSearchParams()` as well as the server's first props, so a Back served
   from the client cache shows the selection its URL names; `rememberFocus` on "Open evidence";
   `useRestoreFocus` on mount; `PeriodTabs` given `branch`, `channel` and `week` in `extra`.
2. The audit's failures on WP-C's routes; `elementtiming="verdict"` on the headline answer.

**Tests.** J1 in `tests/e2e/release-journeys.spec.ts` (new), tagged `@core`:
1. Overview, B09, October: hover a point; the tooltip equals the panel's sentence for that cell.
2. Keyboard only: Tab to the week buttons, arrow to a week, Enter; the URL gains `channel` and
   `week`; Tab to "Open evidence", Enter: the trace for that channel and week.
3. Back: the URL, period, brand, selected cell and panel are as before, and focus is on "Open
   evidence".
4. At 390 px with `hasTouch`: tap a point, tap "Open evidence", Back; the same holds.
5. With `reducedMotion: "reduce"`: steps 1–3, and no animation is running
   (`document.getAnimations()` has none in the `running` state).
6. On `/`, at most one visible `[data-variant="primary"]`; at 720 × 450 with device scale factor 2
   the verdict and its action are visible and the page has no sideways scroll.

**Implementation notes** (WP-C steps 1–2):
1. The Overview's one primary action is the verdict's: "Open B20 Heron" (`headline-action`) under
   the sentence, which now names the branch without an inline link. "Open evidence" and "Reset" in
   the chart's panel are a secondary and a ghost button.
2. A dot keeps its 4 px mark; a transparent 12-unit target under every dot takes a finger's tap,
   drawn beneath all lines and dots so a pointer on a dot still reaches the dot.
3. Back can show the page before it is visible, and the page can render again from the server just
   after, replacing the focused element. `restoreRememberedFocus` therefore keeps focus on the
   remembered element for about two seconds, until the reader presses a key or the pointer, then
   forgets it.
4. The chart journey's accessibility check found two names that did not contain their visible
   words (WCAG 2.5.3): the sidebar toggle ("Collapse" in "Navigation sidebar"; its visible word is
   now "Navigation") and the header's data-times link, whose name now starts with exactly what it
   shows, then adds the other three times (WP-B's link, `components/ShellStatus.tsx`).
5. WP-G step 2 is in the same change: the Overview awaits only the verdict's reads (branch rows,
   bridge, holds); September's comparison, the weekly series, the brand lines and the feeds'
   freshness start after the verdict and "What changed", each in its own Suspense section.

### WP-D. Visitor workspace and the upload result

**Writes (runtime).**
- A workspace start, and the rows a workspace dry run writes: `workspace_quota` rows per bucket, in
  their own committed transaction, before the work, refusals included.
- A workspace upload: `onboarding_uploads`, `onboarding_rows`, `onboarding_mappings`,
  `onboarding_dry_runs`, `onboarding_row_results`, the parents carrying the owner.
- Every onboarding request, any viewer: `deleteExpiredWorkspace()` deletes expired workspace
  uploads with their children, expired `workspace_investigations` with their steps, and
  `workspace_quota` rows older than two days; `purgeExpired()` keeps purging expired company
  uploads as today (updates `onboarding_uploads`, deletes `onboarding_rows`, scrubs row results and
  dry runs; `service.ts:107-137`).
- Staging under the budget: `makeRoomForUpload` deletes other visitors' workspace uploads older than
  30 minutes.
- `audit_log`: no entry for workspace items or their refusals (the call sites at
  `service.ts:154, 181, 310, 397, 446, 548` skip them); company entries unchanged.
- Company uploads also gain `ledger_target` on their row results; nothing else in the staff flow
  writes differently.

```ts
// lib/viewer.ts
export interface Permissions { /* existing */ workspace: boolean } // false in NONE and every VIEWERS entry
export function workspaceViewer(subject: string | null): Viewer;   // new object per call; null → subject "demo:guest"

// lib/server.ts ("server-only")
export const VISITOR_COOKIE = "rs_visitor";
export function workspaceEnabled(env?: Record<string, string | undefined>): boolean; // PUBLIC_WORKSPACE === "1"
export async function getViewer(): Promise<Viewer>;            // reads only (§5.1 order)
export async function viewerForWorkspaceStart(request: Request): Promise<{ viewer: Viewer; setCookie: { name: string; value: string;
  httpOnly: true; sameSite: "lax"; secure: boolean; path: "/"; maxAge: 86_400 } | null }>; // secure as app/api/role/route.ts:16-18 decides it

// lib/workspace.ts (no server-only import, so tests can use it)
export const WORKSPACE = { retentionHours: 24, maxBytes: 4 * 1024 * 1024, maxRows: 10_000, maxMappingsPerUpload: 10,
  heldRowBudget: 100_000, minResidencyMinutes: 30, rowsWrittenPerMinute: 50_000, rowsWrittenPerDay: 500_000,
  uploadsPerMinute: 30, investigationsPerMinute: 30, sampleSha256: "<sha256 of the sample's base64 text>" } as const;
export function subjectOf(token: string | undefined): string | null; // "visitor:" + sha256 hex; null unless 43 base64url chars
export function availabilitySentence(startedAt: Date): string;
export type QuotaRefusal = { status: 413 | 422 | 429 | 503; message: string };
// Counting runs in its own transaction and commits before the work, so a refusal still counts.
// Buckets: date_trunc('minute', now()) and date_trunc('day', now()), database clock, UTC.
export async function countStart(pool: Pool, kind: "upload" | "investigation"): Promise<QuotaRefusal | null>;
export async function countRows(pool: Pool, rows: number, isSample: boolean): Promise<QuotaRefusal | null>;
// Inside stageUpload's transaction, after pg_advisory_xact_lock(hashtext('workspace:budget')), before the insert.
export async function makeRoomForUpload(tx: PoolClient, rows: number): Promise<QuotaRefusal | null>;
export async function deleteExpiredWorkspace(pool: Pool): Promise<{ uploads: number; investigations: number; quotaRows: number }>;
export async function deleteWorkspaceUpload(db: Queryable, uploadId: number): Promise<void>; // children first

// lib/onboarding/access.ts (summary() and summaries() move here from service.ts, which imports them)
export type OnboardingAccess = "company" | "workspace" | null;
export function onboardingAccess(viewer: Viewer): OnboardingAccess;
export function requireOnboarding(viewer: Viewer, action: string, kind?: "propose" | "approve" | "either"): Exclude<OnboardingAccess, null>;
export async function uploadFor(db: Queryable, viewer: Viewer, id: number): Promise<UploadSummary>; // 404 unless visible and unexpired
// UploadSummary gains: workspaceStartedAt: string | null

// lib/onboarding/parse.ts and xlsx.ts: unchanged. The workspace's row limit is checked on the parsed
// table (implementation note 1 below).

// lib/onboarding/limits.ts (no server import: UploadForm checks the size with the same words)
export function tooLargeMessage(bytes: number | null, maxBytes: number, scope: "workspace" | "company"): string;

// lib/onboarding/service.ts
// stageUpload keeps its type for company uploads ({ upload } | { refused }), so its callers and tests are untouched;
// the workspace path is its own function, which the upload route picks by onboardingAccess(viewer)
export async function stageWorkspaceUpload(pool: Pool, args: { viewer: Viewer; filename: string; bytes: Buffer; sheetIndex?: number; now: Date }):
  Promise<{ upload: UploadSummary } | { repeatOf: { id: number; startedAt: string } } | { refused: { code: string; message: string; status: QuotaRefusal["status"] } }>;

// lib/onboarding/ledger.ts
export type LedgerTarget = /* §5.3 */;
export interface LedgerRowResult { /* existing */ target?: LedgerTarget }
export function ledgerHref(target: LedgerTarget): string | null;
```

**Steps.**
1. Migration 0037 (§9), `.gitattributes`, and `WORKSPACE.sampleSha256` with a unit test that
   recomputes it from the file.
2. `workspaceViewer`, the §5.1 order in `getViewer()`, `viewerForWorkspaceStart`, and the access
   module; `app/onboarding/page.tsx:38-40` and `app/onboarding/[id]/page.tsx:212-214` call
   `onboardingAccess`, and the pages' own permission flags follow it: a workspace guest can upload
   (`page.tsx:45`, `canUpload`) and propose and dry-run mappings for its own uploads
   (`[id]/page.tsx:376-377`, `canPropose`), and sees no approval or publication controls.
3. `stageWorkspaceUpload`, in this order:
   a. `deleteExpiredWorkspace()`;
   b. `countStart(pool, "upload")`;
   c. the size check (413), then the repeat lookup (same owner, same `file_sha256` and sheet, live) →
      `repeatOf`;
   d. `parseUpload`, then the row limit on the parsed table (422);
   e. `countRows(pool, rows, isSample)`;
   f. one transaction: the advisory lock, `makeRoomForUpload`, the repeat lookup again (a retry that
      raced the first request finds it here), then the insert of the upload and its rows.
   Company uploads keep today's path; `purgeExpired()` gains `workspace_owner is null`.
4. Mappings and dry runs: workspace mappings keyed to their upload; the layout-wide queries with
   `workspace_owner is null`; a new dry run of a workspace upload replaces the previous one in the
   same transaction and counts its rows with `countRows`; at most 10 mappings; `decideMapping`
   refuses a workspace mapping; no approved hint for a workspace upload.
5. Ledger targets: `compareWithLedger` returns them (§5.3 rules), `runDryRun` stores them,
   `rowResults` returns `ledgerHref` when `canSeeBranch` holds.
6. Routes: `POST /api/onboarding/uploads` reads the body with the viewer's limit (`WORKSPACE.maxBytes`
   or `LIMITS.maxUploadBytes`) and names the file's size from `content-length` when it is sent;
   sets the cookie from `viewerForWorkspaceStart`; answers `repeatOf` 200 and refusals with their
   status; `DELETE /api/onboarding/uploads/[id]` deletes a workspace upload whole for its owner;
   `export const maxDuration = 60` on the upload, mapping and dry-run routes;
   `GET /api/workspace/cleanup` and the daily cron in `vercel.json`
   (`{ "crons": [{ "path": "/api/workspace/cleanup", "schedule": "0 5 * * *" }] }`).
7. Pages: `/onboarding` states formats, columns, currencies, limits and what happens to the file,
   from `targets.ts`, `limits.ts` and `WORKSPACE`; `UploadForm` checks `file.size`, opens `repeatOf`
   with `?repeat=1`, and shows a non-JSON 413 as the size refusal; `/onboarding/[id]` shows the result
   first after a dry run, the repeat notice, the workspace label with `availabilitySentence`,
   "Delete it now" (`useAction` with `DELETE`), the 404 message of §5.2, the eligible labels of §5.2,
   the published card's sentence of §5.3, and `elementtiming="verdict"` on the result counts.
8. The route audit's failures on `/onboarding` and `/onboarding/[id]`.

**Tests.**
- `tests/integration/workspace.test.ts` (new; seeds in `beforeAll`; inserts `workspace_quota` rows
  and backdates `workspace_started_at` directly instead of waiting):
  - visitors A and B stage, map and dry-run the sample with the same answers: each gets its own
    mapping, ordinal and result, and neither resolves the other's upload, mapping or dry run (404);
    A's list holds only A's items;
  - a staff role cannot open a workspace upload (404); a workspace guest cannot open a company
    upload or use a company mapping (404); `decideMapping` refuses a workspace mapping;
  - `raw_events`, `leads`, `ad_spend_daily`, `crm_payments`, `crm_customers`, `audit_log` and the
    company onboarding rows keep their counts through A's whole journey, and `freshness()` and
    `dataTimes()` return the same values;
  - repeat: the same bytes from A answer `repeatOf`; from B they stage a new upload;
  - limits (each case presets `workspace_quota` and the held budget directly, and an `afterEach`
    deletes every `workspace_quota` row and workspace upload, so no case leaks into the next):
    `WORKSPACE.maxBytes + 1` bytes refused 413 by the route; 10,001 rows refused 422; with
    `workspace_quota` preset to 29 starts this minute, the 31st start answers 429; with the day's
    rows preset to the cap, a file answers 429 and the sample still stages; with the held budget
    preset full of uploads older than 30 minutes, the oldest is evicted, and full of younger ones,
    503;
  - a refusal leaves its quota count and no `audit_log` row; two concurrent stages at the budget's
    edge never both pass;
  - expiry: an upload backdated 25 hours answers 404 at once and is gone after the next onboarding
    request, with no rows left in the five tables; `GET /api/workspace/cleanup` deletes only expired
    items and quota rows older than two days; `purgeExpired()` leaves workspace uploads alone;
  - a second dry run replaces the first; the eleventh mapping is refused; "Delete it now" leaves
    nothing.
- `tests/integration/onboarding-publish-once.test.ts` (new): a staff publication; a second publish
  answers 409; the same file staged again dry-runs every row to "matches ledger" and publishes 0;
  `raw_events` and `leads` counts move once.
- `tests/e2e/release-journeys.spec.ts`, J2 (added; the e2e server runs with `PUBLIC_WORKSPACE=1`):
  - `@core`, two browser contexts: A reads the formats, columns, currencies and limits; uploads
    `unseenCallsCsv` by the file chooser; answers the two questions; sees the result card on the
    first screen at 1440 and 390; follows a matched row's ledger link and Back; reopens the result
    from `/onboarding` after a reload; B opens A's URL and gets the "not available" page, sees none
    of A's items, and reads the Overview's at-risk figure and the `/audit` data times as they were
    before A began; the result never says "booked" or "published", and "added to the ledger" only
    in "Nothing was added to the ledger"; at most one `[data-variant="primary"]` per page;
  - `@edge`, one context: a malformed file (its reason), a file over 4 MB (its reason, from the
    browser's check), the same file twice (the repeat notice, the same counts), and an upload
    expired with `expireWorkspaceItem()` from `tests/e2e/db.ts` (the "not available" page).
- `tests/e2e/z-onboarding.spec.ts`: line 38 expects the new eligible label. In the test at lines
  67–75 the guest leaves the loop: partner and brand keep "limited to company-wide" and 403, and a
  new assertion expects the guest to see the workspace upload form on `/onboarding` and a 404 for the
  staff upload's API URL (a company upload is not the guest's).
- `tests/integration/review-regressions.test.ts:108-111`: the guest's permission set includes
  `workspace: false` outside the workspace and `true` as the workspace guest.
- `tests/unit/get-viewer.test.ts`: the §5.1 order, including a staff role with the flag on.
- Flood (not in CI): `npx tsx harness/flood-workspace.ts <baseUrl>` against the rehearsal server
  (WP-J step 4): 35 uploads a minute for 3 minutes, each a different 10,000-row file; refusals,
  table sizes and WAL growth into `docs/agent-work/release/flood.md`.

**Implementation notes** (decided while building WP-D; no interface above them changed meaning):
1. The workspace's row limit is checked on the parsed table, not threaded into the parser and the
   XLSX reader: the parser's own 50,000-row bound already caps the work, and the refusal can then
   name the file's own count. `parse.ts` and `xlsx.ts` are unchanged.
2. `makeRoomForUpload` deletes only when deleting is enough: it picks the oldest uploads past their
   residency whose rows cover the shortfall (one window query), and when even all of them would not,
   it deletes nothing and refuses (503).
3. Files the plan did not list: `components/onboarding/DeleteNow.tsx` ("Delete it now", used by the
   result card and the counting card); `lib/element-timing.d.ts` (types the `elementtiming`
   attribute); `tests/unit/uploads-never-reach-models.test.ts` (the threat model's "a unit test keeps
   it so"); `lib/actions.ts` (`ActionError` takes 413, 422, 429 and 503). J2 creates `tests/e2e/release-journeys.spec.ts`; WP-C steps 1–2 add J1 to it.
4. `LOCAL_DEMO_URL` in `lib/workspace.ts` links to the README's "Run the demo locally" section,
   which WP-J writes (its Files row lists `README.md`). WP-J also adds Neon's restore window, read
   from the project's Backup & Restore page, to the retention sentence on `/onboarding`.
5. The header shows the role picker only in demo mode. Outside it `POST /api/role` answers 404, so
   on the hosted demo the picker offered staff roles that did nothing; the header now names the
   visitor instead ("Guest · your workspace"), and in demo mode the guest's option says whether it
   has a workspace (`app/layout.tsx`, `components/RoleSwitcher.tsx`).
6. The route audit's `/onboarding` row failed on a phone (the upload button at 998 px): the intro
   is shorter and the upload card comes before the workspace note; the result's next action comes
   before the note too (`docs/agent-work/release/route-audit.md`, "Failures, and where each is
   fixed").

### WP-C steps 1–2

As listed in WP-C above, after WP-D.

### WP-E. Incidents and Decision Lab

**Writes (runtime):** `action_executions` stores the new `month` inside its existing JSON state
(no new column).

```ts
// lib/workflow/snapshot.ts
export interface StateSnapshot { /* existing */ month?: { key: PeriodKey; branch: BranchSnapshot } | null }
// captureState() adds it: the latest PERIODS calendar month (sep, oct) whose start the business clock has passed,
// computed by branchRows; absent on executions stored before this release
```

**Steps.** `StateBadge` in the incident header (`app/exceptions/[id]/page.tsx`), the queue rows
(`CaseQueue.tsx`, `badges.tsx`), Decision Lab's readiness and the receipts; `captureState`'s `month`;
`FixResult` leads with the month and shows the replay window below it; Decision Lab's next action
directly under the verdict on phones, `elementtiming="verdict"` on its readiness summary; the
route audit's failures on `/exceptions`, `/exceptions/[id]` and `/decisions`.

**Tests.**
- `tests/integration/b20-receipt.test.ts` (new; seeds in `beforeAll`): runs B20's fix through the
  Action Center functions (propose, dry run, approve, execute); the stored execution's `month` is
  October: paid CAC 49011 → 27131 cents, paid-media spend 1519347 cents before and after, 109
  serviced customers, paid customers 31 → 56.
- J3 in `release-journeys.spec.ts` (added, `@core` is not set: it needs staff roles). Before it,
  `seedReplayableIncident()` (added to `tests/e2e/db.ts`) ingests three calls at B07 with the field
  layout `calls@1.0` refuses, through the existing `ingest()` helper with
  `mapper: mapperFor("calls", "1.0")`, and reconciles at the business clock (`getNow`), so one
  incident offers a replay with `calls@1.1`. WP-E's own run is
  `… npx playwright test tests/e2e/os-golden-path.spec.ts tests/e2e/release-journeys.spec.ts`, so B20's
  fix exists. Then: as integration engineer on that incident, the dry run (busy
  state, then "Dry run — nothing was saved"); on B20's incident, fixed earlier in the suite by
  `os-golden-path.spec.ts`, the stored receipt with Corrected and Approved badges and October's
  $490.11 → $271.31 first; as guest on the same incident, the reason and no action; B09's held
  decision in Decision Lab offers no approval; at most one `[data-variant="primary"]` per page.

**Implementation notes** (WP-E):
1. The stored figures corrected two numbers in this design: October's paid-media spend is
   $15,193.47, and the 25 newly paid customers are not "22 from unknown, 3 from door-to-door": 33
   customers changed channel (30 had none, 3 were door-to-door); 25 now count as paid media and 8
   as organic Business Profile. Snapshots gain `acquiredByChannel` (every channel), and the receipt
   words the move from it; §5.8 says the same.
2. One primary action per page: the proposal form's "Propose fix" is secondary, and Decision Lab
   puts the first blocking incident's primary action directly under its verdict at every width (the
   list below links the others), with a Held badge beside "Not ready".
3. "Switch to <role>" prompts appear only in demo mode; on the hosted demo the incident and the
   scenario builder say the records or scenarios are shown read-only (`app/exceptions/[id]/page.tsx`,
   `app/decisions/page.tsx`).
4. J3 fixes B20 itself through the Action Center when it runs without `golden-path.spec.ts`, which
   otherwise fixes it earlier in the suite.

### WP-G. Performance

**Writes (runtime):** none (step 3, if it runs, replaces a view in migration 0038).

**Steps** (§5.10), each measured with `harness/measure-cold.sh` and recorded in `steps.md`:
1. `await connection()` in `getViewer()`; `FreshnessIndicator` gets its own; the components that
   read data before the viewer are listed in `steps.md` with the same call.
2. The trace of what gates the Overview's verdict, the expected time written down, then the reads
   the verdict does not show (weekly series, brand rows) moved into their own `Suspense` sections in
   `app/page.tsx`.
3. Only if the warm verdict still exceeds 1,000 ms: migration 0038 makes `v_acquisitions`' "first"
   orderings total (adding the appointment id after `scheduled_for desc`) and filters by the period
   first; `lib/metrics/eligibility.ts`'s `period_acq` follows it. Otherwise step 3 is recorded as not
   needed.

**Tests.**
- `tests/unit/get-viewer.test.ts` mocks `connection` (as `tests/integration/identity.test.ts:30`).
- The request-time prerender runs no query: `harness/trace-query.cjs` shows one holds query per load
  and no "while prerendering" error.
- If step 3 runs: `tests/integration/scorecard-equality.test.ts` (new; seeds in `beforeAll`): every
  branch and period gives the same `branchRows` and eligibility results with the old view (kept in
  the test) and the new one; on added fixtures with ties in `sold_at` and `scheduled_for` and
  subscriptions spanning September and October, the two agree once both orderings are total.
- `measure-cold.sh` after each step, same data; the §4 goals reported, regressions blocking.

**Implementation notes** (WP-G):
1. Step 3 ran: after step 2 the warm verdict was 1,396 ms. Each of the verdict's four reads spent
   most of its time deciding `v_acquisitions`' two "firsts" for all 17,111 customers before keeping
   its period, and two of them also credited every customer's first touch to keep a few
   (`measurements/steps.md`, step 3).
2. The migration is `0038_set_based_acquisitions.sql`. It adds `v_first_subscriptions` (each
   customer's first subscription) and `v_initial_appointments` (each subscription's deciding
   initial appointment, the appointment id now its last key), both written as "no row orders before
   this one", so the planner can start from a period's rows or from one customer's.
   `v_acquisitions` reads them; its columns and its first-touch rule are 0026's.
3. Four statements changed with it. The scorecard's `sold` count reads `v_first_subscriptions`
   (it never used the first touch). The scorecard's `period_acq` takes the period as parameters:
   read from `p`, the planner credited 9,477 customers before keeping October's 3,687. The bridge's
   `acq` and the unmapped-spend hold (`UNMAPPED_AT_BRANCH`, also in `budgetSignal`) first name the
   customers that share a phone or email with the leads in question, passed as an array: as a
   semi-join, the planner credited every customer first (1.9 s for the bridge).
4. `lib/metrics/eligibility.ts` needed no change: its `period_acq` already keeps the period first,
   and it reads the new view.
5. `tests/integration/scorecard-equality.test.ts` runs every read twice on one connection: as it
   is, and on 0026's view (read from that migration, kept as a temporary table) with the old text
   of each changed statement. A changed statement that no longer contains its new text fails the
   test, so a later edit updates the old text or retires the check. It covers the scorecard for
   every month and week, the bridge for every branch and month, eligibility and both holds for the
   company and nine branches, and `budgetSignal` for every branch in October and September.

### WP-F. Investigator

**Writes (runtime).** A workspace investigation writes `workspace_investigations` (its insert,
completion and failure updates at `investigate.ts:126, 214, 228` go to `tablesFor(viewer)`),
`workspace_investigation_steps` and `workspace_quota`; the `audit_log` writes at
`investigate.ts:131, 220, 231` skip it. Every investigator request first runs
`deleteExpiredWorkspace()`, which deletes expired workspace uploads (with their children),
workspace investigations (with their steps) and old `workspace_quota` rows. Staff investigations
write as today.

```ts
// lib/ai/model.ts
export interface ModelProfile { provider: "anthropic" | "ollama"; model: string; perRequestMs: number; totalMs: number; priced: boolean;
  request(base: { system: string; tools: Anthropic.Beta.Messages.BetaTool[]; messages: Anthropic.Beta.Messages.BetaMessageParam[] }):
    Anthropic.Beta.Messages.MessageCreateParamsNonStreaming }
export function modelClientFromEnv(env?: Record<string, string | undefined>): { client: ModelClient; profile: ModelProfile } | null;
// ModelClient is unchanged (create returns a BetaMessage); the Ollama client is the SDK with apiKey "ollama" and
// baseURL OLLAMA_BASE_URL, refused unless the host is loopback
// ModelRunInput gains `profile`; the request is built by profile.request instead of inline
export type FallbackClass = "no_credentials" | "unreachable" | "timeout" | "rate_limited" | "auth" | "bad_request"
  | "invalid_output" | "no_verified_statement" | "other";
// describeApiError becomes classifyModelError(error): { class: FallbackClass; message: string }, never throwing

// lib/ai/steps.ts
export type InvestigationTables = { investigations: "investigations" | "workspace_investigations";
  steps: "investigation_steps" | "workspace_investigation_steps" };
export function tablesFor(viewer: Viewer): InvestigationTables; // StepRecorder takes them instead of its hard-coded table

// lib/ai/queries.ts
// listInvestigations: company items (read-only) plus the viewer's own workspace items
// getInvestigation and resolveEvidence: an id is looked up in investigations, then, for a workspace guest only,
// in workspace_investigations with its owner; both tables share investigations_id_seq, so an id names one record
```

**Steps.**
1. Profiles, `modelClientFromEnv` with the §5.9 precedence, and the Ollama client. Check once that
   Ollama 0.40.16 answers the SDK's beta endpoint (`/v1/messages?beta=true`); if it does not, the
   Ollama client wraps `client.messages.create` and returns its message as the `BetaMessage` shape
   the loop reads.
2. `classifyModelError` replaces `describeApiError`; a response without `usage` counts zero tokens
   and keeps the model's answer; "other" is logged with its stack.
3. The no-verified-statement fallback; the fallback stored as `mode = 'deterministic'`, `model` = the
   model tried, `result.fallback = { class, message }` (`lib/ai/contract.ts` gains the field and the
   reworded labels).
4. Workspace investigations: every investigator route starts with `deleteExpiredWorkspace()`;
   `POST /api/investigations` admits the workspace guest (the permission
   checks at `route.ts:47` and `investigate.ts:108` accept `workspace`), runs deterministic, counts
   the start, sets the cookie on the streamed response, `export const maxDuration = 60`;
   `DELETE /api/investigations/[id]` deletes the owner's workspace investigation; the reads of
   `[id]` and `[id]/evidence` go through `getInvestigation` and `resolveEvidence`.
5. Pages: `/investigator` shows the ask form to the workspace guest with the mode named, and the
   guest's list; `/investigator/[id]` shows the mode words, "Delete it now" for the owner, and
   `availabilitySentence`; the route audit's failures on `/investigator` and `/investigator/[id]`.
6. `scripts/eval-ai.ts` uses `modelClientFromEnv` and fails when any case falls back with class
   "other".

**Tests.**
- `tests/integration/investigator-fallback.test.ts` (new): a mocked client that times out, answers
  429, 401 or 400, throws an unknown error, returns schema-invalid output, or returns a draft whose
  every statement grounding drops: each run answers through the deterministic path and stores its
  class; a response with no `usage` keeps the model's answer at zero tokens; a fallback of class
  "other" fails the test.
- `tests/integration/workspace-investigations.test.ts` (new): deterministic whatever keys are set;
  owner-only (another visitor gets 404 by id and by evidence id); the id never collides with a
  company investigation's; unaudited; unreadable after 24 hours (backdated) and deleted with its
  steps by the next cleanup; inquiries and notes forbidden to the guest; with `workspace_quota`
  preset to 29 starts, the 31st answers 429.
- `tests/unit/model-profiles.test.ts` (new): the precedence; the Ollama client sends
  `x-api-key: ollama` with `ANTHROPIC_API_KEY` set; a host that is not loopback is refused.
- `tests/unit/no-uploads-to-models.test.ts` (new): no file under `lib/ai` names an `onboarding_`
  table; only `lib/ai/steps.ts`, `lib/ai/investigate.ts`, `lib/ai/queries.ts` and `lib/workspace.ts`
  name the `workspace_investigation` tables.
- `tests/unit/ai-model-loop.test.ts`: passes the Anthropic profile (line 69).
- `tests/integration/ai-investigator.test.ts`: its `@/lib/server` mock exports
  `viewerForWorkspaceStart`.
- J4 in `release-journeys.spec.ts` (added, `@core`): a guest asks "Why did B20's CAC jump in
  October?" by keyboard; the answer names the deterministic path and cites records; a cited record
  opens; at most one `[data-variant="primary"]`.
- A recorded local run against Ollama (`qwen3:8b`), not in CI: `docs/agent-work/release/ollama-run.md`.

**Implementation notes** (WP-F):
1. One fallback class was added: `declined`, for a model's own refusal (`stop_reason: "refusal"`),
   which none of the others named honestly. `classifyModelError` also maps 403 to `auth`, 404 (a
   model not pulled into Ollama) to `bad_request`, and 5xx to `unreachable`.
2. "No verified statement" is decided after the model draft is grounded: when the analyst keeps
   no claim (`claimsKept` is 0), the deterministic investigator answers and the result's
   `fallback` says so. The stored `model` is the model that was tried, on a fallback too.
3. A non-loopback `OLLAMA_BASE_URL` throws `ModelConfigError` when the client is built, so the
   misconfiguration fails loudly instead of falling back quietly; the investigator page treats it
   as "no model" for its label only.
4. The Anthropic SDK 1.3 sends any API key as `Authorization: Bearer`. The Ollama client passes
   the placeholder key explicitly, which also stops the SDK reading `ANTHROPIC_AUTH_TOKEN`;
   `tests/unit/model-profiles.test.ts` checks that no environment credential reaches Ollama.
5. The table-naming rule lives in `tests/unit/uploads-never-reach-models.test.ts` (WP-D's), not
   a second file. `components/investigator/DeleteInvestigation.tsx` is new ("Delete it now"), and
   `InvestigateForm` takes the visitor's own help sentence (no fix is drafted for a visitor).
6. Messages are written as predicates of "The model …" / "The local model …", so the page reads
   "The local model timed out after 45 s, so this answer came from the deterministic evidence
   path." `tests/unit/ai-contract.test.ts` and `tests/integration/ai-investigator.test.ts` follow
   the reworded labels; one model draft in the latter gains a statement the evidence supports, so
   it still tests rejections inside an answer that stands.

### WP-H. Build identity

`app/api/health/route.ts` returns `commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null` beside today's
fields. **Test:** `tests/integration/health.test.ts` (new): the shape, with the variable set and
unset.

### WP-I. CI on Linux

1. Baseline (done during the design): 12 failures in the seven spec files on `c445311` in the CI
   mirror (`ci-root-causes.md`). The seven: `tests/e2e/os-modules.spec.ts`,
   `z-a11y-regressions.spec.ts`, `z-quality-gates.spec.ts`, `z-trace.spec.ts`,
   `zy-evidence-journey.spec.ts`, `zy-overview-movement.spec.ts`, `zz-b09-four-minute-path.spec.ts`.
2. For each failure: the spec, the assertion, the trace, the cause, the fix.
3. After WP-H: `bash harness/linux-ci-repro.sh <HEAD> C:/Temp/rso-ci-out/after 2` with the seven
   files; fix what remains at its cause. No assertion is weakened and no timeout raised without a
   stated reason.
4. The same with the full suite (`bash harness/linux-ci-repro.sh <HEAD> C:/Temp/rso-ci-out/full 2
   tests/e2e`), green. GitHub CI on the release SHA's pull request is checked in WP-J step 6.

**Time box:** one working session. A failure left at the end stops the release before promotion
and is reported as the blocker.

**Implementation notes** (WP-I; detail in `ci-root-causes.md`):
1. The seven files on `7d38ad7`: 62 passed, 2 failed, 12.9 minutes (59.8 before). WP-G removed
   the slow rendering behind ten of the twelve failures; the Decision Lab's layout shift was
   already fixed in WP-0. The two left: the subset's missing precondition (passes in the full
   suite) and a new axe finding from the 320 px mapping-table fix, corrected in `91acac5`.
2. The full suite on `91acac5`: 138 passed, 3 failed, 3 skipped (the pixel baselines), 27.8
   minutes. The three were the tests' own (an incident found by scanning, a hidden block read with
   `innerText`), fixed in `c87029c`; the two files then passed in the mirror (19 of 19).

### WP-J. Verification, release, rollback

1. **The release SHA.** Every code, test and doc change for the release is committed (including
   `docs/deploy.md` and the README's "Run the demo locally" section). First, the visual suite runs in
   the build mirror (`VISUAL=1`); where the redesign changes a baseline on purpose, the baselines
   are refreshed with `--update-snapshots`, looked at, and committed with the reason. The last commit
   is the release SHA. Then, in the build mirror:
   `git checkout --force --detach <SHA>`; `git clean -fdx -e node_modules`; `git status --porcelain`
   prints nothing; `npm ci`; `npm run build`. On that tree:
   - `npm run typecheck`, `npm run lint`, `npm test`;
   - `npm run eval:ai` (the five packs; a fallback of class "other" fails it);
   - the full browser suite: `VISUAL=1 CI=1 PORT=3989 DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc FIELDROUTES_MOCK_BASE_URL=http://localhost:3989/api/mock/fieldroutes npx playwright test`;
   - `npm run acceptance:b09` and `npm run acceptance:byof`.
   Logs go to `docs/agent-work/release/checks/`. A fix makes a new commit, and step 1 starts again.
2. **States.** In the build mirror, start
   `DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc DEMO_MODE=1 PUBLIC_WORKSPACE=1 npx next start -p 3993`,
   then `node harness/states.cjs http://localhost:3993 docs/agent-work/release/checks/states.md`: on
   each ★ route at 1440, 390 and 320 px, and at 200% zoom (720 × 450 CSS px, device scale 2), as
   guest and as the role that can act: loading (its data request held with `page.route`), empty (a
   fresh workspace on `/onboarding` and `/investigator`), failed (its API answered 500 with
   `page.route`), restricted (guest, and partner on another branch); no sideways scroll; at most one
   visible `[data-variant="primary"]`, and exactly one for the role that can act; a screenshot and a
   pass or fail line each.
3. **Measurements and captures** after (§10), side by side with before.
4. **Rehearsal** (§9), recorded in `rehearsal.md`:
   - the release worktree: `git worktree add --detach C:/Temp/rso-release-sha <SHA>` (or, when it
     exists, `git -C C:/Temp/rso-release-sha checkout --force --detach <SHA>`), `npm ci`,
     `npm run build`;
   - `create database revenue_signal_rehearse` if it does not exist;
   - the load, from the release worktree:
     `ALLOW_LOCAL_TARGET=1 HOSTED_DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rehearse npm run db:load-hosted`;
     the loaded SHA recorded in `checks/loads.md`;
   - the release build in production mode: `DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rehearse PUBLIC_WORKSPACE=1 npx next start -p 3991`;
     then `BASE_URL=http://localhost:3991 DATABASE_URL=…/revenue_signal_rehearse npx playwright test -c tests/e2e/hosted.config.ts --grep "@core|@edge"`
     (J1, J2, J4), and the flood (WP-D);
   - the previous build: `git worktree add --detach C:/Temp/rso-prev 1814616`, `npm ci`,
     `npm run build`, `DATABASE_URL=…/revenue_signal_rehearse npx next start -p 3992`; then
     `node harness/prev-build-check.cjs http://localhost:3992` checks `/`, `/decisions?branch=B20`,
     `/exceptions` and `/onboarding` answer 200 with their verdicts, and that `/investigator`,
     `/api/investigations` and `/onboarding` show none of the workspace items the rehearsal made.
   `tests/e2e/hosted.config.ts` (new): `baseURL` from `BASE_URL`, no `webServer`, no `globalSetup`.
5. **Release database and Preview variables, before any push:** the Neon branch
   `release-2026-11-18` from Neon branch `main` if it does not exist; "load a database" into it from
   the release worktree, again only when a later release SHA changed the migrations or the seed
   (`git diff --name-only <loaded SHA> <release SHA> -- database lib/sim`); "set a variable" for the
   Preview deployment from the loader's clipboard, once; `PUBLIC_WORKSPACE=1` for the git release
   branch's Preview deployments, once. Read Neon's restore window from the project's Backup &
   Restore page; if `/onboarding`'s words differ, correct them (a new commit, step 1 again).
6. **Push** the git release branch; open a pull request to `main`; GitHub CI on the release SHA is
   the Linux gate and must be green; Vercel builds the Preview deployment against the release
   database.
7. **Preview smoke,** in the project owner's Chrome (the Preview deployment is behind Vercel
   Authentication): a guest upload of an unseen synthetic export, its result reopened, an evidence
   drilldown with Back, J4 by hand, `/api/health` (`commit` equals the release SHA; migrations end
   at 0037), and the `maxDuration` check (a 10,000-row stage plus dry run, and J4, finish well inside
   60 s). Preview measurements by Element Timing (§10). The smoke items are deleted ("Delete it
   now"). Then the cold review: a fresh agent driving the same Chrome, with no coaching, answering
   what counted on upload, why a decision was held and what the correction proved; every point it
   needed explained is fixed (a new commit, step 1 again) or recorded in `cold-review.md`.
8. **Promotion:** "set a variable" for Production (the release database); `PUBLIC_WORKSPACE=1` for
   Production; fast-forward git `main` to the release SHA and push it; Vercel builds Production.
   Then, against the public production URL: the step 7 smoke;
   `BASE_URL=https://revenue-signal-os-green.vercel.app npx playwright test -c tests/e2e/hosted.config.ts --grep @core`
   (J1, J2's two-context core, J4; no database access); production measurements (§10).
9. **Rollback, exercised once** (§9 "Verified once": the deployment step only), then the release
   re-aliased and smoked again.
10. **Record** a short B20 walkthrough (Playwright video) on the production URL if capture works;
    B09 stays the engineering follow-up.
11. **After release.** Every record made after the release SHA (files under
    `docs/agent-work/release/`: `checks/`, `states.md`, measurements, captures, `rehearsal.md`,
    `cold-review.md`, `flood.md`, the production runs, the recording) is committed in one docs-only
    commit on the git release branch and pushed there only. `main` stays at the release SHA, so
    Production runs exactly the verified commit; the docs reach `main` with the next merge.

**Implementation notes** (WP-J):
1. The release SHA is `af5a24e`. Step 1 ran in full on clean checkouts after each fix: `f84c61c`
   (every check passed: build, typecheck, lint, 1,083 unit and integration tests, eval 15/15,
   browser suite 144 passed and 1 skipped with the pixel baselines, B09 acceptance 177/177, BYOF
   54/54; `checks/release-f84c61c/`), `8ae6776` (the Preview smoke's sentence, the cold review's
   fixes and the hosted correction; the same results, `checks/release-8ae6776/`) and `af5a24e`
   (`checks/release-af5a24e/`). GitHub CI passed on `f84c61c` and `8ae6776` and failed once on
   `bd6acef`: an Overview definition a test had opened closed when September's deltas streamed in,
   because the whole tile row was one Suspense boundary. `af5a24e` streams each delta on its own.
2. The build mirror, checked out clean at the SHA, served as the release worktree; a second
   install was not needed. `rso-prev` holds the previous build `1814616` for the rehearsal.
3. Vercel refuses a git-branch variable until the branch exists on GitHub, so the order in step 5
   could not hold: the branch was pushed first, the two Preview variables added, and the Preview
   built before them redeployed. That build could only fail on the old database: the app runs no
   migration on boot or build.
4. Neon's default branch is named `production`, not `main`; `release-2026-11-18` was made from it
   with auto-delete off. The project's history window is 6 hours, now stated on `/onboarding`.
5. The cold review (`cold-review.md`) answered the upload and held-decision questions from the
   product alone, and found no correction to read: the hosted copy had none, and a guest cannot run
   one. `npm run db:correct-hosted` now runs B20's fix through the Action Center on the loaded copy
   (rehearsed on `revenue_signal_rehearse`, then run on the release branch), so a visitor reads an
   approved correction, what it changed and what it did not. Seven more points were fixed in
   `df7c0c3`; the rest are recorded there as follow-ups.
6. Preview smoke (`bd6acef`, then `8ae6776`): `/api/health` names the SHA and migrations to 0038;
   the Overview's verdict at 1,528 ms on the first load and 1,244, 808 and 792 ms after (goal
   1,500); a guest's unseen export read, compared, never counted, its ledger link and Back (scroll
   kept), reopened from the list; the chart's evidence and Back with the selection and focus
   restored; J4 by hand in about 8 s; a 10,000-row file staged in 1.4 s and dry-run in 2.2 s (limit
   60 s); every smoke item deleted.
7. Promotion (`af5a24e`): Production's `DATABASE_URL` record (shared with Preview) updated from
   Neon's copy button through `clipboard-to-stdout.ts`, `PUBLIC_WORKSPACE=1` added for Production,
   `main` fast-forwarded from `1814616` and pushed. `https://revenue-signal-os-green.vercel.app/api/health`
   then named `af5a24e…` with migrations to 0038. The hosted journeys (`--grep @core`, no database
   access) passed 7 of 7; the Overview's verdict as a guest, in fresh contexts: 1,012 ms first,
   856, 1,292 and 868 ms after (median 868; `measurements/production-after.json`).
8. Rollback, exercised once: `vercel rollback` to the previous production deployment took 23 s,
   and `/api/health` answered from `1814616` (no `commit` field) on its own database (migrations to
   0034). `vercel promote` of the release deployment took 10 s; `/api/health` named `af5a24e`
   again and the hosted journeys passed 7 of 7 again.
9. The B20 walkthrough (`recording/b20-walkthrough.webm`, `harness/record-b20.cjs`) runs as a guest
   on the production URL: the Overview, B20's trace, Decision Lab, the corrected incident's
   receipt, and the investigator's answer, whose question it deletes at the end.
