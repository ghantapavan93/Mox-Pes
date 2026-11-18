# Release rehearsal (WP-J step 4), 2026-11-18

Exactly what the release does to Neon, done first to a disposable local database
(`revenue_signal_rehearse`), from the build mirror checked out clean at the release candidate
`f84c61c` (the design names a separate worktree, `C:/Temp/rso-release-sha`; the mirror at the SHA,
after `git clean -fdx -e node_modules`, is the same tree and saved a second install). The runner
is `C:/Temp/rso-rehearsal.sh`; its logs are summarised here.

| Step | Command | Result |
|---|---|---|
| Load | `ALLOW_LOCAL_TARGET=1 HOSTED_DATABASE_URL=…/revenue_signal_rehearse npm run db:load-hosted` | Seeded, dumped, restored in one transaction: 68 tables, 322,515 rows, identical to the local copy |
| Release build | `DATABASE_URL=…/revenue_signal_rehearse PUBLIC_WORKSPACE=1 npx next start -p 3991` (no `DEMO_MODE`) | `/api/health`: `ok`, migrations 0001–0038, `commit` null (a local build) |
| J1, J2, J4 as a guest | `BASE_URL=http://localhost:3991 DATABASE_URL=… npx playwright test -c tests/e2e/hosted.config.ts --grep "@core\|@edge"` | 8 passed (27.4 s) |
| Flood | `npx tsx docs/agent-work/release/harness/flood-workspace.ts http://localhost:3991` | 105 uploads of 10,000 rows from new visitors in 3 minutes: 5 accepted, 95 refused by the rows-per-minute quota (429), 5 by the held-row budget (503); median answer 29 ms, slowest 377 ms; 15 MB of WAL (`flood.md`) |
| Workspace items | Two uploads and two questions from new visitors, by HTTP | Both questions stored (201). Both uploads refused "The public demo is full right now" (503): the flood had just filled the 100,000-row budget, and no item was older than the 30-minute residency, as designed. The flood's own 5 uploads stood in for them |
| Previous build | `1814616` in `C:/Temp/rso-prev` (`npm ci`, `next build`), `DATABASE_URL=…/revenue_signal_rehearse npx next start -p 3992`, then `node harness/prev-build-check.cjs http://localhost:3992` | Every check passed: `/`, `/decisions?branch=B20`, `/exceptions`, `/onboarding` and `/investigator` answer 200 with their verdicts; none links any of the 5 workspace uploads or 3 workspace questions; `/api/investigations` lists none; `/investigator/<id>` shows none |

What it proves: the loader produces the same database every time (the Neon load gave the same
68 tables and 322,515 rows), the release serves a guest end to end on it, the quotas and budget
hold a scripted flood without slowing answers, and migrations 0035–0038 leave the previous build
working on the new database, without showing it anything a visitor stored.
