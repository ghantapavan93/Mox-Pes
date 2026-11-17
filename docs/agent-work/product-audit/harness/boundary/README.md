# Decision boundary (BUSINESS-FIT.md §10)

The evidence for the second business-fit pass. A fact can be displayable, a pairwise comparison
valid, and a budget recommendation still held. Everything here runs on isolated databases only,
never `revenue_signal`.

| File | What it is |
|---|---|
| `cases.mts`, `common.mts` | The recorded B03 cases (exp-n1 R, D, C, E), the new ones (RDfix: a correction that leaves another blocker open; Z: a recorded $0.00; S: a held day on a shared account) and the B04 control. Each runs in a rolled-back transaction on `revenue_signal_audit_dm`. Each prints what every surface says. |
| `cases.before.out`, `cases.after.out` | The same run on the code before and after the change. Only exception ids differ between runs of the same code. |
| `decision-control.mts`, `decision-control.deploy.out` | The seed-side control on the pristine seed: the ledger, the legacy gate outputs against a frozen copy of the old rule (all branch-periods), and every place the boundary now says more. The CAC fingerprint (`../cac-zero-control.mts`) is appended. |
| `world.mts` | Builds case R, committed, on a copy of the seed (`revenue_signal_audit_boundary_r1`), for page captures. |
| `movement-before.mts` | The Overview's "what changed" line for B03 alone, with and without the evidence holds. Without them it takes the code path it took before the change. This is the before wording; the page capture of that panel was added after the change. |
| `capture.cjs`, `proof/before`, `proof/after` | The running app's own words on that copy, for B03: the branch card, the Decision Lab (readiness, verdicts, note, builder) and the Overview (callout, hold list, "what changed" for all branches and for B03). Screenshots are kept beside the texts. |

To rerun from the repository root:

```bash
npx tsx docs/agent-work/product-audit/harness/boundary/cases.mts
```

```bash
npx tsx docs/agent-work/product-audit/harness/boundary/decision-control.mts revenue_signal_deploy
```

For the captures, create the copy, build case R on it and start the app on it. Then capture from
this folder:

```bash
createdb -h 127.0.0.1 -p 54333 -U postgres -T revenue_signal_deploy revenue_signal_audit_boundary_r1
```

```bash
npx tsx docs/agent-work/product-audit/harness/boundary/world.mts revenue_signal_audit_boundary_r1 r
```

The app runs on that copy (`DATABASE_URL=…/revenue_signal_audit_boundary_r1`, `DEMO_MODE=1`,
`npx next dev -p 3990`). Then run `node capture.cjs after B03` here.

The regression tests are `tests/integration/decision-boundary.test.ts` (part of `npx vitest run`).
