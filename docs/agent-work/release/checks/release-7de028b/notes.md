# Release checks: `7de028b`, then `8bbf37c`

The B20 receipt follow-up: `613d09e` (the investigator answers B20's jump from its verified
receipt), `7de028b` (the receipt reads as a completed repair). `8bbf37c` changes one test assertion
and no product code, so these local checks on `7de028b` hold for it; CI ran on both.

| Check | Result |
|---|---|
| Clean checkout of `7de028b`: npm ci, build, typecheck, lint | pass |
| Vitest | 99 files, 1,088 passed + 1 expected failure (`vitest.txt`) |
| AI eval, deterministic | 15/15, tool precision 99.0%, recall 100% (unchanged) |
| Acceptance: B09, BYOF | pass |
| Browser suite, local | 138 passed, 2 failed, 4 did not run, 1 skipped (`e2e.txt`) |
| Browser suite, CI on `7de028b` | 139 passed, 1 failed: J4 (below) |

**The two local failures** are one race: after an Action Center action on B20 (the dry run in
`os-golden-path`, then Approve in J3), the test waits 5 s for the page's server refresh. The page
snapshot taken at the failure shows the expected rows, rendered after the window. The same specs
pass alone (30/30) and on CI. The code they exercise is unchanged by this release: the receipt
returns before any query for an open incident.

**The CI failure** was the J4 assertion of today's figure. In the full suite, `os-modules` syncs
more B20 customers after the repair, so the scorecard read $261.96 (÷ 58) while the receipt still
read $490.11 and 31 → 56: the answer told history from the receipt and the present from the
scorecard, as designed. `8bbf37c` asserts $271.31 on the hosted copy only, where the data cannot
move, and still asserts every receipt figure.

**Promotion.** CI green on `8bbf37c` (40 min); the Preview served it (`/api/health` commit
matched, receipt copy present). `main` was fast-forwarded from `af5a24e` to `8bbf37c`; production
served it 50 s later on the same Neon release branch, with no variable or data change. Hosted
journeys on production: 7/7 (`--grep @core`), J4 asserting the receipt figures and $271.31. The
rollback is `vercel rollback` to the `af5a24e` deployment.

**Preview** (`7de028b`, release database, guest): `/api/health` commit matched; the receipt read in
the past tense with the arithmetic, the unchanged spend to the cent and "What was approved: the
repair only, not a budget move"; "Why did B20's CAC jump in October?" answered from `proposal:1`
and `exception:1063` with today's $271.31 from the scorecard, 9 claims supported, none rejected;
the `proposal:1` citation opened its receipt at `/exceptions/1063`; the question was deleted.
