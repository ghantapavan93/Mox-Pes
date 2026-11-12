# Freeze record: VP acceptance pack v1

Frozen 2026-11-12, before the runner met the scenarios. First contact runs once on the code at
the freeze commit and is committed unchanged (`evidence/first-contact.*`).

## What was frozen

| File | sha256 |
|---|---|
| `scenarios.v1.json` (12 scenarios, 38 checkpoints, 480 expectations) | `0dd8a0bf3610e4d3b7e8bc50f90de8b0f336178a1fe52ff9f9ea30b0d359a3ac` |
| `BRIEF.md` | `8c3c4201564cf42c552b1b853d18676b13452a462a550979605b648fcc22d46e` |
| `SCHEMA.md` | `1e7dde7191ca0911a33eefd600dc90c8695bd42863ff33682f0973420b4dc33f` |
| `SCORING.md` | `221d68f9af02cb1f7c47fca62279349a97ac30acc802126bc7785b2b36a318cc` |
| `scripts/eval-acceptance.ts` (the runner) | `2dbfd27252e03b81326edcb19dd16a1e8d2f7e558ea97030e6e5097c1370c6f8` |

Code under test: commit `36f4779` (the freeze commit is its child and adds only this folder and the
runner). Node v22.14.0, Postgres 17 local (`fsync=off`), a fresh `revenue_signal_eval` database per
scenario, no currency rule, business clock 2026-10-31 13:00 UTC, deterministic investigator only
(no model key).

## How it was written

- **Designer:** an independent agent given `BRIEF.md`, `SCHEMA.md`, `SCORING.md`, the metric
  definitions, glossary, domain model, source-authority and vendor-contract documents. It was told
  not to read any code, test, script, migration, existing evaluation set, report or git history.
- **One clarification during writing** (also in `SCHEMA.md`): `company` paid spend includes
  unallocated spend; a brand's excludes it; `company` paid CAC is the branches' spend over their
  paid customers.
- **The runner** was written from `SCHEMA.md` alone, while the designer worked, and smoke-tested
  on a throwaway scenario of its own (not in the pack). It was not changed after the pack arrived.

## The designer's stated assumptions (also in each scenario's `knownAmbiguity`)

- A customer's `day` is its sale, first-service completion, invoice and payment day; a customer
  with no campaign has no evidenced touch (unknown channel); a fully refunded, serviced customer
  still counts as acquired.
- Money is rounded to cents per campaign-day; collected cash can be negative.
- VP-01 leaves the restated day out of the world, so the world's own fetch time does not matter;
  VP-06 assumes the world's CRM versions are no newer than their customer day.
- Feed states for `crm.payment` and `crm.customer` apply company-wide; a stale CRM or spend feed
  blocks readiness; the 5-customer minimum is per channel; B12's readiness after VP-01's
  corrections is deliberately not labelled.
- Hypotheses H3–H6 are left unlabelled where SUPPORTED vs UNRESOLVED is a judgement call.
- BLOCK proposals are labelled `accepted` (recorded, preview failed); a proposal to a branch that
  does not exist is `refused`; `monitor` by marketing ends `verified`.
- CAD spend is in no total and not in `heldCurrency`; a revoked rule cannot be authorized again.
- Replay goes through the unchanged mapper; a counterfactual question is ABSTAIN; a cross-brand
  comparison is REFUSE.
- In VP-06 only the Moxie cash total is checked after a customer moves branch.
- The `identity` centre has no scenario of its own (12 themes, 11 slots); VP-01 includes two
  customers sharing a phone and checks they stay two customers.

## How the runner reads the format (recorded before first contact)

- A step's `day` (and `month`) also sets when the step is received. For `restate_spend` that is the
  restated day; the ads version order is by fetch time (`fetchedDay`), not receipt.
- `read currency_rules` and `read branch_metrics` apply the same permission checks the HTTP routes
  apply (marked ROUTE CHECK in the runner); the other reads call the product's own traces.
- `replay` replays the source's quarantined records through the active mapper, after the product's
  replay-permission check.
- Questions run the deterministic investigator; workspaces open "Why did <branch>'s paid CAC
  increase?"; readiness uses the one-snapshot verified readiness.
- Around every mapping-change step the runner measures the financial invariants (company spend
  unchanged; collected and acquired unchanged; a refusal or preview changes nothing).
