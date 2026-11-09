import { Suspense } from "react";
import { FaultPanel } from "@/components/integrations/FaultPanel";
import { JobsLive } from "@/components/integrations/JobsLive";
import { PipelineSections } from "@/components/integrations/PipelineSections";
import { RecordCompare } from "@/components/integrations/RecordCompare";
import { RunSync } from "@/components/integrations/RunSync";
import { ConnectorCard, MapperVersions, MappingInspector, OfficeGrid } from "@/components/integrations/StudioSections";
import { Card, Forbidden, Skeleton } from "@/components/ui";
import { ACTIVE_VERSION, mapperVersions } from "@/lib/adapters/registry";
import { getConnector } from "@/lib/connectors/config";
import { listFaults } from "@/lib/connectors/faults";
import { FIELDROUTES_FIELD_MAP } from "@/lib/connectors/fieldroutes-mapping";
import { connectorSummaries, listJobs, mapperUsage, officeGrid } from "@/lib/connectors/studio";
import { CRM_ENTITIES } from "@/lib/connectors/types";
import { toJobView } from "@/lib/connectors/views";
import { businessNow, getPool, getViewer } from "@/lib/server";

export default function IntegrationsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">CRM Integration Studio</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          A read-only, office-scoped CRM connector: search for changed ids, get records in bounded batches, and land them through the same
          raw event log and versioned mapper as every other source — so re-deliveries are absorbed, bad records are quarantined, and a
          failure in one office never stops the others.
        </p>
        <p className="mt-2 max-w-3xl rounded border border-accent/30 bg-accent-soft px-3 py-2 text-xs text-accent" role="note">
          Synthetic: the connector talks to this app&apos;s own FieldRoutes-compatible mock, built from public API documentation and filled
          with generated data. It is not connected to FieldRoutes or to any real tenant, and no real credentials exist in this build.
        </p>
      </div>
      <Suspense fallback={<Skeleton lines={10} />}>
        <Studio />
      </Suspense>
    </div>
  );
}

async function Studio() {
  const viewer = await getViewer();
  if (viewer.branchIds) {
    return <Forbidden message="Integration health spans every branch, so it is limited to company-wide roles." />;
  }
  const pool = getPool();
  const scope = null;
  const [now, faults, usage] = await Promise.all([businessNow(), listFaults(pool), mapperUsage(pool)]);
  const summaries = await connectorSummaries(pool, scope, now, new Date());

  return (
    <div className="space-y-6">
      {summaries.length === 0 && <p className="text-sm text-muted">No connectors are configured.</p>}
      {await Promise.all(
        summaries.map(async (summary) => {
          const connector = (await getConnector(pool, summary.connector.id))!;
          const [grid, jobs] = await Promise.all([
            officeGrid(pool, connector, scope, now),
            listJobs(pool, { connectorId: connector.id, scope, limit: 40 }),
          ]);
          const offices = grid.map((o) => ({ officeId: o.officeId, label: `${o.branchId} ${o.branchName} · ${o.officeId}` }));
          const officeLabels = Object.fromEntries(grid.map((o) => [o.officeId, `${o.branchId} · ${o.officeId}`]));
          return (
            <div key={connector.id} className="space-y-6">
              <ConnectorCard
                summary={summary}
                controls={
                  viewer.can.sync ? (
                    <RunSync connectorId={connector.id} offices={offices} entities={CRM_ENTITIES} />
                  ) : (
                    <p className="text-xs text-faint">Starting a sync requires the sync permission (integration engineer role).</p>
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
                <Card title="Fault injection" subtitle="Make the mock misbehave and watch the jobs recover — or fail with a reason">
                  <FaultPanel faults={faults} offices={offices} entities={CRM_ENTITIES} canEdit={viewer.can.sync} />
                </Card>
                <Card title="Source vs. destination" subtitle="Fetch one record through the connector and compare it with what is stored">
                  {viewer.can.sync ? (
                    <RecordCompare connectorId={connector.id} offices={offices} entities={CRM_ENTITIES} />
                  ) : (
                    <p className="text-xs text-faint">Fetching from the CRM spends the office&apos;s API read budget, so it requires the sync permission.</p>
                  )}
                </Card>
              </div>
            </div>
          );
        }),
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Mapper versions" subtitle="Which code mapped what is stored now">
          <MapperVersions deployed={ACTIVE_VERSION.crm} available={mapperVersions("crm")} usage={usage} />
        </Card>
        <Card className="xl:col-span-2" title="Field mapping inspector" subtitle="FieldRoutes field → canonical column, transform and rule. A test fails if this drifts from the mapper">
          <MappingInspector spec={FIELDROUTES_FIELD_MAP} entities={CRM_ENTITIES} />
        </Card>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold tracking-tight">Ingestion pipeline</h2>
        <p className="max-w-3xl text-sm text-muted">
          Every source lands in one raw event log, exactly once per record version. Re-deliveries are counted, not re-applied. Records that
          fail validation are quarantined, not guessed, and can be replayed through a fixed mapper.
        </p>
      </div>
      <Suspense fallback={<Skeleton lines={8} />}>
        <PipelineSections db={pool} />
      </Suspense>
    </div>
  );
}
