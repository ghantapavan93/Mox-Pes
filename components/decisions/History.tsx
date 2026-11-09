import { Badge, TableWrap, Td, Th } from "@/components/ui";
import type { StoredExperiment } from "@/lib/decision/experiment";
import type { SavedScenario } from "@/lib/decision/scenario";
import { ScenarioResultView } from "./ScenarioResultView";
import { customers, signed, usd, when } from "./fmt";

/** Saved scenarios, newest first; each opens to the full result exactly as it was saved. */
export function SavedScenarios({ scenarios, labelFor }: { scenarios: SavedScenario[]; labelFor: (code: string) => string }) {
  if (scenarios.length === 0) return <p className="text-sm text-muted">No saved scenarios for this branch yet.</p>;
  return (
    <ul className="divide-y divide-border" data-testid="saved-scenarios">
      {scenarios.map((s) => {
        const r = s.result;
        const change = r.changes.map((c) => `${usd(c.amountCents)}/mo ${labelFor(c.fromChannel)} → ${labelFor(c.toChannel)}`).join("; ");
        const d = r.projection.deltaCustomers;
        return (
          <li key={s.id} className="py-2">
            <details>
              <summary className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs text-faint">#{s.id}</span>
                <span className="font-medium">{change}</span>
                <span className="tabular-nums text-muted">
                  {signed(d.point)} customers ({customers(d.low)} to {customers(d.high)}) · β {r.projection.elasticity.toFixed(2)}
                </span>
                {s.decisionReady ? <Badge tone="good">ready when saved</Badge> : <Badge tone="bad">not decision-ready when saved</Badge>}
                <span className="text-xs text-faint">
                  {s.periodKey} · {s.actor} · {when(s.createdAt)}
                </span>
              </summary>
              <div className="mt-3 rounded border border-border bg-surface-2 p-3">
                <ScenarioResultView result={r} />
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

/** Stored experiment runs: kind, scope, status and conclusion, newest first. */
export function ExperimentHistory({ experiments }: { experiments: StoredExperiment[] }) {
  if (experiments.length === 0) return <p className="text-sm text-muted">No experiment runs recorded in your scope yet.</p>;
  return (
    <TableWrap>
      <thead>
        <tr>
          <Th>Run</Th>
          <Th>Scope</Th>
          <Th>Status</Th>
          <Th>Conclusion</Th>
          <Th>Recorded</Th>
        </tr>
      </thead>
      <tbody data-testid="experiment-history">
        {experiments.map((e) => (
          <tr key={e.id}>
            <Td className="text-xs">
              <span className="font-mono text-faint">#{e.id}</span> {e.kind === "aa" ? "A/A" : "Holdout"}
              <div className="text-faint">{e.name}</div>
            </Td>
            <Td className="text-xs">
              {e.branchIds ? e.branchIds.join(", ") : "All branches"}
              {e.channelCode && <div className="text-faint">{e.channelCode}</div>}
            </Td>
            <Td>{e.status === "completed" ? <Badge tone="good">completed</Badge> : <Badge tone="bad">invalid</Badge>}</Td>
            <Td className="max-w-md text-xs text-muted">{e.conclusion}</Td>
            <Td className="whitespace-nowrap text-xs">
              {e.actor}
              <div className="text-faint">{when(e.createdAt)}</div>
            </Td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}
