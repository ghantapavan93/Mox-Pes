# Stale replay: addendum, written before the second replay (2026-11-15)

## What the first replay was

The first replay (`stale-replay-expected.md`, run #680) used fetch time 13:05. That is #679's fetch
time, and the fetch time is part of a spend version's identity: `spend_day:<platform>:<campaign>:<date>:<fetchedAt>`.
So it was not a new older revision. It was a second, different payload for a version already
stored: a payload conflict.

What it did (`stale-before.json` → `stale-after-old-code.json`):
- It stored nothing. The stored version was kept.
- It changed nothing in the raw records, accepted rows, campaign record, allocation or trace.
- It opened one payload-conflict exception (#5723: medium, no branch) and its case.
- Its row reads "No change to accepted records" and "Nothing new stored".

## The second replay

- **The record:** the same spend record, Oct 20, with its own fetch time of **13:07**. That is
  older than the accepted 13:10 (#677) and newer than #679's 13:05.
- **The rest is as before:** $50 more, name "B09 Coral | Search", `campaignType` SEARCH,
  `localServicesEnabled` false.
- **The tool:** `b09-correct.ts stale2`.

## Expected, if the data stays authoritative

The same as `stale-replay-expected.md`, with these differences:
- **Raw record:** one new version (fetched 13:07), stored by the new run.
- **Run outcome:** stored 1, 0 changes: "No change to accepted records", then "Stored, but a newer
  revision was already accepted".
- **Exceptions:** nothing new beyond the conflict #680 opened.

## Predicted from the code

The accepted row stays (it is guarded by the source clock). The campaign record is rewritten:
the name, the channel (`google_search`) and the type (SEARCH). Local Services stays on (the flag is
OR-ed).
