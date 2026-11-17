import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Badge } from "@/components/ui";
import { KIND_LABEL, count, money } from "@/lib/format";
import { PERIODS } from "@/lib/period";
import { LEDGER_KEYS, LEDGER_LABEL, type OpenExceptionRef, type StateSnapshot, type Verification } from "@/lib/workflow/snapshot";

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
 * Which of the branch's open exceptions the run closed and which it opened, by id and kind: a
 * fix can resolve its own exception and, by attributing records, surface new conflicts (B20's
 * replay closes the quarantine and opens three door-to-door / paid conflicts). The count alone
 * read as "more problems"; this names them and offers the next step. Only an executed run links:
 * a dry run's rows were rolled back and do not exist.
 */
function ExceptionChanges({ before, after, branchId, executed, linked }: { before: OpenExceptionRef[]; after: OpenExceptionRef[]; branchId: string; executed: boolean; linked: boolean }) {
  const wasOpen = new Set(before.map((e) => e.id));
  const isOpen = new Set(after.map((e) => e.id));
  const closed = before.filter((e) => !isOpen.has(e.id));
  const opened = after.filter((e) => !wasOpen.has(e.id));
  if (closed.length === 0 && opened.length === 0) return null;
  const ids = (list: OpenExceptionRef[]) =>
    list.map((e, i) => (
      <Fragment key={e.id}>
        {i > 0 && ", "}
        {linked ? (
          <Link href={`/exceptions/${e.id}`} className="text-accent hover:underline">
            #{e.id}
          </Link>
        ) : (
          `#${e.id}`
        )}
      </Fragment>
    ));
  const kinds = [...new Set(opened.map((e) => e.kind))];
  const atStake = opened.reduce((sum, e) => sum + e.amountCents, 0);
  const verb = executed ? { closed: "closed", opened: "opened" } : { closed: "would close", opened: "would open" };
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2 text-xs leading-5" data-testid="receipt-exception-changes">
      <p>
        <span className="font-medium text-text">
          At {branchId} this run {verb.closed} {closed.length}
        </span>
        {closed.length > 0 && <> ({ids(closed)})</>}{" "}
        <span className="font-medium text-text">
          and {verb.opened} {opened.length}
        </span>
        {opened.length > 0 && (
          <>
            {/* A dry run's opened rows were rolled back: their ids never existed, so only an
                executed run names them. */}
            {executed && <> ({ids(opened)})</>}: {kinds.map((k) => KIND_LABEL[k] ?? k).join(", ")}, {money(atStake)} at stake
          </>
        )}
        .
      </p>
      {opened.length > 0 &&
        (linked ? (
          <p className="mt-1">
            <Link
              href={`/exceptions?branch=${branchId}${kinds.length === 1 ? `&kind=${kinds[0]}` : ""}`}
              className="inline-flex min-h-6 items-center font-medium text-accent hover:underline"
            >
              Review the {opened.length === 1 ? "opened exception" : `${opened.length} opened exceptions`} →
            </Link>
          </p>
        ) : (
          <p className="mt-1 text-muted">{executed ? "They are outside what your role can open." : "A dry run is rolled back: they exist only once the fix is executed."}</p>
        ))}
    </div>
  );
}

/**
 * Before/after of a dry run or an execution, as a receipt: the one decision number the fix was
 * for (the branch's paid-media CAC, when it moved) set large, then what was expected to move,
 * then the ledger that must not (each row checked: conserved / changed). Every value comes from
 * the stored snapshot; nothing here is computed again.
 */
export function SnapshotDiff({
  before,
  after,
  verification,
  executed = false,
  linkExceptions = false,
}: {
  before: StateSnapshot;
  after: StateSnapshot | null;
  verification: Verification | null;
  /** True for an execution's receipt; false for a dry run, whose after-state was rolled back. */
  executed?: boolean;
  /** Link the closed and opened exceptions: the run is executed and the viewer may open them. */
  linkExceptions?: boolean;
}) {
  const a = after ?? before;
  const conserved = new Map(verification?.conservation.map((c) => [c.key, c.ok]) ?? []);
  const b0 = before.branch;
  const b1 = a.branch;
  const channels = b0 && b1 ? Object.keys(b1.channels).filter((c) => b0.channels[c]?.spendCents !== b1.channels[c]?.spendCents || b0.channels[c]?.acquired !== b1.channels[c]?.acquired) : [];
  // Trustworthy (no incident gates it) is not "free to act": a left-out channel's missing cost can
  // still hold the recommendation (snapshots stored before 2026-11-17 do not say, and read as before).
  const trust = (b: { trustworthy?: boolean; recommendation?: string } | undefined) =>
    b?.trustworthy === undefined ? "—" : b.trustworthy ? (b.recommendation === "held" ? "trustworthy, recommendation held" : "trustworthy") : "blocked";
  const cacMoved = after !== null && b0 !== null && b1 !== null && b0.paidCacCents !== b1.paidCacCents;
  // The branch numbers cover the whole demo period; name its dates, since the branch page and the
  // Overview default to October and show a different CAC for the same branch.
  const periodLabel = PERIODS.all.label;
  const scope = b0 ? `${b0.branchId} · ${periodLabel}` : "Company-wide";
  const nowTrustworthy = b0?.budgetSignal?.trustworthy === false && b1?.budgetSignal?.trustworthy === true;

  return (
    <div className="space-y-2">
      {cacMoved && (
        // The single emphasized line: what the approver approved, in the type of a money diff.
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5" data-testid="receipt-headline">
          <span className="text-xs text-muted">
            Paid-media CAC at {b0!.branchId}, {periodLabel}
          </span>{" "}
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
                <TextRow label="October budget signal" before={trust(b0.budgetSignal)} after={trust(b1.budgetSignal)} />
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
      {b0?.openExceptionList && b1?.openExceptionList && after && (
        <ExceptionChanges before={b0.openExceptionList} after={b1.openExceptionList} branchId={b0.branchId} executed={executed} linked={executed && linkExceptions} />
      )}
      {nowTrustworthy && after && (
        <p className="text-xs leading-5 text-muted" data-testid="receipt-signal-note">
          <span className="font-medium text-text">Trustworthy is not approval.</span>{" "}
          {b1!.budgetSignal.recommendation === "held"
            ? `No open incident gates ${b0!.branchId}'s October channel costs now, but the recommendation is still held: ${b1!.budgetSignal.heldBy?.[0] ?? "a channel's cost is not counted yet."}`
            : `No open incident now distorts ${b0!.branchId}'s October channel costs; whether to move budget is still a decision, and attributed cost says nothing about effectiveness.`}
        </p>
      )}
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
