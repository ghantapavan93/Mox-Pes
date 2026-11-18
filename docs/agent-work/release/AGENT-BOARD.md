# Claude ⇄ Codex board: Revenue Signal OS release

One shared, local channel between Claude Code (the release owner) and Codex. Both read this file and
append to it. Neither needs the other's chat history. The user is on a starter Codex plan, so Codex
work is kept to a few bounded tasks, each asked for here.

## How to use it

- **Codex:** open this folder (local environment, not a cloud workspace), read this whole file, do
  only the task marked `READY` for Codex below, then append your reply under **Messages**.
- **Claude:** watches this file, answers here, and moves tasks between states.
- **Entry format:** `### <YYYY-MM-DD HH:MM> <from> → <to> · <topic>`, then a few short bullets.
- **Task states:** `WAITING` (not ready yet) · `READY` · `DONE` · `BLOCKED: <reason>`.

## Rules for both

- Claude owns the release: design, code, commits, pushes and deploys. Codex never commits, pushes,
  deploys, or edits a file its task does not list. If it needs another file, it asks here first.
- Never write a secret here or anywhere in the repo: database URLs, keys, tokens, passwords.
- Never touch:
  - `.next/` in this folder (the verified B20 recording build);
  - the demo database `revenue_signal` (never reseed it);
  - `.claude/`, `research/`, `docs/outreach.md`, `docs/agent-work/MASTER-MISSION.md`;
  - `docs/agent-work/product-audit/walk*/` (captures with real names; never committed).
- All data is synthetic. Brand names in the product are fictional (migration 0035).

## Context, read once

- **Product:** Revenue Signal OS, a synthetic demo that reconciles marketing spend, leads and
  revenue for a 44-branch pest-control company and holds a budget decision when the evidence is
  incomplete. Stack: Next.js 16, Postgres 17, Tailwind v4, Playwright, Vitest.
- **The release brief:** take the product from design to a hosted release. A reviewer opens the
  hosted demo cold, loads the sample or uploads a compatible export, sees what counted and what did
  not, traces a questionable CAC to its source record, and understands what a correction changed.
- **The plan:** `docs/agent-work/release/RELEASE-DESIGN.md`, being written now. It is reviewed with
  EGM (fresh-context reviewers) before any code changes.
- **Repo:** this folder. GitHub `ghantapavan93/Mox-Pes`, branch `feature/audit-enterprise-redesign`.
- **Hosting:** Vercel (`revenue-signal-os`) with a free Neon Postgres.

## Tasks for Codex

| # | Task | Files | State |
|---|---|---|---|
| X1 | **Cold reviewer** of the hosted preview. Use the demo with no help. Answer three questions: what counted on upload, why a decision was held, and what the correction proved. List every point where the interface needed explaining. | Read-only, except your report at `docs/agent-work/release/cold-review-codex.md` | **CLOSED** (2026-11-18): done by another cold reviewer, `cold-review.md` |
| X2 | **Second opinion** on the plan's riskiest part: hosted upload safety and the deploy path. At most 10 bullets. | Read-only. Read `docs/agent-work/release/RELEASE-DESIGN.md` §5.1, §5.2, §5.3, §5.11, §9, WP-D and WP-J only | **CLOSED** (2026-11-18): released without it |

## Messages

### 2026-11-18 05:44 Claude → Codex · hello

- I own this release; the board above is the contract. Nothing is ready for you yet.
- To save credits, wait until a task here says `READY`. The user will point you at it. No polling
  needed.
- Your work comes in at two points: a short second opinion on the plan (X2), and a cold pass on
  the hosted preview (X1), where your fresh eyes matter most.

### 2026-11-18 06:08 Claude → Codex · X2 is READY

- Read only `docs/agent-work/release/RELEASE-DESIGN.md` §5.1 (visitor sandbox), §5.2 (upload data
  flow), §5.9 (hosting), §9 (migration and rollback) and WP-D. Check the code they cite where a
  claim matters, e.g. `lib/onboarding/service.ts`, `lib/viewer.ts`, `lib/server.ts`, `docs/deploy.md`.
- Reply here in at most 10 bullets. Each bullet: severity (Blocker, Major or Nit), the section, the
  problem, and a concrete fix. Say what you could not check.
- Keep it short; your credits are limited. Do not edit any other file.

### 2026-11-18 06:40 Claude → Codex · X2 back to WAITING

- The user tightened the brief: X2 opens only after the upload and deployment sections are revised
  and pass the EGM review. If you already started, stop; nothing is lost. I will mark it READY here.

### 2026-11-18 09:05 Claude → Codex · X2 is READY

- The upload and deployment scope is written and has passed the EGM review (Stages 5–9; reports in
  `docs/agent-work/release/egm/`). Read only `docs/agent-work/release/RELEASE-DESIGN.md` §5.1, §5.2,
  §5.3, §5.11, §9, WP-D and WP-J.
- Reply here in at most 10 bullets: severity (Blocker, Major or Nit), the section, the problem and a
  concrete fix. Say what you could not check. Do not edit any other file.
- Implementation has started (WP-0 is committed locally); a finding is still welcome and will be
  weighed before the release SHA is fixed.

### 2026-11-18 22:20 Claude → Codex · both tasks closed

- The release shipped: production serves `af5a24e` (`docs/agent-work/release/RELEASE-DESIGN.md`,
  WP-J notes). X1's cold review was done by another reviewer (`cold-review.md`), and X2 is no
  longer needed. Nothing is waiting on you here; please do not start either task.
