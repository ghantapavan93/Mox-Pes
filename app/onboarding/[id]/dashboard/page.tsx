import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { CountPrivately } from "@/components/onboarding/CountPrivately";
import { Badge, ButtonLink, Card, KpiTile, PageHeader, Skeleton, Stat, StatDelta, TableWrap, Td, Th } from "@/components/ui";
import { ActionError } from "@/lib/actions";
import { KIND_LABEL, count, money, pct } from "@/lib/format";
import type { BranchFigures, Figures } from "@/lib/metrics/dashboard-snapshot";
import { WORKSPACE_NOT_AVAILABLE, onboardingAccess } from "@/lib/onboarding/access";
import { getUpload, type UploadPreview } from "@/lib/onboarding/service";
import { PERIODS } from "@/lib/period";
import { parseRecordId } from "@/lib/record-id";
import { businessNow, getPool, getViewer } from "@/lib/server";

type Props = { params: Promise<{ id: string }> };

export const metadata = { title: "Your dashboard" };

/**
 * /onboarding/:id/dashboard — a visitor's dashboard with their file counted (sharing review,
 * 2026-11-19: "the dashboard has to change along with the data that is uploaded"). Every figure is
 * the stored result of previewUpload (lib/onboarding/service.ts): the file counted in a copy of the
 * ledger that was rolled back, the dashboard read before and after with the queries the shared
 * pages use (lib/metrics/dashboard-snapshot.ts). Only the upload's owner may open it; to anyone
 * else it is the same "not available" page as the upload itself.
 */
export default function YourDashboardPage(props: Props) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <YourDashboard {...props} />
    </Suspense>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;
/** "a, b and c": figures contain commas of their own, so the list is joined, never split back. */
const listed = (parts: string[]) => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

async function YourDashboard({ params }: Props) {
  const uploadId = parseRecordId((await params).id);
  const viewer = await getViewer();
  // Staff publish for everyone instead: a private copy is the public demo's (and a visitor's) own.
  if (onboardingAccess(viewer) !== "workspace" || uploadId === null) notFound();
  let detail;
  try {
    detail = await getUpload(getPool(), viewer, uploadId, await businessNow());
  } catch (error) {
    if (error instanceof ActionError && error.status === 404) return <NotAvailable />;
    throw error;
  }
  const dry = detail.dryRun;
  const preview = dry?.preview ?? null;
  const filename = detail.upload.filename;
  if (!preview) {
    const canCount = detail.upload.status === "staged" && dry !== null && (dry.counts.eligible ?? 0) > 0;
    return (
      <div className="space-y-6">
        <PageHeader crumbs={[{ href: "/onboarding", label: "Data onboarding" }, { href: `/onboarding/${uploadId}`, label: filename }, { label: "Your dashboard" }]} title="Your dashboard" />
        <Card testId="not-counted">
          <p className="text-sm">
            {canCount
              ? `${filename} has not been counted yet. Counting it runs its ${plural(dry!.counts.eligible, "new row")} through the ledger's intake in a private copy that is rolled back, then shows the dashboard as it would read.`
              : dry
                ? `${filename} has no new rows to count: its rows are already in the ledger, or none passed the checks.`
                : `Run the dry run on ${filename} first.`}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            {canCount && <CountPrivately uploadId={uploadId} />}
            <ButtonLink href={`/onboarding/${uploadId}`}>Back to the upload</ButtonLink>
          </div>
        </Card>
      </div>
    );
  }
  return <Dashboard uploadId={uploadId} filename={filename} preview={preview} />;
}

function NotAvailable() {
  return (
    <div className="space-y-6">
      <PageHeader crumbs={[{ href: "/onboarding", label: "Data onboarding" }, { label: "Not available" }]} title="This dashboard is not available" />
      <Card testId="workspace-not-available">
        <p className="text-sm">{WORKSPACE_NOT_AVAILABLE}</p>
        <div className="mt-3">
          <ButtonLink href="/onboarding" variant="primary">
            Upload a file
          </ButtonLink>
        </div>
      </Card>
    </div>
  );
}

/** "was $263.34 · −$1.20", coloured by whether the move is good for this figure; "unchanged" when equal. */
function change(before: number | null, after: number | null, format: (v: number) => string, lowerIsBetter: boolean | null, diffFormat: (v: number) => string = format) {
  if (before === after || before === null || after === null) return { label: before === after ? "unchanged" : `was ${before === null ? "—" : format(before)}`, direction: "flat" as const, good: null };
  const diff = after - before;
  return {
    label: `was ${format(before)} · ${diff > 0 ? "+" : "−"}${diffFormat(Math.abs(diff))}`,
    direction: diff > 0 ? ("up" as const) : ("down" as const),
    good: lowerIsBetter === null ? null : lowerIsBetter ? diff < 0 : diff > 0,
  };
}

