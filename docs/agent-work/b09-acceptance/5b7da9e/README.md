# B09 acceptance runner: the second recorded run (2026-11-15)

The run was from a fresh worktree at `5b7da9e`, following only the checked-in instructions
(`B09-ACCEPTANCE-RUNNER.md`, "What it needs"). This commit checks the mission's claims directly:
- **missing is not zero,** on the incident's CRM card too;
- **reclassified, not added,** row by row;
- **accepted evidence identical** after each replay.

The first run, at `23617ca`, is kept as it was in `../README.md`.

| | |
|---|---|
| Commit | `5b7da9e` (`5b7da9e0c499dca4f02fafd1aad2ea15fceb1e12`), no tracked file changed |
| Steps | `git worktree add --detach C:/Temp/rso-r55b 5b7da9e`, then the documented steps: `npm ci` (exit 0, 33 s), `npx playwright install chromium` (exit 0, 4 s, already installed), `npm run acceptance:b09`. Postgres already ran at 127.0.0.1:54333, so `docker compose up -d` was not needed |
| Hostile settings | A sentinel held port 3000; `DATABASE_URL` pointed at the demo database; the acceptance database was dropped first |
| What it used | Build `-_ytbZ3XRKZUV0-ZB36dM`; server `http://localhost:3990`; database `revenue_signal_acceptance`, created by the runner |
| Result | **Exit 0 in 189 s. 108 of 108 checks; 0 console or page errors** |

## The mission's claims, each checked directly (`results.json`)

| Claim | Checks |
|---|---|
| Missing records are not zero | missing (13): the missing days read "no spend record", never $0.00. The daily evidence says "That is no record, not $0". The incident's CRM card says the channel "has no spend record for some or all of those dates", and the page never calls missing spend zero |
| 5 of 18 dates still hold the decision | partial (13): run #676 covers Oct 26–30. "Decision still held. 5 of 18 dates…" on the Overview, the incident and Decision Lab. The same incident #2455 stays open |
| All 18 verified dates reconcile the $2,123.52 reclassification without adding spend | verified (23): run #677 covers Oct 13–25. Each of pmax-lsa-B09's 18 accepted days moved from Google Search to Google Local Services with the same cents, 212,352¢ in all. Company-wide accepted spend kept its total (11,422 days). The ledger agrees: covered = 212,352¢; B09's paid spend is 1,664,923¢ in every state |
| Duplicate and stale replays leave accepted evidence unchanged | replays (16): after #678 (duplicate), #679 (older, $50 higher) and #680 (older, as a Search campaign), every accepted spend day company-wide is identical, row for row: campaign, date, channel, cents and source version. Money, the incident, its case and the campaign record are unchanged too |
| Each denial paired with an allowed request | scope (4): 31 routes carry B09 evidence for the analyst. On each, the partner's and the brand lead's requests received none: 62 denied requests, each paired. 0 leaks |
| Routes with no evidence for either role, counted apart | 30 of 61 |

The ledger (38 checks) compares what the source sent with the runs, versions, accepted days,
verification and labels, as in the first run.

## Isolation and refusals

- **`proof.log`:** the demo database's content and write counters did not change, and no request
  reached port 3000.
- **`refusals.log`:** at this commit, four cases each stopped with exit 1 before seeding or
  serving: the demo database, port 3000, a busy port through the command, and a busy port through
  Playwright alone. No HTTP request reached the sentinel holding port 3990.

## Files

`results.json` and `report.json` are the runner's record and Playwright's report.
`runner-output.txt` is the console output, with the LAN address redacted. `proof.log` and
`refusals.log` are the logs. `harness/` is the evidence harness, exactly as run; it is not needed
to rerun the proof.
