import { Badge, KV, TableWrap, Td, Th } from "@/components/ui";
import type { Range, ScenarioResult } from "@/lib/decision/scenario";
import { ReasonList } from "./ReasonList";
import { customers, percent, signed, usd } from "./fmt";

const range = (r: Range, fmt: (n: number) => string) => `${fmt(r.point)} (${fmt(r.low)} to ${fmt(r.high)})`;
const cacRange = (c: { point: number | null; low: number | null; high: number | null }) =>
  c.point === null ? "—" : `${usd(c.point)} (${usd(c.low)} to ${usd(c.high)})`;

/**
 * A scenario result as the person saw it. Used for a fresh run and for a saved scenario, so both
 * always carry the same labels: observational forecast, readiness, assumptions, coverage.
 */
export function ScenarioResultView({ result }: { result: ScenarioResult }) {
  const p = result.projection;
  return (
    <div className="space-y-4 text-sm" data-testid="scenario-result">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warn">{result.label}</Badge>
        {result.decisionReady ? <Badge tone="good">Decision-ready</Badge> : <Badge tone="bad">Not decision-ready</Badge>}
        <span className="text-xs text-faint">
          {result.branchId} · baseline {result.period.label} · per {result.baseline.monthDays} days
        </span>
      </div>

      {!result.decisionReady && (
        <div className="rounded bg-bad-soft p-3">
          <p className="mb-2 text-xs font-medium text-bad">The projection still computes, but do not act on it until these are resolved:</p>
          <ReasonList reasons={result.blockers} />
        </div>
      )}

      <KV
        items={[
          ["New serviced customers / month (90% range)", range(p.deltaCustomers, (n) => signed(n))],
          ["Paid customers / month", `${customers(result.baseline.paidCustomers)} → ${range(p.paidCustomers, (n) => customers(n))}`],
          ["Paid-media CAC", `${usd(result.baseline.paidCacCents)} → ${cacRange(p.paidCacCents)}`],
          ["Paid spend / month", `${usd(result.baseline.paidSpendCents)} (a shift: unchanged)`],
        ]}
      />

      <TableWrap>
        <thead>
          <tr>
            <Th>Channel</Th>
            <Th align="right">Spend / month</Th>
            <Th align="right">Customers / month</Th>
            <Th align="right">Historical cost / customer</Th>
          </tr>
        </thead>
        <tbody>
          {p.channels.map((c) => (
            <tr key={c.channelCode}>
              <Td className="text-xs">{c.label}</Td>
              <Td align="right" className="text-xs">
                {c.spendCents === c.baselineSpendCents ? usd(c.spendCents) : `${usd(c.baselineSpendCents)} → ${usd(c.spendCents)}`}
              </Td>
              <Td align="right" className="text-xs">
                {customers(c.baselineCustomers)} → {range(c.customers, (n) => customers(n))}
              </Td>
              <Td align="right" className="text-xs">{usd(c.baselineCostPerCustomerCents)}</Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      <div>
        <h3 className="mb-1 text-xs font-semibold text-text">Sensitivity to the diminishing-returns elasticity β</h3>
        <TableWrap>
          <thead>
            <tr>
              <Th>β</Th>
              <Th align="right">Δ customers / month (90% range)</Th>
              <Th align="right">Paid-media CAC (90% range)</Th>
            </tr>
          </thead>
          <tbody>
            {result.sensitivity.map((s) => (
              <tr key={s.elasticity} className={s.elasticity === p.elasticity ? "bg-accent-soft" : ""}>
                <Td className="text-xs">
                  {s.elasticity.toFixed(2)}
                  {s.elasticity === p.elasticity && <span className="ml-1 text-accent">(chosen)</span>}
                </Td>
                <Td align="right" className="text-xs">{range(s.deltaCustomers, (n) => signed(n))}</Td>
                <Td align="right" className="text-xs">{cacRange(s.paidCacCents)}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-semibold text-text">Assumptions (explicit, editable)</h3>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted">
            <li>Elasticity β = {p.elasticity.toFixed(2)}: customers scale with (new spend ÷ old spend)^β. Not estimated from this data.</li>
            <li>
              Close rate of leads bought by new spend = {result.assumptions.closeRateFactor.toFixed(2)}× the channel&apos;s history
              {result.assumptions.closeRateFactor === 1 ? " (stable)" : ""}.
            </li>
            <li>Baseline = attributed customers and spend at {result.branchId}, scaled to {result.baseline.monthDays} days.</li>
            <li>Attribution is first evidenced touch; it is not causal, so neither is this forecast.</li>
          </ul>
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold text-text">Data coverage</h3>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted">
            <li>
              Spend on {result.coverage.spendDays} of {result.coverage.expectedSpendDays} expected days across {result.coverage.weeksWithSpend} weeks (weakest channel involved)
            </li>
            <li>{percent(result.coverage.reconciledShare)} of the branch&apos;s lead records reconciled (projected, not held)</li>
            <li>{customers(result.coverage.observedCustomers, 0)} observed customers in the channels involved</li>
          </ul>
        </div>
      </div>

      {result.warnings.length > 0 && (
        <ul className="space-y-1 rounded bg-warn-soft p-2 text-xs text-warn">
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <p className="text-[11px] leading-snug text-faint">{result.method}</p>
    </div>
  );
}
