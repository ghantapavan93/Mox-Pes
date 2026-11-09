# Adversarial reviews

Three readers, each looking for a reason to reject. Reviews A and B are **simulated** by the author
from the stakeholder models in research/04 — they are judgement, not the opinion of any real person.
Review C was done by an **independent** reviewer agent that read and probed the code without the
author's conclusions; it is in docs/review-senior-engineer.md (round 1) and
docs/review-senior-engineer-round2.md (after fixes). Scores are review judgements, not measurements.

## Review A — VP of Technology (simulated)

| Question | Assessment |
|---|---|
| Is the engineering substantive? | Yes: exactly-once log, version-guarded projections, replay with request-bound idempotency, savepoint isolation, real-Postgres concurrency tests. |
| Can I understand the architecture? | One diagram, one page per module (docs/architecture.md). The incident is traceable from UI to a one-line mapper change. |
| Can I trust the data handling? | PII hashed before storage, free text scrubbed; no raw contact data at rest. Demo auth is not real auth — said plainly. |
| Maintainable? | Small modules, pure mappers, SQL you can read, 80 tests. Raw SQL means no ORM safety net — a reviewer must read SQL. |
| Failure cases recognised? | API outage, duplicates, conflicts, out-of-order, clock-less sources, schema drift, unknown branches, oversized ids. |
| Over-engineered? | Mostly proportional. The simulator is large, but it is what makes the demo honest. |
| Would I let this person own an internal system? | Likely, with one concern: it is a second store next to our lake. The positioning fixes that only if the candidate follows through. |

**Score: 80.** Deductions: −8 parallel datastore risk; −6 demo auth; −4 not yet run in CI on GitHub;
−2 reconciliation not incremental.

## Review B — VP of Marketing (simulated; the seat may be vacant)

| Question | Assessment |
|---|---|
| What decision does this improve? | Whether a branch's CAC is real before moving its budget; which conversions Google should learn from. |
| Why should a marketer care? | The headline answers their question in their words; the branch table explains each flag. |
| Which metrics are trustworthy? | Each has a definition one click away; booked vs collected is never mixed. |
| What does an incident mean? | "Revenue you can't attribute yet", never "lost revenue". |
| Fits a multi-branch operation? | Yes — branch is a first-class dimension, partners see only their branch. |
| Solving a problem or displaying data? | Solving: the replay changes the number and shows before/after. |
| Could an existing product do this more cheaply? | Not the record-level fix loop; the dashboards, yes. |

**Score: 74.** Deductions: −8 no D2D cost parity (excluded, not modelled); −6 period CAC only, no
cohort view; −6 the Google feedback is a dry run; −6 engineering vocabulary still visible on the
exception page (replay, mapper).

## Review C — skeptical senior engineer (independent)

- Round 1: **53/100** — 1 critical, 5 high, 10 medium, all reproduced by the reviewer.
- Round 2 (after fixes): **68/100** — critical fixed; two new high bugs introduced by the fix for
  clock-less versions (an old version could win inside a batch; replay ignored receipt order), a
  deadlock path, and transient errors treated as permanent.
- Both rounds' findings now have reproducing regression tests and fixes at the shared primitive
  (docs/review-response.md). **A third review round was not run**, so no post-fix score is claimed.
