# Stale replay: expected before running (2026-11-15)

Written before the replay ran. The capture script records this file's sha256 with each capture.

## The replay

- **World:** the isolated `revenue_signal_b09`, after the four B09 deliveries #676–#679.
- **Path:** the ads feed's polling path (`runStream`, active mapper `ads@1.2`), then the intake's
  consumers. This is `C:/Temp/b09-correct.ts stale`, the same tool that made #676–#679.
- **The record:** `pmax-lsa-B09`, Oct 20, like #679:
  - fetched 13:05, older than the accepted 13:10 revision from #677;
  - $50 more;
  - another campaign name: "B09 Coral | Search";
  - other classification inputs: `campaignType` SEARCH, `localServicesEnabled` false. On their own,
    `ads@1.2` files these inputs as Google Search.
- **The contract:** VENDOR-CONTRACTS G-5 says "each fetch is a version, newest `fetchedAt` wins".
  Within a batch, the projection already applies this to campaign fields (newest `fetchedAt`
  first). The campaign fields arrive inside the same spend version.

## Expected, if the data stays authoritative

| Facet | Expected after the replay |
|---|---|
| Raw record | One new version of `google_ads:pmax-lsa-B09:2026-10-20` (fetched 13:05, 17,091¢, the new name and inputs), stored by the new run. The four earlier versions are unchanged |
| Accepted spend row (Oct 20) | Unchanged: raw event 200027 from run #677, fetched 13:10, 12,091¢, `google_lsa` |
| Campaign record (id 8677) | Unchanged: name "B09 Coral \| Local Services (Performance Max, pay-per-lead)", channel `google_lsa`, type PERFORMANCE_MAX, Local Services on |
| Channel allocation (B09, Oct) | Unchanged: Local Services 361,119¢, Search 1,017,687¢, paid spend 1,664,923¢; company spend unchanged |
| Run outcome | Stored 1, 0 changes. "No change to accepted records", then "Stored, but a newer revision was already accepted". No verification names it |
| Evidence trace (B09 paid spend, Oct) | Unchanged, including the campaign's name and channel |
| Decision | Unchanged. #2455 stays resolved, with one verification and none before it. The gap status stays verified ("Reclassified, not added"). B09's budget signal and verdicts are unchanged, except freshness fields that move with the delivery time. Nothing is opened |

## What the code was expected to do (from reading `lib/ingest/project.ts`)

- The spend-day upsert is guarded by the source clock, so the row stays.
- The campaign upsert in the same statement has no guard across batches. An older fetch rewrites:
  - the name;
  - the channel (`google_search`);
  - the campaign type (SEARCH).
- Local Services stays on, because the flag is OR-ed.
- If the capture shows this, the old delivery changes authoritative campaign metadata. Then the
  campaign write boundary gets the same newest-`fetchedAt` guard the contract already applies.
