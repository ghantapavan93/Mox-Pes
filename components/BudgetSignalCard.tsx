import Link from "next/link";
import { Badge, Card, TableWrap, Td, Th } from "@/components/ui";
import { budgetSignalCopy } from "@/lib/decision/signal-copy";
import { count, money } from "@/lib/format";
import { SIGNAL_MIN_CUSTOMERS, SIGNAL_RATIO, type BudgetSignal } from "@/lib/metrics/decision";
import type { PeriodKey } from "@/lib/period";

/**
 * A channel budget signal, shown together with whatever makes it untrustworthy. It reports an
 * observation on attributed cost and a data-integrity gate; readiness and effectiveness are the
 * Decision Lab's verdicts, linked rather than restated (see `budgetSignalCopy`).
 */
export function BudgetSignalCard({ signal, periodLabel, periodKey }: { signal: BudgetSignal; periodLabel: string; periodKey: PeriodKey }) {
  const copy = budgetSignalCopy(signal, signal.branchId, periodKey);
  return (
    <Card
      title="Budget signal"
      subtitle={`${signal.branchId} · ${periodLabel} · illustrative rule: a paid channel ≥ ${SIGNAL_RATIO}× another's attributed cost per new customer (each ≥ ${SIGNAL_MIN_CUSTOMERS} customers)`}
    >
      <div data-testid="budget-signal" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={copy.gate.tone}>{copy.gate.label}</Badge>
          <p className="text-sm text-text">{copy.headline}</p>
        </div>
        {!signal.trustworthy && (
          <div className="rounded bg-bad-soft p-2 text-sm">
            Do not act on this number. Open incidents change what these channels cost or which customers they produced:
            <ul className="mt-1 list-disc pl-5">
              {signal.blockers.map((b) => (
                <li key={b.exceptionId}>
                  <Link href={`/exceptions/${b.exceptionId}`} className="text-accent hover:underline">#{b.exceptionId}</Link> {b.summary}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted">
          {copy.effectiveness}{" "}
          <Link href={copy.decisionsHref} className="text-accent hover:underline">Decision readiness and effectiveness per channel →</Link>
        </p>
        <TableWrap>
          <thead><tr><Th>Paid channel</Th><Th align="right">Spend</Th><Th align="right">New customers</Th><Th align="right">Attributed cost per customer</Th></tr></thead>
          <tbody>
            {signal.channels.map((c) => (
              <tr key={c.channelCode}>
                <Td className="text-xs">{c.label}</Td>
                <Td align="right" className="text-xs tabular-nums">{money(c.spendCents)}</Td>
                <Td align="right" className="text-xs tabular-nums">{count(c.acquired)}</Td>
                <Td align="right" className="text-xs tabular-nums">{money(c.cacCents)}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </div>
    </Card>
  );
}
