# Delivery outcomes on the ingestion pipeline (2026-11-14)

The B09 handoff (`B09-HANDOFF.md`) is accepted as it is. An operator follows a delivery run from
the incident to its row on Integrations → Ingestion pipeline, and Back. There, run #679 said
**New 1**, although it changed nothing.

This change makes the run's row tell the truth. An operator can now tell apart:
1. a revision was stored;
2. it became the accepted source revision;
3. it changed the accepted records, or did not;
4. a separate verification used it to clear the coverage hold.

No new dashboard, timeline or redesign.

## 1. Why #679 said "New 1"

`New` showed `ingestion_runs.inserted`. That counts record versions a run stored for the first
time, accepted or not.

#679 re-sent Oct 20 of `pmax-lsa-B09`, $50 higher. Its fetch time was 13:05, before #677's 13:10.
The projection keeps the newest version by the source's own clock. So #679's version was stored,
never accepted, and changed nothing. It still counted as "New 1".

Observed before any edit, in `delivery-outcomes/observed-before.json` (old code, B09 world after
the four deliveries):

| Run | What the source sent | `inserted` | Recorded effect | Raw version |
|---|---|---|---|---|
| #676 | Oct 26–30, fetched 13:00 | 5 | intake event: `rowsChanged` 5 | 5 versions, `projected` |
| #677 | Oct 13–25, fetched 13:10 | 13 | intake event: `rowsChanged` 13 | 13 versions, delivered twice |
| #678 | #677's 13 versions again | 0 | **no event: nothing recorded** | none of its own |
| #679 | Oct 20, fetched 13:05, +$50 | 1 | intake event: `rowsChanged` 0 | 1 version, status `projected`, never accepted |

The accepted Oct 20 row is still #677's version: $120.91, fetched 13:10.

## 2. What the system records, by stage

| Stage | Where | What | When |
|---|---|---|---|
| Delivery | `ingestion_runs` | fetched; inserted (versions stored for the first time); duplicates; conflicts; projected (versions handed to the projection, superseded ones included); quarantined; status | After the data transaction commits |
| Revision stored | `raw_events` | One row per version: the run that first stored it, the source's fetch time (`payload.fetchedAt`), mapper, status, delivery count. A later duplicate only raises the count; it names no run. `status = 'projected'` means handed to the projection, not accepted | In the data transaction |
| Revision accepted | `ad_spend_daily` and the other accepted tables | The accepted version of each record, with its raw event. Overwritten in place: it shows today, not what happened when | In the data transaction |
| Effect when it ran | `domain_events`, `intake.records_stored` | Per run: inserted, projected, excluded, quarantined, conflicts, `rowsChanged`. Written **only when the run stored, conflicted or changed something** | In the data transaction |
| Verification | `exceptions.evidence.verification` (and `previousVerifications`) | When the gap was verified, its window, required and covered dates, covered cents, and each run with its dates and cents | In reconciliation's transaction |

