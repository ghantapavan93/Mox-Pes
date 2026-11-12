# Freeze: Shadow Mode acceptance pack v1

| File | sha256 |
|---|---|
| `scenarios.v1.json` (12 scenarios; 80 snapshot checks; 11 answers with 31 labelled claims) | `fa8f6d409fb0fad0afdf5a2920a716bed4dfb450544c2e00af173a2e1200cb7d` |

**Code under test:** `76a5606` (Shadow Mode as first committed). The pack is frozen before the
runner can execute its two new step types, so first contact is the first time product and
expectations meet.

**How it was written.** A separate agent wrote it from the contract (`../SHADOW-MODE.md`), the
step types (`STEPS.md`) and the acceptance brief, schema and scoring of the VP pack. It was told
not to open any code, test or script and not to run commands. It reports one deviation: a
read-only `wc -l` / `ls` at the start; nothing was changed. It could not validate its JSON; a
parser accepted it (12 scenarios, 80 `shadow_snapshot`, 11 `shadow_answer`).

**Expected mix (the designer's count):** 37 MATCH, 13 MISMATCH, 8 INCOMPATIBLE_DEFINITION,
8 INCOMPLETE_EVIDENCE, 10 NOT_DETERMINABLE, 4 refused; claims 17 SUPPORTED, 9 CONTRADICTED,
3 UNSUPPORTED, 2 OUT_OF_SCOPE. Valid answers and matches are the majority on purpose: a checker
that refuses everything fails this pack.

**The designer's stated assumptions** (also in each scenario's `knownAmbiguity`):

1. A gross-payments snapshot is expected to MATCH the product's gross payments, not to be
   incompatible with net cash (the contract lists both metrics).
2. Within a family, the comparable product metric is the one sharing the population or cash
   basis; `customers_sold` matches none (INCOMPATIBLE, no product value expected).
3. Counts carry a currency too; a null currency is NOT_DETERMINABLE for counts as well.
4. A customer's `day` is first service, invoice and payment at once; `campaign: null` means no
   evidenced touch.
5. Answers are judged on the evidence at check time, not as of their `asOf`.
6. Feed states are company-wide; last success on day 27 is stale at check time, day 30 fresh.
7. Held spend applies to the campaign's mapped branch and its own days; unreadable records use
   their event date; unreadable ad records do not affect customers or cash.
8. Required dimensions name `definition.*`, `currency`, `value`, `numerator`, `denominator` and
   `revision` only; no `evidence.*` names are required (the contract did not fix them).
9. CAC product values are rounded half-up to the cent.
10. A hostile `definition.id` is free text: by itself it does not make a snapshot
    NOT_DETERMINABLE.

**Scoring:** `STEPS.md` plus `../vp-acceptance/SCORING.md`. First contact runs once and is
committed unchanged; later runs are labelled regression.