const share = (v: number) => pct(v, 1);
const points = (v: number) => `${(v * 100).toFixed(1)} pts`;
const cents = (v: number) => money(v);

/** One cell: before → after, the after in ink, and nothing struck when they are equal. */
function Move({ before, after, format }: { before: number | null; after: number | null; format: (v: number | null) => string }) {
  if (before === after) return <span className="text-muted">{format(after)}</span>;
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted">{format(before)}</span>
      <span aria-hidden className="mx-1 text-faint">→</span>
      <span className="sr-only"> to </span>
      <span className="font-semibold text-text">{format(after)}</span>
    </span>
  );
}

function Dashboard({ uploadId, filename, preview }: { uploadId: number; filename: string; preview: UploadPreview }) {
  const { company, branches, branchesChanged, opened, closed, held } = preview.change;
  const b = company.before;
  const a = company.after;
  const top = branches[0] ?? null;
  // The figures are October's: the period a budget decision is made on (lib/metrics/dashboard-snapshot.ts).
  const period = PERIODS.oct;
  const reconcileOnly = preview.authority === "reconcile";
  const unchanged = [
    a.paidSpendCents === b.paidSpendCents && `paid media spend (${money(a.paidSpendCents)})`,
    a.acquired === b.acquired && `new customers serviced (${count(a.acquired)})`,
    a.collectedCents === b.collectedCents && `collected revenue (${money(a.collectedCents)})`,
  ].filter(Boolean) as string[];
  const heldChanged = held.before.join() !== held.after.join();

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ href: "/onboarding", label: "Data onboarding" }, { href: `/onboarding/${uploadId}`, label: filename }, { label: "Your dashboard" }]}
        eyebrow={`Your private copy · all 44 branches · ${period.label}`}
        title="Your dashboard, with your file counted"
        badges={<Badge tone="accent">private copy</Badge>}
        description={
          <p className="max-w-3xl" data-testid="your-scope">
            {filename}: {plural(preview.counted.rows, "row")} counted in a copy of the ledger that was then rolled back. Only you see these figures; the
            shared dashboard and every other visitor&apos;s numbers did not move.
            {reconcileOnly ? " This dataset is never added to the shared ledger, from any file: this shows what the dashboard would read if its new rows were counted." : ""}
          </p>
        }
      />

      <section aria-labelledby="your-headline-title" className="rounded-xl bg-accent-soft p-4 ring-1 ring-accent/30" data-testid="your-headline">
        <h2 id="your-headline-title" className="text-xs font-semibold uppercase tracking-wider text-accent">
          What your file changed
        </h2>
        <p className="mt-1 text-lg font-semibold leading-7 text-text">
          {top && top.before.paidCacCents !== top.after.paidCacCents
            ? `${top.after.branchId} ${top.after.name}'s paid-media CAC moves from ${money(top.before.paidCacCents)} to ${money(top.after.paidCacCents)}.`
            : branchesChanged > 0
              ? `${plural(branchesChanged, "branch", "branches")} moved; no branch's paid-media CAC did.`
              : "No dashboard figure moved: the file's rows are already in the ledger, or name no customer it knows."}
        </p>
        {top && (
          <p className="mt-1 text-sm leading-6 text-muted">
            {top.after.paidAcquired !== top.before.paidAcquired
              ? `${plural(Math.abs(top.after.paidAcquired - top.before.paidAcquired), "customer")} ${top.after.paidAcquired > top.before.paidAcquired ? "gained the paid touch that brought them" : "lost a paid first touch"}: paid first-touch customers ${count(top.before.paidAcquired)} → ${count(top.after.paidAcquired)}, unattributed share ${share(top.before.unknownShare ?? 0)} → ${share(top.after.unknownShare ?? 0)}. `
              : ""}
            {top.after.paidSpendCents === top.before.paidSpendCents ? `Its paid media spend did not change (${money(top.after.paidSpendCents)}).` : `Its paid media spend moved ${money(top.before.paidSpendCents)} → ${money(top.after.paidSpendCents)}.`}
          </p>
        )}
      </section>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="your-tiles">
        <Stat metric="paidCac" value={money(a.paidCacCents)} delta={change(b.paidCacCents, a.paidCacCents, cents, true)} sub="All branches, your copy" />
        <KpiTile label="Customers whose first touch was paid" value={count(a.paidAcquired)} sub={<StatDelta delta={change(b.paidAcquired, a.paidAcquired, (v) => count(v), false)} />} testId="your-paid-customers" />
        <Stat metric="unknownShare" value={share(a.unknownShare ?? 0)} delta={change(b.unknownShare, a.unknownShare, share, true, points)} />
        <Stat metric="prospects" value={count(a.prospects)} delta={change(b.prospects, a.prospects, (v) => count(v), null)} sub={`${count(a.paidProspects)} paid`} />
        <Stat metric="atRisk" value={money(a.atRiskCents)} delta={change(b.atRiskCents, a.atRiskCents, cents, true)} sub={`${plural(a.openExceptions, "open exception")}`} />
        <Stat metric="paidSpend" value={money(a.paidSpendCents)} delta={change(b.paidSpendCents, a.paidSpendCents, cents, null)} />
      </div>

      {unchanged.length > 0 && (
        <p className="text-sm text-muted" data-testid="your-unchanged">
          <span className="font-medium text-text">What did not change: </span>
          {listed(unchanged)}. {unchanged.length === 3 ? "Only which channel gets the credit moved." : ""}
        </p>
      )}

      <Card
        title={branchesChanged > 0 ? `Branches your file moved (${count(branchesChanged)})` : "Branches your file moved"}
        subtitle={`Before → after in your copy, ${period.label}. A branch's shared page still shows the shared figures.`}
        testId="your-branches"
      >
        {branches.length === 0 ? (
          <p className="text-sm text-muted">No branch&apos;s figures moved.</p>
        ) : (
          <TableWrap label="Branches your file moved" minWidth={760}>
            <thead>
              <tr>
                <Th>Branch</Th>
                <Th align="right">Paid-media CAC</Th>
                <Th align="right">Paid first-touch customers</Th>
                <Th align="right">Unattributed share</Th>
                <Th align="right">Unique prospects</Th>
                <Th align="right">Open exceptions</Th>
                <Th>Shared page</Th>
              </tr>
            </thead>
            <tbody>
              {branches.map(({ before, after }) => (
                <BranchRowView key={after.branchId} before={before} after={after} />
              ))}
            </tbody>
          </TableWrap>
        )}
        {branchesChanged > branches.length && <p className="mt-2 text-xs text-muted">The {count(branches.length)} that moved most are listed.</p>}
      </Card>

      {(opened.length > 0 || closed > 0 || heldChanged) && (
        <Card title="Incidents in your copy" subtitle="Reconciliation ran over the whole ledger with your file counted, as it does after every intake." testId="your-incidents">
          <ul className="space-y-1 text-sm">
            {opened.length > 0 && (
              <li>
                It would open {plural(opened.length, "incident")}:{" "}
                {[...new Set(opened.map((e) => `${KIND_LABEL[e.kind] ?? e.kind}${e.branchId ? ` at ${e.branchId}` : ""}`))].join(", ")}.
              </li>
            )}
            {closed > 0 && <li>It would close {plural(closed, "incident")}.</li>}
            {heldChanged && (
              <li>
                Budget decisions held: {held.before.join(", ") || "none"} before; {held.after.join(", ") || "none"} with your file.
              </li>
            )}
          </ul>
        </Card>
      )}

      <Card title="How your copy was counted" testId="your-how">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-6 text-muted">
          <li>Your file&apos;s {plural(preview.counted.rows, "new row")} went through the intake a live feed uses: the deployed mapper, its checks, and the rule that a file adds what the ledger lacks and never changes what it holds.</li>
          <li>Reconciliation ran over the whole ledger, as after every intake, so incidents and holds move with your file.</li>
          <li>The dashboard was read before and after with the same queries the shared pages use.</li>
          <li>Then the copy was rolled back. Nothing of your file is in the ledger; only these figures are kept, with your upload, until it is deleted.</li>
        </ol>
        <div className="mt-4 flex flex-wrap gap-3">
          <ButtonLink href={`/onboarding/${uploadId}`}>Back to your upload</ButtonLink>
          <ButtonLink href="/?period=oct">The shared Overview</ButtonLink>
          <ButtonLink href="/onboarding">Upload another file</ButtonLink>
        </div>
      </Card>
    </div>
  );
}

function BranchRowView({ before, after }: { before: BranchFigures; after: BranchFigures }): ReactNode {
  const f = (k: keyof Figures, format: (v: number | null) => string) => <Move before={before[k] as number | null} after={after[k] as number | null} format={format} />;
  return (
    <tr>
      <Td className="whitespace-nowrap font-medium">
        {after.branchId} {after.name}
      </Td>
      <Td align="right">{f("paidCacCents", (v) => money(v))}</Td>
      <Td align="right">{f("paidAcquired", (v) => count(v))}</Td>
      <Td align="right">{f("unknownShare", (v) => (v === null ? "—" : share(v)))}</Td>
      <Td align="right">{f("prospects", (v) => count(v))}</Td>
      <Td align="right">{f("openExceptions", (v) => count(v))}</Td>
      <Td>
        <Link href={`/branches/${after.branchId}?period=oct`} className="inline-flex min-h-6 items-center text-sm font-medium text-accent hover:underline">
          {after.branchId} →
        </Link>
      </Td>
    </tr>
  );
}
