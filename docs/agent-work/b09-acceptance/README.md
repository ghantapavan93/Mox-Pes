# B09 acceptance runner: the recorded run (2026-11-15)

The repo's own proof (`B09-ACCEPTANCE-RUNNER.md`), run once from a fresh worktree under hostile
settings.

| | |
|---|---|
| Commit | `23617ca` (`23617caf0e1184d393d27436306518f049689e27`), no tracked file changed |
| Where | A fresh worktree: `git worktree add --detach C:/Temp/rso-r55 23617ca`, then `npm ci` (exit 0, 44 s) |
| Command | `npm run acceptance:b09`, run as `DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal npm run acceptance:b09` to show that `DATABASE_URL` is ignored |
| What it used | Build `2HGwI6kXm6Yc1STg5P97v`, built by the runner. Server `http://localhost:3990`, started by the runner. Database `revenue_signal_acceptance`, dropped beforehand and created by the runner |
| Versions | Postgres 17.8, Node 22.14.0, Playwright 1.64.1, Next.js 16.4.3 |
| Result | **Exit 0 in 235 s:** seed 73 s, build and start, then the proof (1.8 min). **97 of 97 checks; 0 console or page errors** |

## What held (`results.json`)

| Stage | Checks | What |
|---|---|---|
| missing | 11 | One open coverage gap at B09 (#2455), no correction delivered yet. The Overview, opened with no ids, lists the hold. Missing days read "no spend record", never $0.00. The incident and Decision Lab say held |
| partial | 11 | Run #676 (Oct 26–30). 5 of 18 dates covered; the same incident still open; every view still says held |
| verified | 19 | Run #677 (Oct 13–25). 18 of 18 covered; "Reclassified, not added: the $2,123.52…" on the Overview and the incident. Decision Lab: "Ready for review", "Nothing here approves a budget change", #970 and the door-to-door conflicts. Run #677's row: Stored 13; 13 changes; used by the verification |
| replays | 13 | #678 (the same versions again), #679 (an older Oct 20 fetch, $50 higher) and #680 (the same, carrying a Search campaign's name and inputs). Money, customers, cash, the incident, its case and the campaign record are unchanged. The five run rows read as recorded. The seed's failed run says "Effect not recorded" |
| ledger | 38 | What the source sent against what the product recorded. Each run's stored versions and counts; the 18 accepted days; the verification (#677 then #676, 212,352¢); the five labels. B09's paid spend is 1,664,923¢ in every state, and Local Services gained exactly what Search lost. One case, never reopened; nothing opened |
| scope | 4 | The core B09 resources carry evidence for the analyst. 61 routes; leaks: 0 |
| errors | 1 | No console or page errors |

**Scope, in numbers.** Of 61 routes, 31 carry B09 evidence for the analyst and so prove a
refusal: 62 denied requests, each paired with the analyst's allowed request for the same route.
The other 30 carry no B09 evidence for either role and are counted apart. The numbers match the
acceptance audit's sweep (`BIVE-ACCEPTANCE.md` R4). How the 62 denied requests answered:
- the 44 on pages: 200, without evidence (R-33);
- 10 on APIs: 200, with the data filtered to the role's scope (the answer-check list, search,
  verdicts);
- the other 8 on APIs: 403 or 404, 4 of each.

## Hostile settings (`proof.log`)

- **Port 3000** was held by a sentinel that logs every request (`harness/r55-port3000-sentinel.js`).
  None reached it.
- **`DATABASE_URL`** pointed at the demo database. Its content was the same before and after:
  the latest run, raw events, audit rows, latest event, answer checks, incidents and the clock.
  So were its write counters (`pg_stat_database`).
- **The acceptance database** was dropped first, and the runner created it.

## Refusals (`refusals.log`)

From the same worktree, each case stopped within 1–4 s, before seeding or serving, with exit 1:
1. **The demo database** as `ACCEPTANCE_DATABASE_URL`: "the database is "revenue_signal"…".
2. **`ACCEPTANCE_PORT=3000`.**
3. **A busy port 3990,** through the documented command: prepare.ts refuses before seeding.
4. **The same busy port, Playwright alone:** its own guard (`reuseExistingServer: false`) stops it:
   "http://localhost:3990 is already used…". No HTTP request reached the sentinel holding 3990.

**An unplanned refusal, earlier.** The first development run, in the main checkout, refused
because an unrelated local server was already listening on 3900, the default then. The runner did
not use it. The default moved to 3990.

## Files

| File | What |
|---|---|
| `results.json` | The runner's record: commit, build, command, every check, facts per state, the ledger, each scope pair |
| `report.json` | Playwright's report |
| `runner-output.txt` | The command's console output: seed, build, server, result (the machine's LAN address redacted) |
| `proof.log`, `refusals.log` | The hostile run and the refusals, with exit codes and timings |
| `harness/` | The evidence harness that set up the hostile settings, exactly as run. It is not needed to rerun the proof |

**To rerun:** `npm ci`, then `npm run acceptance:b09` (`B09-ACCEPTANCE-RUNNER.md`).
