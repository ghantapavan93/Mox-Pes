import Link from "next/link";
import { Suspense } from "react";
import { Badge, Card, Forbidden, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { B09_STEPS, PATH_SECONDS, ROLE_LABEL, stepHref } from "@/lib/demo/b09-path";
import { getPool, getViewer } from "@/lib/server";
import { canSeeBranch } from "@/lib/viewer";

export const metadata = { title: "Guided path" };

/**
 * /demo — the presenter page for the four-minute B09 golden path (lib/demo/b09-path.ts).
 * Resolves the incident's exception id from the database (ids are not stable across seeds) and
 * says whether the path can be presented as-is or the demo database needs a reseed first.
 */
export default function DemoPage() {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <Demo />
    </Suspense>
  );
}

async function Demo() {
  // The path is about B09 and quotes its figures: a viewer who may not see B09 does not see it
  // (UX red team 2026-11-12, P0: a branch partner and a brand lead read B09's incident here while
  // /branches/B09 refused them).
  const viewer = await getViewer();
  if (!canSeeBranch(viewer, "B09")) return <Forbidden message={`The guided path is about branch B09, which is outside your scope (${viewer.label}).`} />;
  const { rows } = await getPool().query<{ id: string; status: string }>(
    "select id, status from exceptions where kind = 'channel_coverage_gap' and branch_id = 'B09' order by id desc limit 1",
  );
  const gap = rows[0] ? { id: Number(rows[0].id), status: rows[0].status } : null;
  const ready = gap?.status === "open";
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  // Start time of each step: the sum of the steps before it.
  const starts = B09_STEPS.map((_, i) => B09_STEPS.slice(0, i).reduce((t, x) => t + x.seconds, 0));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">The four-minute path: B09</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          One incident from the number a marketer would act on to the audit row that proves who changed what. Synthetic data: Google&apos;s Local
          Services → Performance Max change is real; this branch, its dates and the pipeline failure are invented.
        </p>
      </div>

      <Card title="Before you start" subtitle="The path changes data (step 6 executes a re-map), so it runs once per seed">
        {gap === null ? (
          <p className="text-sm text-bad" data-testid="demo-state">No B09 coverage-gap incident in this database. Run <code>npm run db:seed</code>.</p>
        ) : ready ? (
          <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="demo-state">
            <Badge tone="good">Ready</Badge>
            <span>Incident #{gap.id} is open.</span>
            <Link href={stepHref(B09_STEPS[0], gap.id)} className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:opacity-90" data-testid="demo-start">
              Start the path →
            </Link>
          </div>
        ) : (
          <p className="text-sm text-warn" data-testid="demo-state">
            Incident #{gap.id} is already {gap.status}: this database has been through the path. Reseed with <code>npm run db:seed</code> (about two
            minutes) to present it again, or <Link className="text-accent hover:underline" href={stepHref(B09_STEPS[6], gap.id)}>open the result</Link>.
          </p>
        )}
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
          <li>Roles switch three times (marketing → engineer → approver). The bar at the top of each step has a “Use this role” button.</li>
          <li>Every step&apos;s numbers are pinned in tests/fixtures/b09-golden.json and checked in the browser by the four-minute-path test.</li>
        </ul>
      </Card>

      <Card title={`Eight steps · ${clock(PATH_SECONDS)}`}>
        {/* TableWrap renders the <table>; a second one inside it is invalid HTML and broke hydration. */}
        <TableWrap label="Guided path steps" testId="demo-steps">
            <thead>
              <tr>
                <Th>#</Th>
                <Th>Step</Th>
                <Th>Time</Th>
                <Th>Role</Th>
                <Th>Show</Th>
                <Th>Say</Th>
              </tr>
            </thead>
            <tbody>
              {B09_STEPS.map((s, i) => {
                const from = starts[i];
                const to = from + s.seconds;
                return (
                  <tr key={s.n} className="border-t border-border align-top">
                    <Td>{s.n}</Td>
                    <Td>{gap ? <Link href={stepHref(s, gap.id)} className="font-medium text-accent hover:underline">{s.title}</Link> : s.title}</Td>
                    <Td className="whitespace-nowrap text-xs tabular-nums text-muted">{clock(from)}–{clock(to)}</Td>
                    <Td className="whitespace-nowrap text-xs">{ROLE_LABEL[s.role]}</Td>
                    <Td className="text-xs">
                      <ul className="list-disc pl-4">
                        {s.show.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ul>
                    </Td>
                    <Td className="text-xs italic text-muted">“{s.say}”</Td>
                  </tr>
                );
              })}
            </tbody>
        </TableWrap>
      </Card>
    </div>
  );
}
