# Investigator held-out set: freeze record

Frozen on 2026-11-12, before any run of the investigator against these cases. The investigator
under test is the code at commit `d472069`. That commit has no proof-carrying claim layer:
`lib/ai/facts.ts` and `lib/ai/proof.ts` are not in it.

## Who wrote what

| File | Author | Saw |
|---|---|---|
| `BRIEF.md`, `SCHEMA.md`, `SCORING.md`, `TOOLS.md` | The engineering agent, before the cases existed | Everything |
| `cases.v1.json` | An independent designer agent (a separate model session) | Only what `BRIEF.md` permits: product docs, the public tool contract and the data contracts. It reported reading only those. It did not see `lib/ai`, the tests, the development eval cases, the claim checker or the investigator's earlier fixes |
| `scripts/eval-investigator.ts` | The engineering agent | Checked only against a three-case smoke file of its own, not against these cases |

The designer reported a few ambiguities and how it resolved them. They are copied unchanged:

1. **Claims fields sit at the top level of a case**, as `SCHEMA.md` shows. Claims cases also
   carry `expect: {referenceFacts, notes}`.
2. **A correct difference, ratio or sum of cited figures counts as SUPPORTED** (for example,
   "fell by $60.00"). A true figure that no cited call returned (an invoice total, a brand total)
   is labelled UNSUPPORTED.
3. **Feeds with no stated currency.** Requirement IR-8 asks for an authorized rule, while
   VENDOR-CONTRACTS G-3 assumes USD. Claims of "known USD" are labelled UNSUPPORTED.
4. **Data conventions:**
   - day ranges are inclusive;
   - a customer's single `day` is both the first-service date and the payment date;
   - a `null` campaign means there was no paid touch;
   - percents are in percentage points;
   - daily rates use only quarter-dollar fractions.
5. **Abstention cases are only about things with no records at all**, because any true adjacent
   figure would turn an abstention into an ANSWER under the mechanical rule.
6. **Forbidden patterns use a negation lookahead** where a negated sentence could match.

## The set

| Measure | Count |
|---|---|
| Cases | 62: 32 in investigator mode, 30 in claims mode |
| Investigator outcomes expected | 24 ANSWER, 3 ABSTAIN, 5 REFUSE |
| Claims candidates | 138: 63 SUPPORTED, 71 UNSUPPORTED, 2 PARTIALLY_SUPPORTED, 2 NOT_DETERMINABLE |
| Categories | 22, with 2 to 4 cases each |

A structural check found no unknown fields, no dangling references and no invalid regular
expressions. The check covered every field against `SCHEMA.md` and the runner's types, and every
campaign, customer and cite reference.

## Content hashes (sha256)

```
569852c9b732f0d9bfa10238a40c6002abcc25e415d184f53b9ddc049f0f95e5  cases.v1.json
638ae147dd9d0941014035050192a7d4b2667de0e5710b45eefc00b63db9f8bb  SCORING.md
ccbd20c403909d27a4e4bc803f2cfab85e1cc8c2acb8c28ce982be261e16ae7e  SCHEMA.md
6ff14ed3724b99c39c9ee715dbff4147a224352dcaad16ad54f36e035e3b4998  BRIEF.md
d0912c755f83da89c910d1696cc09237a50ab165b60715f6fc622fab0f2fa881  TOOLS.md
9f755718c1f5d7586e8275bd97cc80b226b005f33458fd54612cd4184c80348b  ../../../scripts/eval-investigator.ts
```

## Rules from here on

- None of these files changes. A disagreement with a label goes into an adjudication table beside
  the result.
- The first complete run is `evidence/first-contact.json`. It runs from a clean worktree at the
  commit that adds this file, so later work in the main tree cannot affect it. It is committed
  unchanged.
- Every later run against `cases.v1.json` is reported as **after changes, no longer held out**.
- Nothing here measures a language model. No model key is configured. Investigator mode runs the
  deterministic investigator; claims mode runs the claim checker behind a scripted provider.
