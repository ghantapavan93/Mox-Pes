# Hold to decision: run it locally

A guide to the B09 workflow on your own machine (`HOLD-TO-DECISION.md`). It uses an isolated
synthetic world: its own database and its own server port. It never touches the demo database
(`revenue_signal`), and it never reuses a server that is already running.

The world moves forward only by **simulated source deliveries**. Each one re-sends the source's own
records through the ads feed's polling path, the path the worker uses, and then runs reconciliation.
Nothing is written to the product's tables directly. Nothing here is a control the product offers.

All data is synthetic. B09 is a made-up branch with made-up dates and amounts.

## Setup, once

You need:
- Node 22;
- Postgres 17 at `127.0.0.1:54333` (`docker compose up -d` provides it);
- a free port (3992 is used below).

```bash
npm ci
```

## 1. A fresh world

This takes about a minute. The name must be `revenue_signal_acceptance_<something>`; the script
refuses any other database.

```bash
export ACCEPTANCE_DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_acceptance_walk
```

```bash
npx tsx tests/acceptance/b09/prepare.ts
```

In PowerShell, set the variable with
`$env:ACCEPTANCE_DATABASE_URL = "postgres://postgres@127.0.0.1:54333/revenue_signal_acceptance_walk"`.

## 2. The server, in a second terminal

```bash
npm run build
```

```bash
DEMO_MODE=1 DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_acceptance_walk npm run start -- -p 3992
```

Open http://localhost:3992. The role menu is in the header. Use **Marketing analyst** unless a step
says otherwise.

## 3. Advance the world, one delivery at a time

Each command prints:
- what the source sent;
- the run it arrived in;
- what intake did with it;
- where B09's October decision stands.

Reload the page after each one.

| Step | Command | Where to look | What a reader should see |
|---|---|---|---|
| Missing | none (the fresh world) | Overview, `?period=oct&branch=B09` | **Hold the budget decision.** No Google Local Services spend record on any of the 18 dates, Oct 13–Oct 30. The daily records say "no spend record", never $0.00 |
| Partial | `npx tsx tests/acceptance/b09/advance.ts partial` | Overview, then the incident | **Still on hold · 5 of 18 days verified.** Oct 26–Oct 30 are covered; Oct 13–Oct 25 still have no record. The one next action opens the records for Oct 12–Oct 18 |
| Verified | `npx tsx tests/acceptance/b09/advance.ts rest` | Incident, then Decision Lab | **Coverage hold cleared · 18 of 18 days verified.** $2,123.52 moved from Google Search to Google Local Services, no amount changed, and B09's October paid spend stayed $16,649.23. Decision Lab says "Ready for review" and "Nothing here approves a budget change", with the checks still open |
| Refused | `npx tsx tests/acceptance/b09/advance.ts refused` | Overview, daily evidence for Oct 19–Oct 25, the new incident, Decision Lab | **Hold the budget decision** again. A newer Oct 20 revision ($400.00, 2.5 conversions) was refused. The ledger still counts the earlier $120.91, and Oct 20 is not confirmed. The coverage hold stays cleared, and the two are told apart |
| No change | `npx tsx tests/acceptance/b09/advance.ts refusedAgain olderWhileHeld acceptedAgain` | Same pages | Nothing moves: the same incident, the same revision, the same amounts |
| Second hold | `npx tsx tests/acceptance/b09/advance.ts refusedOther` | Decision Lab | Two holds: Oct 20, and Oct 22 (billed in CAD) |
| Correction | `npx tsx tests/acceptance/b09/advance.ts corrected` | The Oct 20 incident, the coverage-gap incident, Decision Lab | The Oct 20 hold lifts. It names the delivery run and shows $120.91 becoming $400.00, and B09's October total moves +$279.09. The Oct 22 hold stays. The coverage gap no longer says "reclassified, not added", because an amount changed |

Optional steps, each on its own fresh world:
- `sharedAccount`: B10's campaign in the ad account it shares with B09 holds B10 only.
- `september`: a September date holds September only.
- `unmapped` and `unidentified`: these hold no branch, and say so.
- `heldDay`: a day the ledger never counted. Held spend shows as a limitation in verified readiness,
  not as a hold (N1).
- `regression`: Oct 20 filed as Search again reopens the same coverage gap, with its earlier
  verification kept as history.

Where B09's October decision stands, without a browser:

```bash
npx tsx tests/acceptance/b09/advance.ts --status
```

## 4. The proof, end to end

The runner seeds its own world (`revenue_signal_acceptance`), builds, serves on port 3990 and walks
every state above. It also checks scope, Back, keyboard and the independent ledger. The record lands
in `test-results/acceptance-b09/results.json`.

```bash
npm run acceptance:b09
```

## About the scenario

Google is moving eligible Local Services Ads advertisers to Performance Max campaigns with
pay-per-lead goals (Google Ads Help, "Local Services Ads transition to Performance Max campaigns
with pay-per-lead goals", https://support.google.com/google-ads/answer/17213585). B09 is a synthetic
scenario in which **our** older mapper filed the migrated campaign's spend under Google Search.
Google did not classify it as Search.

For these campaigns, Google describes assessing lead quality over a 30-day period and says manual
lead disputes are no longer supported (https://support.google.com/google-ads/answer/18550592).
Nothing in this workflow disputes leads or tracks a filing deadline.
