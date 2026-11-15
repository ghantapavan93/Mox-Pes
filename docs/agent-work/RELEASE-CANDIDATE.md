# Release candidate: local synthetic demo (2026-11-15)

The final acceptance pass for the synthetic proof-of-work. It started from `a6f8e4b` (the
delivery-outcomes pass).

## 1. The stale-delivery question: settled, one write boundary fixed

**Question.** Can a #679-style older revision of the same spend record, carrying another
campaign name and other classification inputs, change what the product reports?

**Method.**
- The expectations were written before any replay ran, and each capture records their sha256:
  - `release-candidate/stale-replay-expected.md`;
  - `release-candidate/stale-replay-expected-2.md`.
- The replays ran through the ads feed's polling path (`runStream`, `ads@1.2`) in the isolated
  `revenue_signal_b09` world, then the intake's consumers.
- Each facet was captured separately (`C:/Temp/rc-stale-capture.ts`):
  - the raw record;
  - the accepted spend row;
  - the campaign record;
  - the channel allocation;
  - the evidence trace;
  - the decision: verdicts, budget signal, gap status, incident and case;
  - the run's own row.

**Observed.** Captures are `release-candidate/stale-*.json`.

| Replay of Oct 20 (`pmax-lsa-B09`) | Spend, allocation, decision | Campaign record | Trace |
|---|---|---|---|
| Fetched 13:05 (#680). This is #679's fetch time, and fetch time is part of the version id | Unchanged. It was not stored: a payload conflict, which opens one unscoped medium item (#5723) | Unchanged | Unchanged |
| Fetched 13:07 (#681): its own older version, "B09 Coral \| Search", SEARCH inputs | **Unchanged.** Oct 20 stays #677's 12,091¢ at 13:10. Local Services 361,119¢, Search 1,017,687¢, B09 paid 1,664,923¢. Same verdicts, signal, verified gap, incident | **Rewritten:** "B09 Coral \| Search", `google_search`, SEARCH | Shows "B09 Coral \| Search" for spend filed as Local Services |

The dollars and the decision held. The campaign's own record did not. It feeds:
- the evidence trace;
- ChangeGuard's preflight;
- the AI investigator's campaign lookup;
- a coverage gap's successor evidence.

A believable but wrong label got through, and the run's row still said "No change".

**Cause.** The spend projection promises that every upsert is guarded by the source clock
(`lib/ingest/project.ts`). The campaign record was the one write without that guard. Any version
carrying the campaign rewrote it, in arrival order. The contract already orders versions:
VENDOR-CONTRACTS G-5 says "each fetch is a version, newest `fetchedAt` wins", and within one batch
the projection already took campaign fields from the newest fetch. No new ordering rule was
needed.

**Fix.** Only the write boundary changed.
- **Migration `0031`:** `ad_campaigns.source_updated_at`, the fetch time of the version whose fields
  the record holds.
- **The upsert:** it sets the name, channel and type only from a version at least that new. The
  Local Services flag stays OR-ed, which does not depend on order.
- **Why field by field:** the update always runs, so the spend insert still gets the campaign id.
  A guard on the whole update would drop that id, and an older-date backfill could no longer
  repair its own day.
- **The held-currency insert** also records the clock.
- **History:** the clock starts at the newest fetch each campaign's accepted spend rests on. A
  record an older version already rewrote is not repaired by the migration.

**Tests** (`b09-recovery.test.ts`, "the campaign record follows the newest fetch"):

| Case | Before the fix | After |
|---|---|---|
| An older revision with another name and Search inputs: stored, no change; each facet checked on its own | **Failed**: campaign became "B09 \| Search", `google_search`, SEARCH | Pass |
| A newer revision renames the campaign and files its own day | Pass | Pass |
| An older-date backfill (Oct 14, newer than its day, older than the rename) repairs its day | **Failed**: the day was repaired, but the name rolled back | Pass |
| Migration 0031 on history: wiped clocks rebuild exactly; applied again, nothing changes | (new) | Pass |

**On pre-0031 history.** This is the same B09 world, which carried the bad rename from #681.
- Migration 0031 gave all 156 campaigns a clock. The bad record stayed, as the migration says.
- Another older revision (#682, 13:08) then changed nothing.
- A newer fetch (#683, Oct 30 at 13:20) restored the record: "B09 Coral | Local Services
  (Performance Max, pay-per-lead)", `google_lsa`, PERFORMANCE_MAX. Its row reads "1 change to
  accepted records".

**Other suites.** Every other suite that touches ads or campaigns: 26 files, 377 passed, plus the
1 known expected failure (R-39).
