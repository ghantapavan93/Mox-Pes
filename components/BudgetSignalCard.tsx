import Link from "next/link";
import { IncidentRef } from "@/components/incidents/IncidentRef";
import { Badge, Card, TableWrap, Td, Th } from "@/components/ui";
import { budgetSignalCopy, cacNote } from "@/lib/decision/signal-copy";
import { count, money } from "@/lib/format";
import { SIGNAL_MIN_CUSTOMERS, SIGNAL_RATIO, type BudgetSignal } from "@/lib/metrics/decision";
import type { PeriodKey } from "@/lib/period";

/**
 * A channel budget signal, shown together with whatever makes it untrustworthy. It reports the gate's
 * three outcomes and nothing of its own: each channel's figures (a CAC, or why it has none), the
 * comparison (branch-wide, or among the verified channels with what is left out), and whether the
 * comparison may carry a recommendation. Readiness and effectiveness are the Decision Lab's verdicts,
 * linked rather than restated (see `budgetSignalCopy`).
 */
export function BudgetSignalCard({
  signal,
  periodLabel,
  periodKey,
  scoped = false,
}: {
  signal: BudgetSignal;
  periodLabel: string;
  periodKey: PeriodKey;
  /** The viewer sees only some branches: a company-level blocker is named, not linked (IncidentRef). */
  scoped?: boolean;
}) {
  const copy = budgetSignalCopy(signal, signal.branchId, periodKey);
  const reasonsOf = new Map(signal.eligibility.map((e) => [e.channelCode, e]));
  return (
    <Card
      title="Budget signal"
      subtitle={`${signal.branchId} · ${periodLabel} · illustrative rule: a paid channel ≥ ${SIGNAL_RATIO}× another's attributed cost per new customer (each ≥ ${SIGNAL_MIN_CUSTOMERS} customers)`}
    >
      <div data-testid="budget-signal" data-basis={signal.comparison.basis} data-recommendation={signal.recommendation.status} className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={copy.gate.tone}>{copy.gate.label}</Badge>
          <p className="text-sm text-text" data-testid="budget-signal-headline">{copy.headline}</p>
        </div>
        {copy.invalid && (
          <p className="text-sm text-muted" data-testid="budget-signal-invalid">
            {copy.invalid}
          </p>
        )}
        {!signal.trustworthy && (
          <div className="rounded bg-bad-soft p-2 text-sm">
            {copy.blocked}
            <ul className="mt-1 list-disc pl-5">
              {signal.blockers.map((b) => (
                <li key={b.exceptionId}>
                  <IncidentRef href={`/exceptions/${b.exceptionId}`} companyLevel={b.companyLevel} scoped={scoped} className="text-accent hover:underline">
                    #{b.exceptionId}
                  </IncidentRef>{" "}
                  {b.summary}
                </li>
              ))}
            </ul>
          </div>
        )}
        {copy.decision && (
          <div className="rounded bg-warn-soft p-2 text-sm" data-testid="budget-signal-decision">
            <span className="font-semibold">{copy.decision.label}.</span> {copy.decision.text}
          </div>
        )}
        {copy.excluded.length > 0 && (
          <div className="text-sm" data-testid="budget-signal-excluded">
            <p className="font-medium text-text">Left out of the comparison</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted">
              {copy.excluded.map((text) => (
                <li key={text} className="break-words">{text}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted">
          {copy.effectiveness}{" "}
          <Link href={copy.decisionsHref} className="text-accent hover:underline">Decision readiness and effectiveness per channel →</Link>
        </p>
        <TableWrap label="Budget signal by paid channel">
          <thead><tr><Th>Paid channel</Th><Th align="right">Spend</Th><Th align="right">New customers</Th><Th align="right">Attributed cost per customer</Th></tr></thead>
          <tbody>
            {signal.channels.map((c) => {
              const e = reasonsOf.get(c.channelCode);
              const note = e ? cacNote(e.reasons) : null;
              return (
                <tr key={c.channelCode}>
                  <Td className="text-xs">
                    {c.label}
                    {e?.limitations.map((l) => <div key={l} className="text-[11px] text-faint">{l}</div>)}
                  </Td>
                  <Td align="right" className="text-xs tabular-nums">{money(c.spendCents)}</Td>
                  <Td align="right" className="text-xs tabular-nums">{count(c.acquired)}</Td>
                  <Td align="right" className="text-xs tabular-nums">
                    {money(c.cacCents)}
                    {note && <div className="text-[11px] text-faint">{note}</div>}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      </div>
    </Card>
  );
}
