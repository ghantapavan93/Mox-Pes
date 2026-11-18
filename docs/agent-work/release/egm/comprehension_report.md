# EGM Stage 6: comprehension report

- **Target:** `docs/agent-work/release/RELEASE-DESIGN.md` version 2 (lines 1–1091), read alone
- **Reviewer:** `egm:egm-comprehension`, fresh context, no other file, no standard
- **Date:** 2026-11-18
- **Verdict:** 1 Blocker, 9 Major, 2 Nit. Resolutions: [`resolution_log.md`](resolution_log.md).

**What this proposes**

A release plan for Revenue Signal OS, a demo that reconciles synthetic marketing and sales data for
a 44-branch pest-control company and holds a budget decision when its evidence is incomplete. When
`PUBLIC_SANDBOX_UPLOADS=1` is set, an anonymous guest gets a `sandbox` permission and can upload,
map and dry-run a file, or ask the deterministic investigator. Each of these "previews" is owned by
a hashed cookie token, kept out of the audit log, never publishable, limited in rate and size, and
deleted after 24 wall-clock hours. The plan also adds: links from each result row to the ledger
record it matched; CRM sync jobs that write `ingestion_runs`, plus three more named data times; one
button primitive and one request hook; Back and focus restore on the chart, and state badges; an
Ollama profile that falls back to the deterministic path on any failure; a faster Overview and
fixes for the failing Linux CI. To release, it loads a new Neon branch, verifies a Vercel Preview
against it, points Production at it, and keeps Neon `main` and the old deployment as the rollback.

**How the existing system works, per this document**

Without `DEMO_MODE`, every hosted visitor is a guest with no permissions, so nobody can upload or
use the investigator. Staff onboarding goes stage, propose mapping, dry run, approval by a
different role, then one publish. Only call and web-lead files count, mappings are shared across
uploads with the same layout, and every step writes the public, append-only `audit_log`.
Onboarding times use a business clock frozen at 2026-10-31 13:00 UTC on the hosted copy. "Data as
of" ignores CRM syncs and publications because neither writes an `ingestion_runs` row. Production
runs `1814616` with one sensitive `DATABASE_URL` shared by Production and Preview, against Neon
`main` on migration 0034 with stale incident evidence. Seven Linux CI specs fail.

## Findings

1. **Blocker. §5.11 Secrets; §9 Rollback; WP-J step 8; §11 last row.** The "clipboard path" is the
   only procedure given for setting `DATABASE_URL`, and its step 2 seeds and restores data into the
   target branch, so promotion would reload the verified branch and rollback would overwrite
   `main`. Missing: how the variable shared by Production and Preview is split or replaced, and who
   does the Neon step. Fix: two procedures, "load a branch" and "set a variable"; promotion and
   rollback use only the second; name who does each step.
2. **Major. §9 "Verified"; WP-J step 9.** Build `1814616` has no `/api/health.commit`, and the full
   `VERCEL_GIT_COMMIT_SHA` is compared with a short SHA. Fix: confirm the rollback by deployment id
   or by the old response shape plus a migration list ending at 0034; compare SHAs by prefix.
3. **Major. Guest/staff boundary.** How a request becomes a staff role is never said; "a staff
   install" implies authentication; read literally, `getViewer()` makes every viewer a guest when
   the flag is on, yet J3 acts as engineer and approver with the flag on. Fix: one paragraph on
   viewer resolution, in precedence order, with the allowed flag combinations; define "staff" and
   "company" once.
4. **Major. Ownership of child rows.** Only parents get `sandbox_owner`; how reads of rows, dry
   runs, row results and steps are scoped is left to guess; the stored key form is inconsistent
   (`visitor:<hash>` vs the bare hash). Fix: children inherit the parent's owner, every child read
   goes through its parent; state the exact stored form.
5. **Major. Clocks.** Staff times use the frozen business clock, previews database `now()`;
   "deleted at publication" contradicts the purge that keeps profiles and dispositions; which clock
   `stageUpload({ now })` receives and which clock and time zone the displayed times use are
   unclear. Fix: a table per upload kind: creation and expiry clock, trigger, removed, kept,
   display zone.
6. **Major. Lifecycle gaps.** A cookie set once for 24 hours dies before a late preview; nothing
   deletes expired investigations; whether investigations share the upload limits is unstated;
   whether dry-run result rows count against the budget is unstated. Fix: answer each; add an
   investigations row to the limits.
7. **Major. Data times.** "Four times" but `dataTimes()` returns three; "every stream has succeeded
   since" has no object; the frozen hosted clock and the local clock's movement are unstated; the
   stored fact behind "inserted at least one raw event" is unnamed; "polling run" undefined. Fix:
   say what `/audit` shows, use the test's wording, give the expected hosted values, name the
   stored fact, define the term.
8. **Major. "Preview" and "promote" each have two meanings** (a visitor's sandbox item and Vercel's
   Preview environment; setting variables plus fast-forwarding `main`, `vercel promote`, and
   "B09 stays unpromoted"). Fix: rename one meaning of each; define promotion once.
9. **Major. Implementation order.** WP-A "(primitives only)" leaves its later steps unplaced; WP-D
   tests use `dataTimes()` that WP-B adds later; no package owns the route audit; WP-I's time box
   and its "branch head" repro conflict with the order; migration 0036 and the hold hardening are
   in no package; files have two owners. Fix: a dependency table (package, needs, produces).
10. **Major. Which commit is released.** Freeze happens before commits; records and `deploy.md` are
    written after promotion; every push to `main` builds Production. Fix: define the release SHA,
    move `deploy.md` before the freeze, and say where post-release records are committed and
    whether they deploy.
11. **Nit. §9 rehearsal step 3** is hard to parse: deployments keep their environment, so in this
    rollback old code never meets the new schema. Say what step 3 protects.
12. **Nit. Undefined references:** EGM and its stages, "zoom-out blocker", "the brief", "Codex task
    X1", "BYOF", "five frozen eval packs", "the hold hardening", "partner" role, "approved hint",
    "spec hash", "the outbox"/"the worker", "release regression", `NONE`; "busy" means both eviction
    and the 429. Fix: a one-line gloss each.