In the old world, 672 of 679 runs had an intake event. Seven had none:
- five empty first runs (#1, #5, #6, #8, #9);
- failed run #473;
- duplicate run #678.

**Two traps** stop the outcome being inferred:
- **Payload comparison.** B09's corrections carried the same numbers as the versions they
  replaced; only the classification changed (`ads@1.2` files them as Local Services). A payload
  comparison would call #676 and #677 "no change". The seeded restatements did change numbers
  (#658: 50 restatements, none with the same numbers).
- **Changes are not stored versions.** In 14 seeded calls runs, `rowsChanged` is above
  `projected` (for example 189 from 188): an earlier version accepted again, or an exclusion.

## 3. The change

Smallest set that lets the row say what happened, from facts recorded when the run ran.

1. **The missing fact: migration `0030_run_effect.sql`.**
   - What: `ingestion_runs.rows_changed`, the writes and removals of accepted records the run's
     delivery made, 0 included.
   - Where it is written: `runStream`, in the run's own data transaction. It commits with the
     change or not at all.
   - Retry: it is set, never added to, so writing it again cannot double it.
   - NULL means not recorded; it never means "no change".
   - Runs recorded before the column take the count their intake event recorded in the same
     transaction.
   - Not trusted: ads runs whose event recorded currency exclusions, because that count left out
     removals (see 2). Applying the migration again changes nothing.
2. **One count fixed: `lib/ingest/project.ts`.**
   - The bug: the currency gate removes an accepted spend day when a newer version without a
     currency is held. That removal was never counted.
   - The test: `run-effect.test.ts` fails on the old projection (0, which would read "No change"),
     and passes now.
3. **The verifications: `verificationsByRun` in `lib/queries.ts`.** It reads the coverage-gap
   verifications stored on incidents, earlier ones included. It never reads today's accepted rows.
4. **The words: `lib/ingest/run-outcome.ts`.** One pure function. It uses only those facts, never
   the status or the stored count alone.
5. **The table: `PipelineSections.tsx`.**
   - "New" is now **Stored**.
   - An **Outcome** column sits beside the run.
   - One legend line says what both mean.
   - The Window cell gets a minimum width, so the new column cannot squeeze it to a word per line
     (it went to six lines on the first build). The table still fits 1280 px: 990 of 990.

The outcome, by case:

| Recorded | Outcome | Reason line |
|---|---|---|
| NULL | Effect not recorded | none |
| > 0 | *N* changes to accepted records | none |
| 0, nothing fetched | No change to accepted records | Nothing delivered |
| 0, nothing stored, every delivery a stored version | No change to accepted records | Duplicate: every delivery was a version already stored |
| 0, stored, all handed to the projection | No change to accepted records | Stored, but a newer revision was already accepted |
| 0, other | No change to accepted records | Stored, none accepted / Nothing new stored |
| A stored verification names the run | adds: "Incident #N's verification used *dates* (*k* of *m* dates) to clear its coverage hold." | |

## 4. Proof on the four deliveries

### History recorded before the column (old world, migration applied)

Build `UUfOJuh4ioDDsyyHgfG8c`. The migration filled 672 runs from their intake events. Seven
stayed unrecorded.

| Run | Outcome |
|---|---|
| #676 | 5 changes to accepted records. Incident #2455's verification used Oct 26–Oct 30 (5 of 18 dates) to clear its coverage hold. |
| #677 | 13 changes to accepted records. Incident #2455's verification used Oct 13–Oct 25 (13 of 18 dates) to clear its coverage hold. |
| #678 | **Effect not recorded**: it left no event, so it does not say "No change" |
| #679 | No change to accepted records. Stored, but a newer revision was already accepted. |

Walk: 35/35 checks (`walk-migrated.json`, `migrated/`).

### Recorded by the new code (B09 world reseeded, same four deliveries)

- **Setup.** The seed records every run; only failed run #473 stays unrecorded. The case was
  handed to the integration engineer first, as before. The deliveries got the same ids,
  #676–#679.
- **Outcomes.** As in the table above, except #678: **No change to accepted records.
  Duplicate: every delivery was a version already stored.**

**Against the independent ledger** (`ledger-after.json`, 27/27). The ledger is what the source
sent, read from its payloads before the product mapped them (`C:/Temp/b09-step-*.json`).

| Run | Source sent | Recorded revisions | Run row | Accepted today | Verification |
|---|---|---|---|---|---|
| #676 | 5 days, Oct 26–30, 13:00, 59,717¢ | the same 5 versions | stored 5, 5 changes | the 5 days rest on its versions, as Local Services | 5 dates, 59,717¢ |
| #677 | 13 days, Oct 13–25, 13:10, 152,635¢ | the same 13 versions | stored 13, 13 changes | the 13 days rest on its versions | 13 dates, 152,635¢ |
| #678 | #677's 13 versions again | none; #677's versions delivered twice | stored 0, 13 dupes, 0 changes | unchanged | none |
| #679 | Oct 20 at 13:05, 12,091¢ + 5,000¢ | 1 version | stored 1, 0 changes | Oct 20 still #677's 12,091¢ at 13:10 | none |

**Totals after each step:**
- B09's paid spend: 1,664,923¢ every time.
- Company spend: the same every time.
- Local Services: 148,767 → 208,484 → 361,119¢.
- Search: 1,230,039 → 1,170,322 → 1,017,687¢.
- Local Services gained exactly what Search lost. The 148,767 and 1,230,039 starting values are
  the seed's documented start (`B09-HANDOFF.md`), consistent with these deltas.
- The $2,123.52 is reclassified, not added: the verification's covered cents (212,352) equal what
  the source re-sent.

**Nothing extra was created:**
- one coverage-gap incident, #2455: open, then resolved;
- each reconciliation after a delivery opened nothing; one resolved #2455;
- one verification, none before it;
- incidents by kind equal the old code's world after the same deliveries.

**Nothing claims more than it shows.** No outcome says a decision is ready or a budget change is
approved. The incident still says "Nothing here approves a budget change."

## 5. The walk

From the incident, as the Overview opens it (`/exceptions/2455?period=oct#recovery`, no run id),
on build `UUfOJuh4ioDDsyyHgfG8c`.

| | Before (`PbO3bB5BZmRLZ68TuIsJD`) | After |
|---|---|---|
| Clicks, desktop 1280 and phone 390 | 3 (Verification details, run #677, Back) | 3, the same |
| Context re-entered | none | none |
| Repeated work | none | none |
| What the row says about #679 | New 1 | No change to accepted records; stored, but a newer revision was already accepted |
| Checks | 22/22 | 35/35 |

- **Back.** It returns to the incident with Verification details still open, and keeps `period`.
- **Phone.** At 390 px the followed row's outcome is in view without scrolling sideways.
- **Before.** The row gave no way to see what a run changed: telling #679 changed nothing needed
  the database. Time savings are not claimed. The walks are scripted, with no comparable baseline.
- **Cost: taller rows.** Before, about 57 px each (from the before screenshot). After, measured on
  #676–#679: 77 px with one line of outcome (#678 in the migrated walk), 117 px with a reason
  line, 137–157 px with a verification.

## 6. Roles

Two harness fixes, said here because they changed checks:
- headers are read as text, not as CSS-uppercased `innerText`;
- the "no readiness claim" check uses word boundaries ("already" contains "ready").

| Viewer | Result |
|---|---|
| Engineer (company-wide, the case owner) | Sees the marked row with its outcome |
| Branch partner (B20), fresh browser context | The followed run's pipeline URL says it is limited to company-wide roles; the incident, both pipeline URLs and the case API carry no B09 evidence and no outcome words |
| Brand viewer (B40–B44), fresh browser context | The same |

11/11 checks before and after (`roles-before.json`, `roles-after.json`).

**Not production-ready access isolation.** Demo roles are a cookie (R-2), and a tab keeps hidden
copies of pages it already loaded (`B09-CROSS-VIEW.md`). `verificationsByRun` is not scoped by
viewer: the one page that shows it is refused to every branch-scoped role.

## 7. Tests

- **`tests/unit/run-outcome.test.ts`** (7 tests): every case in the table above. An effect that was
  not recorded is never "no change", even when the counts look like a duplicate.
- **`tests/integration/run-effect.test.ts`** (5 tests):
  - a 0 is recorded;
  - a failed run stays unrecorded;
  - the count agrees with the intake event;
  - the migration fills history from events and leaves #678's kind unrecorded;
  - applied again, the migration changes nothing;
  - a currency removal counts.
- **`tests/integration/b09-recovery.test.ts`**: the same four deliveries against its hand-written
  ledger. That covers each run's row and outcome, the share of the window each gave the
  verification, and both verifications after a reopen and repair.
- **`tests/e2e/zz-b09-four-minute-path.spec.ts`**: the followed run's outcome, its incident link,
  and the Stored header. Run alone first: 2 passed.

**Regression** (`C:/Temp/regression-b09o.sh`, one sequential run on this change):

| Step | Result |
|---|---|
| Typecheck, lint | Pass |
| Vitest | 79 files: 928 passed, plus the 1 known expected failure (R-39). The handoff run had 916; the 12 new tests are the difference |
| The five frozen eval packs | Identical to the handoff run, except a process id in a warning and the recorded base commit |
| Build | Pass (`AqyBLx1IjcHslSNZxtx5Y`), with the same 3 warnings as before |
| Full browser suite, with pixel comparisons | 125 passed, 1 skipped (the opt-in demo-video recording), 0 failed, in one run (26.1 min) |

No pixel baseline changed: the pinned pages (Overview, incident) do not show the pipeline table.

One server log line was new in this run: `event consumer failed … relation "domain_events" does not
exist`, once. It came while a spec reseeded the database under the running server (the schema
was dropped while the identity consumer polled). No test failed. The change does not touch that
path.

## 8. What remains

- **The count is writes and removals, not distinct records.** A record written twice in one
  delivery counts twice: projected then excluded, or removed and re-added by a newer version.
  It also includes a newer revision that restates the same numbers, as the legend says. Whether
  the numbers changed is not recorded per run.
- **History before 0030 without an intake event says "Effect not recorded".** That is quiet,
  failed and empty runs, and ads runs whose event recorded currency exclusions.
- **The stored fields keep their meaning.** `ingestion_runs.projected` and raw
  `status = 'projected'` still include superseded versions; #679's version is `projected`.
  Changing them would move the ledger model and replays. The page no longer shows them (R-51).
- **Campaign records are not counted.** The outcome counts accepted spend, lead and CRM records
  only.
  - Until 2026-11-15 they were not guarded either. A spend version rewrote its campaign's own
    record (name, latest classification) whether or not it was accepted.
  - Fixed then (`RELEASE-CANDIDATE.md` §1, migration 0031). Only the campaign's newest fetch sets
    those fields. That fetch is also the newest for its own day, so it changes that day's row too.
    "No change to accepted records" therefore also means the campaign record is unchanged.
- **Only coverage-gap verifications name their runs.** Other verifications (an Action Center
  proposal's) do not, so no line is shown for them.
- **Unchanged:** R-39, R-46 (the 45 Local Services calls carrying a Performance Max id), FI-4/R-50.
