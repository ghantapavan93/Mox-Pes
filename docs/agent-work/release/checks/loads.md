# Database loads (WP-J step 5)

| Order | Target | Loaded from | Result |
|---|---|---|---|
| 1, the rehearsal | `revenue_signal_rehearse` (local rehearsal) | build mirror at `f84c61c` | 68 tables, 322,515 rows, identical to the local copy |
| 2, before the push | Neon project `revenue-signal`, branch `release-2026-11-18` (from `production`, auto-delete off), direct endpoint, app TLS `verify-full` | build mirror at `f84c61c`, `npm run db:load-hosted:clipboard` | 68 tables, 322,515 rows, identical to the local copy |

The release SHA moved to `bd6acef` after the load (one sentence on the upload result card).
`git diff --name-only f84c61c bd6acef -- database lib/sim` is empty, so the loaded data is the
release's and the branch was not loaded again.

Variables (Vercel project `revenue-signal-os`, Preview, git branch
`feature/audit-enterprise-redesign`): `DATABASE_URL` piped from the clipboard
(`scripts/clipboard-to-stdout.ts`, stored as a secret; the clipboard was cleared after) and
`PUBLIC_WORKSPACE=1`. Vercel refuses a branch-scoped variable until the branch exists on GitHub,
so the branch was pushed first, and the Preview built before the variables existed was redeployed.
That first build could only fail on the old database: the app runs no migration on boot or build.

The Neon project's history window is 6 hours (Settings, Postgres): deleted workspace rows stay
that long in Neon's change history, as `/onboarding` now says.
