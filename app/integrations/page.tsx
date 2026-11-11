import { Suspense } from "react";
import { FaultPanel } from "@/components/integrations/FaultPanel";
import { JobsLive } from "@/components/integrations/JobsLive";
import { PipelineSections } from "@/components/integrations/PipelineSections";
import { RecordCompare } from "@/components/integrations/RecordCompare";
import { RunSync } from "@/components/integrations/RunSync";
import { ConnectorCard, MapperVersions, MappingInspector, OfficeGrid } from "@/components/integrations/StudioSections";
import { Callout, Card, EmptyState, Forbidden, KpiTile, PageHeader, Segmented, Skeleton } from "@/components/ui";
import { ACTIVE_VERSION, mapperVersions } from "@/lib/adapters/registry";
import { getConnector } from "@/lib/connectors/config";
import { listFaults } from "@/lib/connectors/faults";
import { FIELDROUTES_FIELD_MAP } from "@/lib/connectors/fieldroutes-mapping";
import { connectorSummaries, listJobs, mapperUsage, officeGrid } from "@/lib/connectors/studio";
import { CRM_ENTITIES } from "@/lib/connectors/types";
import { toJobView } from "@/lib/connectors/views";
import { count } from "@/lib/format";
import { failedRunsWithRecovery, streamTotals } from "@/lib/queries";
import { businessNow, getPool, getViewer } from "@/lib/server";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The three jobs this page does, each its own view in the URL (`?view=`). */
const VIEWS = {
  connector: "CRM connector",
  mapping: "Field mapping",
  pipeline: "Ingestion pipeline",
} as const;
type View = keyof typeof VIEWS;

function parseView(value: string | string[] | undefined): View {
  const v = Array.isArray(value) ? value[0] : value;
  return v && Object.hasOwn(VIEWS, v) ? (v as View) : "connector";
}

export default function IntegrationsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Systems · company-wide"
        title="Integrations"
        description={
          <p className="max-w-3xl">
            Every source lands in one raw event log, exactly once per record version, through a versioned mapper. The CRM connector is read-only and
            office-scoped: it searches for changed ids, gets records in bounded batches, absorbs re-deliveries, quarantines bad records, and a failure in one
            office never stops the others.
          </p>
        }
      />
      <div role="note">
        <Callout tone="info" title="Synthetic connector">
          The connector talks to this app&apos;s own FieldRoutes-compatible mock, built from public API documentation and filled with generated data. It is
          not connected to FieldRoutes or to any real tenant, and no real credentials exist in this build.
        </Callout>
      </div>
      <Suspense fallback={<Skeleton lines={10} />}>
        <Studio searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Studio({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await getViewer();
  if (viewer.branchIds) {
    return <Forbidden message="Integration health spans every branch, so it is limited to company-wide roles." />;
  }
  const view = parseView((await searchParams).view);
  const pool = getPool();
  const scope = null;
  const now = await businessNow();
  const [summaries, totals, failures] = await Promise.all([connectorSummaries(pool, scope, now, new Date()), streamTotals(pool), failedRunsWithRecovery(pool)]);
  const deliveries = totals.reduce((a, t) => a + Number(t.deliveries), 0);
  const versions = totals.reduce((a, t) => a + Number(t.events), 0);
  const quarantined = totals.reduce((a, t) => a + Number(t.quarantined), 0);
  const unrecovered = failures.filter((f) => !f.recovered_by).length;
  const crm = summaries[0]?.health;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="integration-kpis">
        <KpiTile
          label="CRM connector"
          value={crm ? crm.status : "none"}
          sub={crm ? crm.reason : "No connector configured"}
          tone={!crm ? "neutral" : crm.status === "healthy" ? "good" : crm.status === "failing" ? "bad" : crm.status === "degraded" ? "warn" : "neutral"}
          href="/integrations"
          current={view === "connector"}
        />
        <KpiTile
          label="Record versions stored"
          value={count(versions)}
          sub={`${count(deliveries - versions)} duplicate deliveries absorbed, from ${count(totals.length)} sources`}
          href="/integrations?view=pipeline"
          current={view === "pipeline"}
        />
        <KpiTile label="Quarantined records" value={count(quarantined)} sub="Failed validation; held, not guessed" tone={quarantined > 0 ? "bad" : "good"} href="/integrations?view=pipeline#quarantine" />
        <KpiTile
          label="Failed runs not yet recovered"
          value={count(unrecovered)}
          sub={`${count(failures.length)} failed run${failures.length === 1 ? "" : "s"} in total; a failed run never advances its cursor`}
          tone={unrecovered > 0 ? "bad" : "good"}
          href="/integrations?view=pipeline#failed-runs"
        />
      </div>

      <Segmented label="Integration views" testId="integration-views" items={(Object.keys(VIEWS) as View[]).map((v) => ({ href: v === "connector" ? "/integrations" : `/integrations?view=${v}`, label: VIEWS[v], current: v === view }))} />

      {view === "connector" && <ConnectorView canSync={viewer.can.sync} summaries={summaries} now={now} />}
      {view === "mapping" && <MappingView />}
      {view === "pipeline" && (
        <Suspense fallback={<Skeleton lines={8} />}>
          <PipelineSections db={pool} />
        </Suspense>
      )}
    </div>
  );
}

