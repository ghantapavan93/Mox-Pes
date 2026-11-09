import { Badge, KV, TableWrap, Td, Th } from "@/components/ui";
import type { AaConclusionStatus, AaExperimentResult } from "@/lib/decision/experiment";
import { customers, percent, points } from "./fmt";

const CONCLUSION: Record<AaConclusionStatus, { tone: "good" | "warn" | "bad" | "neutral"; label: string }> = {
  no_difference: { tone: "good", label: "Statistics check passed" },
  difference_detected: { tone: "warn", label: "Unexpected difference" },
  invalid_srm: { tone: "bad", label: "Hash split broken (SRM)" },
  insufficient_data: { tone: "neutral", label: "Not enough data" },
};

const ci = (c: [number, number] | null) => (c ? `${points(c[0])} to ${points(c[1])}` : "—");
const pValue = (v: number | null) => (v === null ? "—" : v < 0.0001 ? v.toExponential(1) : v.toFixed(4));

/** An A/A self-check: arms, split check, outcome and guardrail differences, conclusion, and its limits. */
export function AaResultView({ result }: { result: AaExperimentResult }) {
  const a = result.analysis;
  const c = CONCLUSION[a.conclusion.status];
  const mde = a.conversion.minimumDetectableEffect;
  return (
    <div className="space-y-4 text-sm" data-testid="aa-result">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{result.label}</Badge>
        <Badge tone={c.tone}>{c.label}</Badge>
        <span className="text-xs text-faint">
          {result.branchIds ? result.branchIds.join(", ") : "All branches"} · {result.period.label} · {result.config.windowDays}-day outcome window
        </span>
      </div>
      <p className="text-sm text-text" data-testid="aa-conclusion">
        {a.conclusion.text}
      </p>
      <p className="text-xs text-muted" data-testid="aa-limitation">
        {result.limitation}
      </p>

      <TableWrap>
        <thead>
          <tr>
            <Th>Arm</Th>
            <Th align="right">Units</Th>
            <Th align="right">Converted</Th>
            <Th align="right">Conversion</Th>
            <Th align="right">Refunded</Th>
            <Th align="right">Refund rate (guardrail)</Th>
          </tr>
        </thead>
        <tbody>
          {(["A", "B"] as const).map((arm) => (
            <tr key={arm}>
              <Td>{arm}</Td>
              <Td align="right">{customers(a.arms[arm].units, 0)}</Td>
              <Td align="right">{customers(a.arms[arm].converted, 0)}</Td>
              <Td align="right">{percent(a.arms[arm].conversionRate)}</Td>
              <Td align="right">{customers(a.arms[arm].refunded, 0)}</Td>
              <Td align="right">{percent(a.arms[arm].refundRate)}</Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      <KV
        items={[
          ["Sample ratio (A share)", `${percent(a.srm.observedShareA)} vs ${percent(a.srm.expectedShareA, 0)} designed`],
          ["SRM χ² / p", `${a.srm.chiSquare.toFixed(2)} / ${pValue(a.srm.pValue)}${a.srm.flagged ? " — flagged" : ""}`],
          ["Conversion B − A", points(a.conversion.difference)],
          ["95% CI", ci(a.conversion.ci95)],
          ["Minimum detectable (80% power)", mde === null ? "—" : `${(mde * 100).toFixed(1)} pp`],
          ["Guardrail B − A (95% CI)", `${points(a.guardrail.difference)} (${ci(a.guardrail.ci95)})`],
          ["Excluded: window still open", customers(result.excludedImmature, 0)],
          ["Assignment fingerprint", <span key="fp" className="font-mono text-xs">{result.assignmentFingerprint}</span>],
        ]}
      />

      <details>
        <summary className="text-xs text-accent hover:underline">Definitions used</summary>
        <dl className="mt-2 space-y-1 text-xs text-muted">
          <div>
            <dt className="inline font-medium text-text">Unit. </dt>
            <dd className="inline">{result.config.unit}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-text">Assignment. </dt>
            <dd className="inline">{result.config.assignment}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-text">Outcome. </dt>
            <dd className="inline">{result.config.outcome}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-text">Guardrail. </dt>
            <dd className="inline">{result.config.guardrail}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}
