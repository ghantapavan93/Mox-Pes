import Link from "next/link";
import { Badge, Callout, Card, KV, TableWrap, Td, Th } from "@/components/ui";
import { count, dateTime } from "@/lib/format";
import type { CashTrace } from "@/lib/lineage/cash";
import { exactDollars } from "@/lib/lineage/trace";

/** Rows shown before the rest folds away: the answer first, every record one click further. */
const FIRST_ROWS = 25;

function RecordLink({ id }: { id: string }) {
  const [kind, key] = id.split(":");
  const href = kind === "customer" ? `/customers/${key}` : kind === "exception" ? `/exceptions/${key}` : null;
  return href ? (
    <Link href={href} className="break-all font-mono text-[11px] text-accent hover:underline">
      {id}
    </Link>
  ) : (
    <span className="break-all font-mono text-[11px] text-faint">{id}</span>
  );
}

function PaymentRows({ rows }: { rows: CashTrace["payments"]["rows"] }) {
  return (
    <>
      {rows.map((r) => (
        <tr key={r.evidenceId}>
          <Td>{dateTime(r.paidAt)}</Td>
          <Td>
            <span className="font-mono text-xs">{r.crmPaymentId}</span>
          </Td>
          <Td>
            <RecordLink id={r.customerEvidenceId} />
          </Td>
          <Td>{r.kind === "refund" ? <Badge tone="warn">refund</Badge> : "payment"}</Td>
          <Td>{r.originalPaymentId ? <span className="font-mono text-xs">of {r.originalPaymentId}</span> : ""}</Td>
          <Td align="right">{exactDollars(r.amountCents)}</Td>
        </tr>
      ))}
    </>
  );
}

/**
 * Where a branch's collected cash comes from (lib/lineage/cash.ts): the figure, the same figure
 * reproduced from the stored payment records, the definitions with their versions, the money
 * invariants, what the definition leaves out, and every payment and refund. Computes nothing:
 * every figure is the trace's.
 *
 * Levels: (1) does it reproduce, and the figure; (2) gross, refunds, new-customer cash and revenue
 * at risk, with the invariants; (3) the records, the first 25 shown and the rest folded; (4) links
 * to each customer and exception.
 */
export function CashTraceView({ trace, branchLabel }: { trace: CashTrace; branchLabel: string }) {
  const v = trace.value;
  const r = v.reproduced;
  const rows = trace.payments.rows;
  const broken = trace.invariants.filter((i) => !i.holds);
  return (
    <div className="space-y-6" data-testid="cash-trace">
      {v.matches ? (
        <Callout tone="good" title="Reproduced from the payment records below" testId="cash-reproduced">
          {`${exactDollars(r.grossCents)} paid − ${exactDollars(r.refundsCents)} refunded = ${exactDollars(r.collectedCents)} collected, from ${count(trace.payments.count - trace.payments.refunds)} payment(s) and ${count(trace.payments.refunds)} refund(s) dated in ${trace.scope.period.label}: the same as the scorecard to the cent.`}
        </Callout>
      ) : (
        <Callout tone="bad" title="The payment records do not add up to the scorecard" testId="cash-discrepancy">
          <ul className="list-disc pl-5">
            {v.discrepancies.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </Callout>
      )}
      {broken.length > 0 && (
        <Callout tone="bad" title={`${broken.length} money invariant(s) broken`} testId="cash-invariants-broken">
          <ul className="list-disc pl-5">
            {broken.map((i) => (
              <li key={i.name}>
                {i.name}: {i.detail}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="The figures" subtitle={`${branchLabel} · CRM office ${trace.scope.officeId} · ${trace.scope.period.label}`}>
          <KV
            columns={1}
            items={[
              ["Collected cash", <strong key="c" data-testid="cash-collected">{exactDollars(r.collectedCents)}</strong>],
              ["Gross payments", exactDollars(r.grossCents)],
              ["Refunds paid out", exactDollars(r.refundsCents)],
              ["Collected from the period's new customers (to date)", `${exactDollars(r.newCollectedCents)} from ${count(trace.newCustomers.count)} customer(s)`],
              ["Revenue in open exceptions (at risk)", `${exactDollars(r.atRiskCents)} across ${count(trace.atRisk.customers)} customer(s)`],
            ]}
          />
        </Card>
        <Card title="Definitions" subtitle="As the scorecard computes them">
          <ul className="space-y-2 text-sm" data-testid="cash-definitions">
            {trace.definitions.map((d) => (
              <li key={d.key}>
                <span className="font-medium">{d.label}</span> <span className="text-faint">· version {d.version}</span>
                <div className="text-muted">{d.formula}</div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Money invariants" subtitle="Checked on every trace; a broken one is shown above">
          <ul className="space-y-1 text-sm" data-testid="cash-invariants">
            {trace.invariants.map((i) => (
              <li key={i.name} className="flex gap-2">
                <span className={i.holds ? "text-good" : "text-bad"} aria-hidden="true">
                  {i.holds ? "✓" : "✗"}
                </span>
                <span className="sr-only">{i.holds ? "Holds:" : "Broken:"}</span>
                <span className="min-w-0 break-words">
                  {i.name} <span className="text-faint">({i.detail})</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Left out by the definition" subtitle={trace.excluded.length ? `${trace.excluded.length} kind(s)` : "Nothing"}>
          {trace.excluded.length === 0 ? (
            <p className="text-sm text-muted">No failed or voided payment, and every refund names a stored original.</p>
          ) : (
            <ul className="space-y-2 text-sm" data-testid="cash-excluded">
              {trace.excluded.map((e) => (
                <li key={e.code}>
                  <Badge tone="warn">{e.code.replace(/_/g, " ").toLowerCase()}</Badge> {e.reason}: {count(e.count)} record(s), {exactDollars(e.amountCents)}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {trace.atRisk.exceptions.length > 0 && (
        <Card title="Open exceptions holding revenue at risk" subtitle="Each customer counts once, however many exceptions name them">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {trace.atRisk.exceptions.map((e) => (
              <li key={e.evidenceId}>
                <RecordLink id={e.evidenceId} /> <span className="text-muted">{e.kind.replace(/_/g, " ")} · {count(e.customers)} customer(s)</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Payments and refunds" subtitle={`${count(trace.payments.count)} successful record(s) dated in the period${trace.payments.truncated ? ` · the first ${rows.length} are listed` : ""}`}>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">No successful payment or refund is dated in this period.</p>
        ) : (
          <>
            <TableWrap label="Payments and refunds" testId="cash-payments" minWidth={720}>
              <thead>
                <tr>
                  <Th>Paid at</Th>
                  <Th>Payment</Th>
                  <Th>Customer</Th>
                  <Th>Kind</Th>
                  <Th>Original</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                <PaymentRows rows={rows.slice(0, FIRST_ROWS)} />
              </tbody>
            </TableWrap>
            {rows.length > FIRST_ROWS && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-accent">Show the other {rows.length - FIRST_ROWS} record(s)</summary>
                <TableWrap label="More payments and refunds" minWidth={720}>
                  <thead>
                    <tr>
                      <Th>Paid at</Th>
                      <Th>Payment</Th>
                      <Th>Customer</Th>
                      <Th>Kind</Th>
                      <Th>Original</Th>
                      <Th align="right">Amount</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <PaymentRows rows={rows.slice(FIRST_ROWS)} />
                  </tbody>
                </TableWrap>
              </details>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
