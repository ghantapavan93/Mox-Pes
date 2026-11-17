import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { KIND_LABEL, count, dateTime, money } from "@/lib/format";
import { PERIODS } from "@/lib/period";
import type { ExceptionRow } from "@/lib/queries";
import { getPool } from "@/lib/server";
import { canSeeBranch, type Viewer } from "@/lib/viewer";
import { KIND_TITLE } from "@/lib/workflow/kinds";
import { caseForException, caseProposals } from "@/lib/workflow/queries";

/**
 * A resolved incident leads with what its fix did: the decision number it moved and why, what did
 * not move, and what is still open with its next step. Every value comes from the execution's
 * stored receipt (its before/after snapshots); nothing is computed again, and a sentence about what
 * did not change is said only when the stored values are equal. The receipt itself stays below, in
 * the workflow, one link away.
 *
 * Shown for an executed fix that moved the branch's paid-media CAC (B20's replay is the case it
 * was built for). An incident with its own decision panel (a coverage gap, a refused revision)
 * leads with that panel instead.
 */
export async function FixResult({ exception, viewer }: { exception: ExceptionRow; viewer: Viewer }) {
  if (exception.status !== "resolved") return null;
  const pool = getPool();
  const kase = await caseForException(pool, exception.id);
  if (!kase) return null;
  const proposal = (await caseProposals(pool, kase.id)).find((p) => p.execution?.status === "succeeded" && p.execution.before?.branch && p.execution.after?.branch);
  const execution = proposal?.execution;
  if (!proposal || !execution) return null;
  const b0 = execution.before!.branch!;
  const b1 = execution.after!.branch!;
  if (b0.paidCacCents === b1.paidCacCents) return null;

  const branchId = b0.branchId;
  const moreToPaid = b1.paidAcquired - b0.paidAcquired;
  const fewerUnattributed = b0.unknownAcquired - b1.unknownAcquired;
  const replayed = Number(execution.result?.projected ?? execution.result?.requested ?? 0);
  const source = typeof exception.evidence?.source === "string" ? exception.evidence.source : null;
  const what = source === "calls" ? "calls" : source ? `${source} records` : "records";
  const ledgerConserved = execution.verification?.conservation.every((c) => c.ok) ?? false;
  const spendSame = b0.paidSpendCents === b1.paidSpendCents;
  const customersSame = b0.acquired === b1.acquired;
  const wasOpen = new Set((b0.openExceptionList ?? []).map((e) => e.id));
  const opened = b0.openExceptionList && b1.openExceptionList ? b1.openExceptionList.filter((e) => !wasOpen.has(e.id)) : [];
  const openedKinds = [...new Set(opened.map((e) => e.kind))];
  const canOpen = canSeeBranch(viewer, branchId);

  return (
    <section aria-labelledby="fix-result-title" className="overflow-hidden rounded-xl bg-surface ring-1 ring-text/10" data-testid="fix-result">
      <div className="flex items-start gap-2 bg-good-soft px-4 py-2.5">
        <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-good" />
        <p className="min-w-0 text-sm leading-5">
          <span id="fix-result-title" className="font-semibold text-text">
            Fixed and verified
          </span>
          <span className="text-muted">
            {" "}
            · proposal #{proposal.id} {KIND_TITLE[proposal.kind]} · {dateTime(execution.finishedAt)}
          </span>
        </p>
      </div>
      <div className="space-y-3 px-4 py-3">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="text-xs text-muted">
            Paid-media CAC at {branchId}, {PERIODS.all.label}
          </span>{" "}
          <span className="text-[22px] font-semibold leading-7 tracking-tight tabular-nums text-text" data-testid="fix-result-cac">
            <span className="text-muted">{money(b0.paidCacCents)}</span>
            <span aria-hidden className="mx-1.5 text-faint">
              →
            </span>
            <span className="sr-only"> to </span>
            {money(b1.paidCacCents)}
          </span>
        </p>
        <dl className="grid gap-x-6 gap-y-2 text-sm leading-6 md:grid-cols-[8rem_minmax(0,1fr)]">
          <dt className="font-medium text-text">Why it moved</dt>
          <dd className="text-muted" data-testid="fix-result-why">
            {proposal.kind === "replay_quarantine" && replayed > 0 ? `Replaying the ${count(replayed)} held ${what} attached lead records to customers who had none: ` : "Attribution changed: "}
            {count(fewerUnattributed)} fewer unattributed ({count(b0.unknownAcquired)} → {count(b1.unknownAcquired)}), {count(moreToPaid)} more credited to paid media (
            {count(b0.paidAcquired)} → {count(b1.paidAcquired)}).
          </dd>
          {(spendSame || customersSame || ledgerConserved) && (
            <>
              <dt className="font-medium text-text">What did not</dt>
              <dd className="text-muted" data-testid="fix-result-unchanged">
                {[spendSame && `paid-media spend (${money(b1.paidSpendCents)})`, customersSame && `new customers on all channels (${count(b1.acquired)})`].filter(Boolean).join(" and ")}
                {(spendSame || customersSame) && " did not change"}
                {ledgerConserved && `${spendSame || customersSame ? "; " : ""}the five ledger totals were conserved`}.
              </dd>
            </>
          )}
          <dt className="font-medium text-text">Still open</dt>
          <dd className="text-muted" data-testid="fix-result-open">
            {opened.length > 0 ? (
              <>
                The run opened {count(opened.length)} {openedKinds.map((k) => KIND_LABEL[k] ?? k).join(", ")} {opened.length === 1 ? "exception" : "exceptions"} at {branchId} (
                {money(opened.reduce((s, e) => s + e.amountCents, 0))} at stake).{" "}
                {canOpen && (
                  <Link
                    href={`/exceptions?branch=${branchId}${openedKinds.length === 1 ? `&kind=${openedKinds[0]}` : ""}`}
                    className="inline-flex min-h-6 items-center font-medium text-accent hover:underline"
                    data-testid="fix-result-next"
                  >
                    Review {opened.length === 1 ? "it" : "them"} →
                  </Link>
                )}
              </>
            ) : (
              <>
                {count(b1.openExceptions)} open {b1.openExceptions === 1 ? "exception" : "exceptions"} at {branchId}.
              </>
            )}
            {b1.budgetSignal?.trustworthy && <> The October budget signal is now trustworthy: its inputs agree, and moving budget is still a decision.</>}
          </dd>
        </dl>
        <p className="text-xs">
          <a href={`#proposal-${proposal.id}-execution`} className="inline-flex min-h-6 items-center font-medium text-accent hover:underline">
            The full receipt: every number before and after ↓
          </a>
        </p>
      </div>
    </section>
  );
}
