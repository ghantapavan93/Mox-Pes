import type { Pool } from "pg";
import { withTransaction } from "@/lib/db";
import { migrate, resetSchema } from "@/lib/migrate";
import { BRANCHES, CHANNELS } from "@/lib/reference";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { runStream } from "@/lib/ingest/ingest";
import { reconcile } from "@/lib/reconcile/reconcile";
import { dispatchEvents } from "@/lib/events/consumers";
import { resolveIdentities } from "@/lib/identity/resolve";
import { InMemorySourceClient, STREAMS } from "./clients";
import { ADS_FIX_DEPLOYED_AT, CALLS_FIX_DEPLOYED_AT, DEMO_NOW, PERIOD_END, SIM_START, TICKET_OUTAGE_RUN, generateWorld, type World } from "./world";

const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface SeedOptions {
  /** Stop the daily runs early (tests use a short history). Defaults to the full period. */
  until?: Date;
  log?: (line: string) => void;
}

export interface SeedReport {
  runs: number;
  failedRuns: number;
  rawEvents: number;
  quarantined: number;
  duplicates: number;
  millis: number;
  world: World;
}

export async function insertReference(pool: Pool, world: World, now: Date): Promise<void> {
  await pool.query(
    `insert into branches (id, name, region, timezone, crm_office_id, brand_id)
     select r."id", r."name", r."region", r."timezone", r."crmOfficeId", r."brandId"
     from jsonb_to_recordset($1::jsonb) as r("id" text, "name" text, "region" text, "timezone" text, "crmOfficeId" int, "brandId" text)`,
    [JSON.stringify(BRANCHES)],
  );
  await pool.query(
    `insert into channels (code, label, is_paid, cost_basis, measurement)
     select r."code", r."label", r."isPaid", r."costBasis", r."measurement"
     from jsonb_to_recordset($1::jsonb) as r("code" text, "label" text, "isPaid" boolean, "costBasis" text, "measurement" text)`,
    [JSON.stringify(CHANNELS)],
  );
  await pool.query(
    `insert into branch_territories (zip, branch_id)
     select r."zip", r."branchId" from jsonb_to_recordset($1::jsonb) as r("zip" text, "branchId" text)`,
    [JSON.stringify(world.territories)],
  );
  await pool.query("insert into app_clock (now) values ($1) on conflict (id) do update set now = excluded.now", [now]);
}

/** The marketing-ops team keeps campaign→branch mappings current — except for one campaign. */
async function applyCampaignMappings(pool: Pool, world: World, at: Date): Promise<void> {
  const mapped = world.campaigns.filter((c) => c.mapped);
  await pool.query(
    `insert into campaign_branch_map (campaign_id, branch_id, mapped_by, mapped_at)
     select c.id, r."branchId", 'marketing-ops', $2
     from jsonb_to_recordset($1::jsonb) as r("campaignId" text, "branchId" text)
     join ad_campaigns c on c.external_campaign_id = r."campaignId"
     on conflict (campaign_id) do nothing`,
    [JSON.stringify(mapped.map((c) => ({ campaignId: c.campaignId, branchId: c.branchId }))), at],
  );
}

/**
 * Rebuilds the demo database: schema, reference data, then the full history replayed
 * through the real ingestion pipeline one daily run at a time, reconciling as it goes.
 */
export async function seed(pool: Pool, opts: SeedOptions = {}): Promise<SeedReport> {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  await resetSchema(pool);
  await migrate(pool, log);
  const world = generateWorld();
  log(`world: ${world.records.length} source record versions, ${world.campaigns.length} campaigns`);
  await insertReference(pool, world, DEMO_NOW);

  const clients = STREAMS.map((s) => ({
    spec: s,
    client: new InMemorySourceClient(s.stream, s.source, world.records, (window) =>
      s.stream === "crm.ticket" && window.to.getTime() === TICKET_OUTAGE_RUN.getTime()
        ? "HTTP 503 Service Unavailable from CRM /ticket/search"
        : null,
    ),
  }));

  let runs = 0;
  let failedRuns = 0;
  const backfillFrom = new Date("2020-01-01T00:00:00Z");
  const until = opts.until ?? new Date(PERIOD_END.getTime() + 8 * HOUR);

  for (let runAt = new Date(SIM_START.getTime() + 8 * HOUR); runAt <= until; runAt = new Date(runAt.getTime() + DAY)) {
    for (const { spec, client } of clients) {
      const version =
        (spec.source === "calls" && runAt < CALLS_FIX_DEPLOYED_AT) || (spec.source === "ads" && runAt < ADS_FIX_DEPLOYED_AT)
          ? "1.0"
          : undefined;
      const result = await runStream(pool, {
        client,
        mapper: mapperFor(spec.source, version),
        ctx: referenceContext,
        now: runAt,
        windowEnd: runAt,
        overlapMs: spec.overlapMs,
        initialCursor: backfillFrom,
      });
      runs++;
      if (result.status === "failed") {
        failedRuns++;
        log(`${runAt.toISOString()} ${spec.stream} FAILED: ${result.error}`);
      }
      if (spec.stream === "ads") await applyCampaignMappings(pool, world, runAt);
    }
    const daily = runAt.getTime() >= Date.parse("2026-10-01T00:00:00Z") || runAt.getUTCDay() === 1;
    if (daily) await withTransaction(pool, (tx) => reconcile(tx, runAt));
  }
  await withTransaction(pool, (tx) => reconcile(tx, DEMO_NOW));
  // Identity resolution over everything ingested (Customer 360); logs its own counts.
  await resolveIdentities(pool, DEMO_NOW, { log });
  // Every event the seed published is covered by the runs above: this marks them delivered
  // without re-running anything, so a fresh demo starts with no consumer backlog.
  await dispatchEvents(pool);

  const stats = await pool.query(
    `select count(*) as raw, count(*) filter (where status = 'quarantined') as quarantined,
            coalesce(sum(delivery_count - 1), 0) as duplicates from raw_events`,
  );
  const report: SeedReport = {
    runs,
    failedRuns,
    rawEvents: Number(stats.rows[0].raw),
    quarantined: Number(stats.rows[0].quarantined),
    duplicates: Number(stats.rows[0].duplicates),
    millis: Date.now() - started,
    world,
  };
  log(`seeded: ${runs} runs (${failedRuns} failed), ${report.rawEvents} raw events, ${report.duplicates} duplicate deliveries absorbed, ${report.quarantined} quarantined, ${report.millis} ms`);
  return report;
}