/** Operate the connector: health, run a sync, watch jobs, per-office checkpoints, faults, compare. */
async function ConnectorView({ canSync, summaries, now }: { canSync: boolean; summaries: Awaited<ReturnType<typeof connectorSummaries>>; now: Date }) {
  const pool = getPool();
  const scope = null;
  if (summaries.length === 0) return <EmptyState title="No connectors are configured." />;
  const faults = await listFaults(pool);
  return (
    <div className="space-y-6">
      {await Promise.all(
        summaries.map(async (summary) => {
          const connector = (await getConnector(pool, summary.connector.id))!;
          const [grid, jobs] = await Promise.all([officeGrid(pool, connector, scope, now), listJobs(pool, { connectorId: connector.id, scope, limit: 40 })]);
          const offices = grid.map((o) => ({ officeId: o.officeId, label: `${o.branchId} ${o.branchName} · ${o.officeId}` }));
          const officeLabels = Object.fromEntries(grid.map((o) => [o.officeId, `${o.branchId} · ${o.officeId}`]));
          return (
            <div key={connector.id} className="space-y-6">
              <ConnectorCard
                summary={summary}
                controls={
                  canSync ? (
                    <RunSync connectorId={connector.id} offices={offices} entities={CRM_ENTITIES} />
                  ) : (
                    <p className="text-xs text-muted">Starting a sync requires the sync permission (integration engineer role).</p>
                  )
                }
              />
              <Card title="Sync jobs" subtitle="One job per office × entity; retries keep the same window and resume after the last committed batch">
                <JobsLive connectorId={connector.id} initialJobs={jobs.map(toJobView)} officeLabels={officeLabels} />
              </Card>
              <Card title="Offices" subtitle="Latest job and checkpoint per office and entity. Checkpoints move only when a window's last batch commits">
                <OfficeGrid rows={grid} entities={CRM_ENTITIES} />
              </Card>
              <div className="grid gap-6 xl:grid-cols-2">
                <Card title="Fault injection" subtitle="Make the mock misbehave and watch the jobs recover, or fail with a reason">
                  <FaultPanel faults={faults} offices={offices} entities={CRM_ENTITIES} canEdit={canSync} />
                </Card>
                <Card title="Source vs. destination" subtitle="Fetch one record through the connector and compare it with what is stored">
                  {canSync ? (
                    <RecordCompare connectorId={connector.id} offices={offices} entities={CRM_ENTITIES} />
                  ) : (
                    <p className="text-xs text-muted">Fetching from the CRM spends the office&apos;s API read budget, so it requires the sync permission.</p>
                  )}
                </Card>
              </div>
            </div>
          );
        }),
      )}
    </div>
  );
}

/** Which code mapped what is stored, and how each FieldRoutes field lands. */
async function MappingView() {
  const usage = await mapperUsage(getPool());
  return (
    <div className="space-y-6">
      <Card title="Mapper versions" subtitle="Which code mapped what is stored now">
        <MapperVersions deployed={ACTIVE_VERSION.crm} available={mapperVersions("crm")} usage={usage} />
      </Card>
      <Card title="Field mapping inspector" subtitle="FieldRoutes field → canonical column, transform and rule. A test fails if this drifts from the mapper">
        <MappingInspector spec={FIELDROUTES_FIELD_MAP} entities={CRM_ENTITIES} />
      </Card>
    </div>
  );
}
