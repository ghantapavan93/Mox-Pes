import { createReadStream, createWriteStream, statSync } from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import readline from "node:readline";
import { once } from "node:events";
import type { Pool } from "pg";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { createPool, withTransaction } from "@/lib/db";
import { ingestRecords } from "@/lib/ingest/ingest";
import { migrate, resetSchema } from "@/lib/migrate";
import { compileRows, type MappingSpec, type RowOutcome } from "@/lib/onboarding/compile";
import type { ParsedTable } from "@/lib/onboarding/parse";
import { reconcile } from "@/lib/reconcile/reconcile";
import { BRANCHES, CHANNELS } from "@/lib/reference";

/**
 * Bulk backfill benchmark (Stage 7). NOT a product feature: an operator-side measurement of how
 * the intake behaves at 1,000,000 rows on a durable database, using the same compiler and
 * mapper validation as the onboarding dry run and the same ingestRecords as live intake.
 *
 *   npx tsx scripts/bench-backfill.ts --db=postgres://postgres@127.0.0.1:54334/bench --rows=1000000
 *     [--batch=2000] [--crash-after=N]  (exit hard after N committed batches, to test restart)
 *     [--no-reset] (resume into the existing database)
 *
 * Memory is bounded: the file is generated and read as a stream, one batch at a time. Every
 * 50th row repeats an earlier call with identical content (re-delivery), so the expected
 * number of leads is known exactly.
 */
