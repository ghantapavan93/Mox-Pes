import type { ReactNode } from "react";
import { Badge } from "@/components/ui";
import { count, money } from "@/lib/format";
import { LEDGER_KEYS, LEDGER_LABEL, type StateSnapshot, type Verification } from "@/lib/workflow/snapshot";

type Fmt = (v: number | null) => string;
const cents: Fmt = (v) => money(v);
const n: Fmt = (v) => count(v);

/** The row's label as a row header, so each value is announced with what it measures. */
function RowHeader({ label }: { label: string }) {
  return (
    <th scope="row" className="py-1.5 pr-4 text-left font-normal text-muted">
      {label}
    </th>
  );
}

/** Change is shown by weight and the "=" mark; this says it in words for screen readers. */
function ChangeText({ changed }: { changed: boolean }) {
  return <span className="sr-only">{changed ? " (changed)" : " (unchanged)"}</span>;
}

/**
 * The after value. A value that moved is ink and semibold; one that did not is muted behind an
 * "=" mark (a receipt's "unchanged"), so the eye finds the few lines that moved.
 */
function After({ text, changed }: { text: string; changed: boolean }) {
  return (
    <td className="py-1.5 pr-4 text-right tabular-nums">
      {changed ? (
        <span className="font-semibold text-text">{text}</span>
      ) : (
        <span className="text-muted">
          <span aria-hidden className="mr-1 text-faint">
            =
          </span>
          {text}
        </span>
      )}
      <ChangeText changed={changed} />
    </td>
  );
}

function Row({ label, before, after, fmt, note }: { label: string; before: number | null; after: number | null; fmt: Fmt; note?: ReactNode }) {
  return (
    <tr>
      <RowHeader label={label} />
      <td className="py-1.5 pr-4 text-right tabular-nums text-muted">{fmt(before)}</td>
      <After text={fmt(after)} changed={before !== after} />
      <td className="py-1.5 text-right">{note}</td>
    </tr>
  );
}

function TextRow({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <tr>
      <RowHeader label={label} />
      <td className="py-1.5 pr-4 text-right text-muted">{before}</td>
      <After text={after} changed={before !== after} />
      <td />
    </tr>
  );
}

/** A labelled group of rows: what was expected to move, and the ledger that must not. */
function Section({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <tbody>
      <tr>
        <th scope="rowgroup" colSpan={4} className="pb-1 pt-3 text-left text-[11px] font-medium uppercase tracking-wider text-faint">
          {title} <span className="font-normal normal-case tracking-normal">· {detail}</span>
        </th>
      </tr>
      {children}
    </tbody>
  );
}

/**
 * Before/after of a dry run or an execution, as a receipt: the one decision number the fix was
 * for (the branch's paid-media CAC, when it moved) set large, then what was expected to move,
 * then the ledger that must not (each row checked: conserved / changed). Every value comes from
 * the stored snapshot; nothing here is computed again.
 */
export function SnapshotDiff({ before, after, verification }: { before: StateSnapshot; after: StateSnapshot | null; verification: Verification | null }) {
  const a = after ?? before;
  const conserved = new Map(verification?.conservation.map((c) => [c.key, c.ok]) ?? []);
  const b0 = before.branch;
  const b1 = a.branch;
  const channels = b0 && b1 ? Object.keys(b1.channels).filter((c) => b0.channels[c]?.spendCents !== b1.channels[c]?.spendCents || b0.channels[c]?.acquired !== b1.channels[c]?.acquired) : [];
  const trust = (t: boolean | undefined) => (t === undefined ? "—" : t ? "trustworthy" : "blocked");
  const cacMoved = after !== null && b0 !== null && b1 !== null && b0.paidCacCents !== b1.paidCacCents;
  const scope = b0 ? `${b0.branchId} · whole period` : "Company-wide";

  return (
    <div className="space-y-2">
      {cacMoved && (
        // The single emphasized line: what the approver approved, in the type of a money diff.
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5" data-testid="receipt-headline">
          <span className="text-xs text-muted">Paid-media CAC at {b0!.branchId}, whole period</span>{" "}
          <span className="text-[22px] font-semibold leading-7 tracking-tight tabular-nums text-text">
            <span className="text-muted">{cents(b0!.paidCacCents)}</span>
            <span aria-hidden className="mx-1.5 text-faint">
              →
            </span>
            <span className="sr-only"> to </span>
            {cents(b1!.paidCacCents)}
          </span>
        </p>
      )}
      <div className="overflow-x-auto" role="region" aria-label="Ledger before and after" tabIndex={0}>
        <table className="w-full min-w-[420px] text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-faint">
              <th scope="col" className="pr-4 text-left font-medium">{scope}</th>
              <th scope="col" className="pr-4 text-right font-medium">Before</th>
              <th scope="col" className="pr-4 text-right font-medium">{after ? "After" : "After (not reached)"}</th>
              <th scope="col" className="text-right font-medium">Check</th>
            </tr>
          </thead>
          <Section title="Expected to move" detail="what the fix is for">
            <TextRow label="Exception" before={before.exception.status} after={a.exception.status} />
            {b0 && b1 && (
              <>
                <Row label="Paid-media CAC" before={b0.paidCacCents} after={b1.paidCacCents} fmt={cents} />
                <Row label="New customers from paid media" before={b0.paidAcquired} after={b1.paidAcquired} fmt={n} />
                <Row label="Unattributed new customers" before={b0.unknownAcquired} after={b1.unknownAcquired} fmt={n} />
                <Row label="New customers (all channels)" before={b0.acquired} after={b1.acquired} fmt={n} />
                <Row label="Paid-media spend" before={b0.paidSpendCents} after={b1.paidSpendCents} fmt={cents} />
                <Row label={`Open exceptions at ${b0.branchId}`} before={b0.openExceptions} after={b1.openExceptions} fmt={n} />
                <TextRow label="October budget signal" before={trust(b0.budgetSignal?.trustworthy)} after={trust(b1.budgetSignal?.trustworthy)} />
                {channels.flatMap((c) => [
                  <Row key={`${c}-s`} label={`${c} spend`} before={b0.channels[c]?.spendCents ?? null} after={b1.channels[c].spendCents} fmt={cents} />,
                  <Row key={`${c}-c`} label={`${c} cost per customer`} before={b0.channels[c]?.cacCents ?? null} after={b1.channels[c].cacCents} fmt={cents} />,
                ])}
              </>
            )}
            <Row label="Open exceptions (all branches)" before={before.openExceptionsCompanyWide} after={a.openExceptionsCompanyWide} fmt={n} />
          </Section>
          <Section title="Ledger" detail="must not move; a change rolls the fix back">
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
          </Section>
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
