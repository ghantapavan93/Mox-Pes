# Release checks: `553282c`

The payment race fix (R-37). `heldPaymentObservations` locked the live payments with one locking
join to `raw_events`. Under READ COMMITTED, a delivery that waited on that lock re-checked the join
against the raw event it first saw; once a void committed a new `raw_event_id`, the re-check
dropped the payment, so a stale successful copy applied as if no version were live and voided cash
came back. Main's CI run 44434750953 on `8bbf37c` failed this way. The fix locks the payments, then
reads them in a second statement, which sees what the other batch committed.

| Check | Result |
|---|---|
| Clean checkout of `553282c`: npm ci, build, typecheck, lint | pass |
| Vitest | 99 files, 1,090 passed + 1 expected failure (`vitest.txt`), 2 more than `7de028b`: the staged race, both orders |
| AI eval, deterministic | 15/15, tool precision 99.0%, recall 100% (unchanged) |
| Acceptance: B09, BYOF | pass |
| Browser suite, local | 138 passed, 2 failed, 4 did not run, 1 skipped (`e2e.txt`) |
| The two failing spec files, run alone | 20/20 passed (`e2e-rerun-alone.txt`) |

**Before and after.** The staged test holds the void's transaction open and releases the stale copy
only once Postgres shows it waiting on the row lock. Before the fix it ended `successful`, the same
assertion main's CI failed; after it, the payment stays voided and the held copy raises its
conflict. `payment-revisions.test.ts`: 15/15.

**The two local failures** are the refresh race seen on `7de028b` (R-41): `os-golden-path` second
scenario waited 5 s for the dry run's refresh, J3 for Approve's. Both spec files pass alone, and
this change touches neither page: it changes one query in payment intake.
