# Adjudication: Shadow Mode pack, first contact

First contact (`first-contact.*`, one run on the frozen product code `76a5606` with the runner
able to execute the two new steps): **5 of 320 checks failed, 2 critical.** All 5 were product
defects; none was a labelling disagreement or a runner defect.

| Scenario · step | Severity | What happened | Root cause | Fix (red-proven) |
|---|---|---|---|---|
| SH-07 · 2, 9 | **critical** (false certification) | B33's spend and CAC agreed with the other system and were certified MATCH, although unreadable ad records dated inside the window existed | Intake stores a record it cannot identify with its **receipt** time; the completeness check dated records by that column, so records dated Oct 1–30 that arrived on Oct 31 looked outside the window | Completeness dates an unreadable record by the date in its own payload; one with no readable date counts (it cannot be ruled out) — `lib/shadow/snapshot.ts`; test "an unreadable ad record dated in the window…" |
| SH-11 · 3 | medium | "B03's paid CAC in August 2026 was $140.00" was CONTRADICTED; expected UNSUPPORTED (the product holds September and October only) | The proof engine knows only September and October; after an October sentence, the carried period made "August" read as October | A piece naming another month, or another year, proves and contradicts nothing (`foreignPeriod`, `lib/ai/proof.ts`, shared with the investigator); test "a month the evidence does not hold…" |
| SH-04 · 5, 6 | medium | Office-local days were reported as the dimension `period` | Naming: the day basis is a definition attribute | Reported as `definition.periodBasis`; test "office-local days are named…" |

**After the fixes** (`after-changes-1.*`, a **regression** run, no longer held out): **0 of 320
fail**, and every scenario repeated with the same fingerprint (`--twice`: every step's observed
output, on one machine).

## What this pack does and does not show

- It shows the comparator and the answer checker against expectations a separate agent wrote
  blind, from the contract alone: 37 expected MATCH and 17 expected SUPPORTED claims among them,
  so a checker that refused everything would have failed it.
- The contract was written by the same author as the code. The designer had to follow it
  literally; where it was ambiguous, the designer said so (`FREEZE.md`, ten assumptions).
- The investigator held-out set (written earlier, blind) caught a regression the Shadow work
  caused elsewhere: the first shared-phone fix (0022) dropped customers who each called from a
  shared phone (IV-44, IV-46 critical). Corrected by 0024 before this regression run.
- Answer checking uses the deterministic proof engine; no model ran. "Atlas BI" is synthetic.
