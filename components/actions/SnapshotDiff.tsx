import type { ReactNode } from "react";
import { Badge } from "@/components/ui";
import { count, money } from "@/lib/format";
import { LEDGER_KEYS, LEDGER_LABEL, type StateSnapshot, type Verification } from "@/lib/workflow/snapshot";

type Fmt = (v: number | null) => string;
const cents: Fmt = (v) => money(v);
const n: Fmt = (v) => count(v);

function Row({ label, before, after, fmt, note }: { label: string; before: number | null; after: number | null; fmt: Fmt; note?: ReactNode }) {
  const changed = before !== after;
  return (
    <tr>
      <td className="py-1 pr-4 text-muted">{label}</td>
      <td className="py-1 pr-4 text-right tabular-nums">{fmt(before)}</td>
      <td className={`py-1 pr-4 text-right tabular-nums ${changed ? "font-semibold text-text" : "text-faint"}`}>{fmt(after)}</td>
      <td className="py-1 text-right">{note}</td>
    </tr>
  );
}

function TextRow({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <tr>
      <td className="py-1 pr-4 text-muted">{label}</td>
      <td className="py-1 pr-4 text-right">{before}</td>
      <td className={`py-1 pr-4 text-right ${before !== after ? "font-semibold text-text" : "text-faint"}`}>{after}</td>
      <td />
    </tr>
  );
}

/**
 * Before/after of a dry run or an execution: the exception, the ledger that must be conserved
 * (each row marked conserved / changed), and the decision numbers for the affected branch,
 * which are expected to move. Every value comes from the stored snapshot.
 */
export function SnapshotDiff({ before, after, verification }: { before: StateSnapshot; after: StateSnapshot | null; verification: Verification | null }) {
  const a = after ?? before;
  const conserved = new Map(verification?.conservation.map((c) => [c.key, c.ok]) ?? []);
  const b0 = before.branch;
  const b1 = a.branch;
  const channels = b0 && b1 ? Object.keys(b1.channels).filter((c) => b0.channels[c]?.spendCents !== b1.channels[c]?.spendCents || b0.channels[c]?.acquired !== b1.channels[c]?.acquired) : [];
  const trust = (t: boolean | undefined) => (t === undefined ? "—" : t ? "trustworthy" : "blocked");

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-faint">
              <th className="pr-4 text-left font-medium">{b0 ? `${b0.branchId} · whole period` : "Company-wide"}</th>
              <th className="pr-4 text-right font-medium">Before</th>
              <th className="pr-4 text-right font-medium">{after ? "After" : "After (not reached)"}</th>
              <th className="text-right font-medium">Check</th>
            </tr>
          </thead>
          <tbody>
            <TextRow label="Exception" before={before.exception.status} after={a.exception.status} />
            {LEDGER_KEYS.map((key) => (
              <Row
                key={key}
                label={LEDGER_LABEL[key]}
                before={before.ledger[key]}
                after={a.ledger[key]}
                fmt={key.endsWith("Cents") ? cents : n}
                note={conserved.has(key) ? <Badge tone={conserved.get(key) ? "good" : "bad"}>{conserved.get(key) ? "conserved" : "changed"}</Badge> : null}
              />
            ))}
            <Row label="Open exceptions (all branches)" before={before.openExceptionsCompanyWide} after={a.openExceptionsCompanyWide} fmt={n} />
            {b0 && b1 && (
              <>
                <Row label="Paid-media spend" before={b0.paidSpendCents} after={b1.paidSpendCents} fmt={cents} />
                <Row label="Paid-media CAC" before={b0.paidCacCents} after={b1.paidCacCents} fmt={cents} />
                <Row label="New customers from paid media" before={b0.paidAcquired} after={b1.paidAcquired} fmt={n} />
                <Row label="Unattributed new customers" before={b0.unknownAcquired} after={b1.unknownAcquired} fmt={n} />
                <Row label="New customers (all channels)" before={b0.acquired} after={b1.acquired} fmt={n} />
                <Row label={`Open exceptions at ${b0.branchId}`} before={b0.openExceptions} after={b1.openExceptions} fmt={n} />
                <TextRow label="October budget signal" before={trust(b0.budgetSignal?.trustworthy)} after={trust(b1.budgetSignal?.trustworthy)} />
                {channels.flatMap((c) => [
                  <Row key={`${c}-s`} label={`${c} spend`} before={b0.channels[c]?.spendCents ?? null} after={b1.channels[c].spendCents} fmt={cents} />,
                  <Row key={`${c}-c`} label={`${c} cost per customer`} before={b0.channels[c]?.cacCents ?? null} after={b1.channels[c].cacCents} fmt={cents} />,
                ])}
              </>
            )}
          </tbody>
        </table>
      </div>
      {verification && verification.problems.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-bad">
          {verification.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