const arg = (name: string, fallback?: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
function requiredDb(): string {
  const db = arg("db");
  if (db) return db;
  // The run resets the schema of the database it is given, so it never falls back to a default.
  console.error("--db=<connection string of an ISOLATED database> is required (its schema is reset)");
  process.exit(2);
}
const DB = requiredDb();
const ROWS = Number(arg("rows", "1000000"));
const BATCH = Number(arg("batch", "2000"));
const CRASH_AFTER = arg("crash-after") ? Number(arg("crash-after")) : null;
const RESET = !process.argv.includes("--no-reset");
const FILE = `C:/Temp/backfill-${ROWS}.csv`;
const NOW = new Date("2026-10-31T13:00:00Z");
const branches = BRANCHES.slice(0, 40);
const SOURCES = ["Google Ads", "Google LSA", "Facebook", "Bing", "Direct", "Google My Business"];
const HEADER = "Call ID,Start Time,Branch,Customer Phone Number,Tracking Phone Number,Source,Campaign";

/** The call for logical index i (a re-delivery repeats call i - 25 exactly). */
function line(i: number): string {
  const n = i % 50 === 49 ? i - 25 : i;
  const b = branches[n % branches.length];
  const day = 1 + (n % 28);
  const minute = n % 600;
  const phone = `+1${String(2_000_000_000 + ((n * 7919) % 7_000_000_000)).padStart(10, "0")}`;
  return `BF${n},2026-10-${String(day).padStart(2, "0")}T${String(8 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00-05:00,${b.id},${phone},+12125550199,${SOURCES[n % SOURCES.length]},Campaign ${n % 9}`;
}

async function generate(): Promise<void> {
  try {
    if (statSync(FILE).size > 0) return;
  } catch {
    /* create it */
  }
  const out = createWriteStream(FILE);
  out.write(`${HEADER}\n`);
  for (let i = 0; i < ROWS; i++) {
    if (!out.write(`${line(i)}\n`)) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");
}

const spec: MappingSpec = {
  dataset: "calls",
  columns: { call_id: "Call ID", started_at: "Start Time", branch: "Branch", caller_phone: "Customer Phone Number", tracking_number: "Tracking Phone Number", call_source: "Source", campaign: "Campaign" },
  constants: {}, valueMaps: {}, dateOrder: null, localTime: null, moneyMeaning: {}, exportedAt: null,
};

async function prepareDb(pool: Pool) {
  await resetSchema(pool);
  await migrate(pool);
  await pool.query(
    `insert into branches (id, name, region, timezone, crm_office_id, brand_id) select r."id", r."name", r."region", r."timezone", r."crmOfficeId", r."brandId" from jsonb_to_recordset($1::jsonb) as r("id" text, "name" text, "region" text, "timezone" text, "crmOfficeId" int, "brandId" text)`,
    [JSON.stringify(BRANCHES)],
  );
  await pool.query(
    `insert into channels (code, label, is_paid, cost_basis, measurement) select r."code", r."label", r."isPaid", r."costBasis", r."measurement" from jsonb_to_recordset($1::jsonb) as r("code" text, "label" text, "isPaid" boolean, "costBasis" text, "measurement" text)`,
    [JSON.stringify(CHANNELS)],
  );
  await pool.query("insert into app_clock (now) values ($1)", [NOW]);
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const mb = (b: number) => Math.round(b / 1024 / 1024);

async function main() {
  const pool = createPool(DB);
  const tGen = performance.now();
  await generate();
  const genMs = performance.now() - tGen;
  if (RESET) await prepareDb(pool);
  const lsn0 = (await pool.query<{ l: string }>("select pg_current_wal_lsn()::text as l")).rows[0].l;
  const size0 = Number((await pool.query<{ s: string }>("select pg_database_size(current_database()) as s")).rows[0].s);

  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  let peakRss = process.memoryUsage().rss;
  const batchMs: number[] = [];
  let read = 0;
  let committed = 0;
  const totals = { inserted: 0, duplicates: 0, projected: 0, quarantined: 0, duplicateInFile: 0, otherNotEligible: 0 };
  let chunk: string[][] = [];
  let lineNo = 1;
  const rl = readline.createInterface({ input: createReadStream(FILE), crlfDelay: Infinity });
  let header: string[] | null = null;

  const flush = async () => {
    if (chunk.length === 0) return;
    const tb = performance.now();
    const table: ParsedTable = {
      format: "csv", filename: "backfill.csv", columns: header!, sourceHeaders: header!, rows: chunk,
      rowRefs: chunk.map((_, i) => lineNo - chunk.length + i + 1), raggedRows: [], sheet: null, encoding: "utf-8", delimiter: ",", warnings: [],
    };
    const outcomes = compileRows(table, spec, NOW);
    const eligible = outcomes.filter((o): o is Extract<RowOutcome, { disposition: "eligible" }> => o.disposition === "eligible");
    for (const o of outcomes) {
      if (o.disposition === "duplicate_in_file") totals.duplicateInFile++;
      else if (o.disposition !== "eligible") totals.otherNotEligible++;
    }
    const stats = await withTransaction(pool, (tx) =>
      ingestRecords(tx, { source: "calls", records: eligible.map((o) => o.record), mapper: mapperFor("calls"), ctx: referenceContext, runId: null, now: NOW }),
    );
    totals.inserted += stats.inserted;
    totals.duplicates += stats.duplicates;
    totals.projected += stats.projected;
    totals.quarantined += stats.quarantined;
    batchMs.push(performance.now() - tb);
    committed++;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    chunk = [];
    if (committed % 50 === 0) console.log(`  ${read.toLocaleString("en-US")} rows, ${committed} batches, ${Math.round(read / ((performance.now() - t0) / 1000))} rows/s, rss ${mb(peakRss)} MB`);
    if (CRASH_AFTER !== null && committed >= CRASH_AFTER) {
      console.log(`CRASH: exiting hard after ${committed} committed batches (${read} rows read)`);
      process.exit(137);
    }
  };

  for await (const text of rl) {
    lineNo++;
    if (!header) {
      header = text.split(",");
      continue;
    }
    // In-file duplicates (the same call twice in one compile batch) are absorbed by the compiler;
    // across batches by the intake's raw ledger. Both are counted.
    chunk.push(text.split(","));
    read++;
    if (chunk.length >= BATCH) await flush();
  }
  await flush();
  const loadMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);

  const lsn1 = (await pool.query<{ l: string }>("select pg_current_wal_lsn()::text as l")).rows[0].l;
  const wal = Number((await pool.query<{ d: string }>("select pg_wal_lsn_diff($1, $2) as d", [lsn1, lsn0])).rows[0].d);
  const size1 = Number((await pool.query<{ s: string }>("select pg_database_size(current_database()) as s")).rows[0].s);
  const leads = Number((await pool.query<{ n: string }>("select count(*) as n from leads")).rows[0].n);
  const distinctIds = Number((await pool.query<{ n: string }>("select count(distinct source_lead_id) as n from leads")).rows[0].n);
  const raw = Number((await pool.query<{ n: string; d: string }>("select count(*) as n from raw_events")).rows[0].n);
  const expectedUnique = ROWS - Math.floor(ROWS / 50);

  const tRec = performance.now();
  const rec = await withTransaction(pool, (tx) => reconcile(tx, NOW));
  const reconcileMs = performance.now() - tRec;

  const q = async (sql: string, params: unknown[] = []) => {
    const t = performance.now();
    await pool.query(sql, params);
    return Math.round((performance.now() - t) * 10) / 10;
  };
  const queries = {
    leadsByBranchChannelMs: await q("select branch_id, channel_code, count(*) from leads group by 1, 2"),
    leadLookupByIdMs: await q("select * from leads where source = 'calls' and source_lead_id = $1", [`BF${Math.floor(ROWS / 2)}`]),
    rawByExternalIdMs: await q("select id from raw_events where source = 'calls' and external_id like $1 limit 1", ["call:BF123:%"]),
  };

  const sorted = [...batchMs].sort((a, b) => a - b);
  const report = {
    machine: `${os.cpus()[0]?.model.trim()} x${os.cpus().length}, ${mb(os.totalmem())} MB RAM, ${os.platform()} ${os.release()}, Node ${process.version}`,
    postgres: (await pool.query<{ v: string }>("select version() as v")).rows[0].v.split(",")[0],
    durability: Object.fromEntries((await pool.query<{ name: string; setting: string }>("select name, setting from pg_settings where name in ('fsync','synchronous_commit','full_page_writes','wal_level','shared_buffers')")).rows.map((r) => [r.name, r.setting])),
    file: { path: FILE, mb: mb(statSync(FILE).size), rows: ROWS, generateMs: Math.round(genMs) },
    batch: BATCH,
    batches: committed,
    rowsRead: read,
    loadSeconds: Math.round(loadMs / 100) / 10,
    rowsPerSecond: Math.round(read / (loadMs / 1000)),
    batchLatencyMs: { p50: Math.round(pct(sorted, 0.5)), p95: Math.round(pct(sorted, 0.95)), p99: Math.round(pct(sorted, 0.99)), max: Math.round(sorted[sorted.length - 1] ?? 0) },
    peakRssMb: mb(peakRss),
    cpuSeconds: { user: Math.round(cpu.user / 1e5) / 10, system: Math.round(cpu.system / 1e5) / 10 },
    walMb: mb(wal),
    databaseGrowthMb: mb(size1 - size0),
    totals,
    correctness: { leads, distinctIds, expectedUniqueCalls: expectedUnique, rawEvents: raw, leadsEqualUnique: leads === expectedUnique && distinctIds === leads },
    reconcileSeconds: Math.round(reconcileMs / 100) / 10,
    reconcileExceptions: rec,
    queries,
  };
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
