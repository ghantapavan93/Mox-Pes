# Shadow acceptance pack: step types

The pack uses the acceptance format in `../vp-acceptance/SCHEMA.md` unchanged (world, deliveries,
changes, checks, reference), plus two steps. Contract: `../SHADOW-MODE.md`.

| `do` | Fields | `expect` |
|---|---|---|
| `shadow_snapshot` | `as`, `snapshot` (SHADOW-MODE §1, full dates) | `{ "verdict": "MATCH" / "MISMATCH" / "INCOMPLETE_EVIDENCE" / "INCOMPATIBLE_DEFINITION" / "NOT_DETERMINABLE", "dimensions"?: ["definition.population", "value", …], "productValue"?: number or null }`, or `{ "outcome": "refused" }`. `dimensions` lists the ones that must be reported (others may also be). `productValue` is the product's own figure for the snapshot's scope and window in the snapshot's unit (dollars or a count), when you are sure of it. |
| `shadow_answer` | `as`, `answer`: `{ "question", "answer", "asOf" }` | `{ "overall"?: "SUPPORTED" / "PARTLY_SUPPORTED" / "NOT_SUPPORTED", "claims": [{ "quote": "an exact substring of the answer", "verdict": "SUPPORTED" / "CONTRADICTED" / "UNSUPPORTED" / "OUT_OF_SCOPE" }] }`. Each `quote` must appear once in the answer and lie inside one sentence or clause; the runner scores the claim that contains it. |

## Scoring (in addition to `../vp-acceptance/SCORING.md`)

| The product said | You expected | Severity |
|---|---|---|
| `MATCH`, or a claim `SUPPORTED` | anything else | **critical**: a false certification |
| a verdict or claim result | `refused` / `OUT_OF_SCOPE` | **critical**: it read across scope |
| anything else | `MATCH`, or a claim `SUPPORTED` | high: a false alarm (a checker that refuses everything is not acceptable) |
| any other confusion | | medium |
| a required dimension missing | | medium |
| `productValue` off | | high |
