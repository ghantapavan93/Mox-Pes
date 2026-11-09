import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createPool, DEFAULT_DATABASE_URL, type Queryable } from "@/lib/db";
import { replay } from "@/lib/ingest/replay";
import { planReplay } from "@/lib/ingest/replay-plan";
import { budgetSignal } from "@/lib/metrics/decision";
import { PERIODS } from "@/lib/period";
import { getException } from "@/lib/queries";
import { SCENARIO } from "@/lib/reference";
import { DEMO_NOW } from "@/lib/sim/world";

/**
 * Exports the numbers the ChangeGuard case file shows, computed by the app's own code:
 * `npm run export:changeguard -- <out.json>`. Run on a freshly seeded database.
 *
 * WARNING: performs a REAL re-map (and its repeat) so the "after" series comes from the
 * database. Reseed afterwards (`npm run db:seed`).
 */
const branch = SCENARIO.lsaMigrationBranch;

const dailySpend = async (db: Queryable) =>
  (
    await db.query(
      `select s.spend_date::text as date, s.channel_code as channel, sum(s.cost_cents)::int as cents
       from ad_spend_daily s join campaign_branch_map m on m.campaign_id = s.campaign_id
       where m.branch_id = $1 and s.channel_code in ('google_lsa', 'google_search')
         and s.spend_date >= '2026-09-01' and s.spend_date < '2026-10-31'
       group by 1, 2 order by 1, 2`,
      [branch],
    )
  ).rows;

const ledger = async (db: Queryable) =>
  (
    await db.query(
      `select (select count(*) from ad_spend_daily)::int as "spendRows", (select sum(cost_cents) from ad_spend_daily)::bigint::text as "spendCents",
              (select count(*) from crm_customers)::int as customers, (select sum(total_cents) from crm_tickets)::bigint::text as "invoicedCents",
              (select sum(amount_cents) from crm_payments where status = 'successful')::bigint::text as "collectedCents",
              (select count(*) from leads)::int as leads, (select count(*) from raw_events)::int as "rawEvents"`,
    )
  ).rows[0];

async function main() {
  const out = process.argv[2] ?? "docs/changeguard/snapshot.json";
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const oct = { from: PERIODS.oct.from, to: PERIODS.oct.to };

  const already = await pool.query("select count(*)::int as n from replays");
  if (already.rows[0].n > 0) throw new Error("Database already has replays; reseed first (npm run db:seed).");

  const row = (await pool.query("select id from exceptions where kind = 'channel_coverage_gap' and branch_id = $1", [branch])).rows[0];
  const gap = (await getException(pool, Number(row.id)))!;
  const samples = (
    await pool.query(
      `select distinct on (re.payload ->> 'campaignId') re.id, re.adapter_version, re.payload, s.channel_code as classified
       from raw_events re
       join ad_campaigns c on c.external_campaign_id = re.payload ->> 'campaignId'
       join ad_spend_daily s on s.campaign_id = c.id and s.raw_event_id = re.id
       where re.source = 'ads' and re.payload ->> 'campaignId' = any($1::text[])
         and (re.payload ->> 'date') in ('2026-10-12', '2026-10-13')
       order by re.payload ->> 'campaignId', re.id`,
      [[`lsa-${branch}`, `pmax-lsa-${branch}`]],
    )
  ).rows;

  const before = {
    signal: await budgetSignal(pool, branch, oct),
    daily: await dailySpend(pool),
    ledger: await ledger(pool),
  };

  const plan = await planReplay(pool, gap, "1.1");
  const request = {
    ...plan, mapperVersion: "1.1", actor: "export-changeguard", idempotencyKey: "changeguard-remap", dryRun: false,
    now: DEMO_NOW, exceptionId: gap.id, scope: { ...oct, branchIds: [branch] },
  };
  const real = await replay(pool, request);
  const repeat = await replay(pool, request);
  const fresh = await replay(pool, { ...request, idempotencyKey: "changeguard-remap-new-key" });

  const after = {
    signal: await budgetSignal(pool, branch, oct),
    daily: await dailySpend(pool),
    ledger: await ledger(pool),
    exceptionStatus: (await getException(pool, gap.id))!.status,
    lineage: (await pool.query("select effective_date::text as \"effectiveDate\", recorded_by as \"recordedBy\" from campaign_lineage")).rows,
  };

  const snapshot = {
    generatedBy: "scripts/export-changeguard.ts",
    demoNow: DEMO_NOW.toISOString(),
    branch,
    gap: { id: gap.id, summary: gap.summary, evidence: gap.evidence, amountCents: gap.amountCents, firstDetectedAt: gap.firstDetectedAt },
    samples,
    before,
    remap: {
      records: plan.rawEventIds.length,
      real: { claimed: real.claimed, projected: real.projected, errors: real.errors.length, before: real.before, after: real.after },
      repeat: { alreadyProcessed: repeat.alreadyProcessed, claimed: repeat.claimed },
      newKey: { claimed: fresh.claimed },
    },
    after,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(snapshot, null, 2));
  console.log(`Wrote ${out}. The database now has a real re-map; run npm run db:seed to restore the demo state.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
