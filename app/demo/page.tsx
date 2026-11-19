import Link from "next/link";
import { Suspense } from "react";
import { Badge, ButtonLink, Card, Forbidden, PageHeader, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { B09_STEPS, PATH_SECONDS, ROLE_LABEL, stepHref } from "@/lib/demo/b09-path";
import { B20_TOUR, TOUR_BRANCH, tourHref } from "@/lib/demo/b20-tour";
import { repairedTourIncident } from "@/lib/demo/tour-incident";
import { demoModeEnabled } from "@/lib/demo-mode";
import { getPool, getViewer } from "@/lib/server";
import { canSeeBranch } from "@/lib/viewer";

export const metadata = { title: "Guided demo" };

/** The repository, for the hands-on path that runs on a local copy. */
const REPOSITORY = "https://github.com/ghantapavan93/Mox-Pes";

/**
 * /demo — the guided paths.
 *
 *   - The visitor tour (lib/demo/b20-tour.ts): B20's finished repair, read-only, for anyone who may
 *     see B20. It is the hosted demo's path: it needs no role and changes no shared data.
 *   - The four-minute B09 presenter path (lib/demo/b09-path.ts), in demo mode only: it proposes,
 *     dry-runs, approves and executes a fix, switching roles three times. A deployment without demo
 *     mode switches no roles (POST /api/role answers 404), so a visitor stopped at its fourth step
 *     (sharing review, 2026-11-19); there it is described, not offered.
 *
 * Incident ids are resolved from the database: they are not stable across seeds.
 */
export default function DemoPage() {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <Demo />
    </Suspense>
  );
}

async function Demo() {
  const viewer = await getViewer();
  const demoMode = demoModeEnabled();
  const tour = canSeeBranch(viewer, TOUR_BRANCH);
  // The presenter path is about B09 and quotes its figures: a viewer who may not see B09 does not see
  // it (UX red team 2026-11-12, P0: a branch partner and a brand lead read B09's incident here while
  // /branches/B09 refused them).
  const presenter = demoMode && canSeeBranch(viewer, "B09");
  if (!tour && !presenter) {
    return <Forbidden message={`The guided demos are about branches ${TOUR_BRANCH} and B09, which are outside your scope (${viewer.label}).`} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Guided demo"
        description={
          <p className="max-w-3xl">
            {tour && presenter
              ? "Two paths. The tour walks a repair that was already made, read-only. The presenter path makes one, switching roles as it goes."
              : tour
                ? "A short tour of one repair that was already made: what was wrong, the evidence, who approved the fix, and why a fixed number is not a budget decision."
                : "The presenter path makes one repair, switching roles as it goes."}{" "}
            All data is synthetic.
          </p>
        }
      />
      {tour && (
        <Suspense fallback={<Skeleton lines={6} />}>
          <TourCard primary={!presenter} />
        </Suspense>
      )}
      {presenter ? (
        <Suspense fallback={<Skeleton lines={10} />}>
          <PresenterPath />
        </Suspense>
      ) : (
        !demoMode && <HandsOnNote />
      )}
    </div>
  );
}

/** The visitor tour: its steps, and the way in once the repair it walks has been made. */
async function TourCard({ primary }: { primary: boolean }) {
  const incident = await repairedTourIncident(getPool());
  return (
    <Card title={`Walk through a finished repair · ${TOUR_BRANCH}`} subtitle="Seven short steps, about two minutes. Read-only: nothing you do on it changes the shared data." testId="tour-card">
      {incident ? (
        <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="tour-state">
          <Badge tone="good">Ready</Badge>
          <span>The repair of incident #{incident.id} is on record.</span>
          <ButtonLink href={tourHref(B20_TOUR[0], incident.id)} variant={primary ? "primary" : "secondary"} testId="tour-start">
            Start the tour →
          </ButtonLink>
        </div>
      ) : (
        <p className="text-sm text-warn" data-testid="tour-state">
          {TOUR_BRANCH}&apos;s repair has not been made in this database yet. Make it through the Action Center on its held-calls incident (propose a replay
          through calls@1.1, dry-run it, then approve and execute it as another role), then come back.
        </p>
      )}
      <ol className="mt-4 space-y-2 text-sm" data-testid="tour-steps">
        {B20_TOUR.map((s) => (
          <li key={s.n} className="flex gap-3">
            <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-text">
              {s.n}
            </span>
            <span className="min-w-0">
              <span className="font-medium text-text">{s.title}.</span> <span className="text-muted">{s.says}</span>
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Outside demo mode: what the presenter path does, and where it runs. */
function HandsOnNote() {
  return (
    <Card title="The hands-on path" subtitle="Propose, dry-run, approve and execute a fix yourself" testId="hands-on-note">
      <p className="max-w-3xl text-sm leading-6 text-muted">
        Making a repair needs staff roles (an analyst or engineer proposes it, an engineer dry-runs it, a different role approves it) and it changes the
        stored records. On this shared site every visitor is a read-only guest, so it runs on a local copy instead:{" "}
        <a href={`${REPOSITORY}#run-the-demo-locally`} className="font-medium text-accent">
          run the demo locally
        </a>{" "}
        (the project&apos;s README).
      </p>
    </Card>
  );
}

/** The four-minute B09 path, for a presenter on a demo-mode copy. */
async function PresenterPath() {
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
        <h2 className="text-lg font-semibold tracking-tight">The four-minute path: B09</h2>
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
          <li>Every step&apos;s numbers are pinned in the project&apos;s tests and checked in a browser, step by step.</li>
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
