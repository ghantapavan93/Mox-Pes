import os from "node:os";
import { performance } from "node:perf_hooks";
import { createPool, withTransaction } from "@/lib/db";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { ingestRecords } from "@/lib/ingest/ingest";
import { migrate, resetSchema } from "@/lib/migrate";
import { suggestMappings } from "@/lib/onboarding/assistant";
import { compileRows, type MappingSpec, type RowOutcome } from "@/lib/onboarding/compile";
import { isRefusal, parseUpload } from "@/lib/onboarding/parse";
import { profileTable } from "@/lib/onboarding/profile";
import { BRANCHES, CHANNELS } from "@/lib/reference";

/**
 * npm run bench:onboarding [-- --ingest]
 *
 * Measures the onboarding pipeline on synthetic call exports of 1,000 / 10,000 / 50,000 rows
 * (50,000 is the upload limit): parse, profile, assistant, compile + mapper validation, and
 * with --ingest, publication through intake into the TEST database (it is reset first).
 * Prints the machine it ran on. Numbers are for this machine only.
 */
const SIZES = [1_000, 10_000, 50_000];
const branches = BRANCHES.slice(0, 20);
const sources = ["Google Ads", "Google LSA", "Facebook", "Bing", "Direct", "Google My Business"];

function exportOf(n: number): Buffer {
  const lines = ["Call ID,Start Time,Company,Customer Phone Number,Tracking Phone Number,Source,Campaign,Note"];
  for (let i = 0; i < n; i++) {
    const b = branches[i % branches.length];
    const day = 1 + (i % 28);
    const h = 8 + (i % 10); // 8 AM to 5 PM
    const h12 = h > 12 ? h - 12 : h;
    lines.push(`BN${i},10/${String(day).padStart(2, "0")}/2026 ${h12}:${String(i % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"},${b.name},(312) 555-01${String(i % 100).padStart(2, "0")},(312) 555-0199,${sources[i % sources.length]},Campaign ${i % 7},Note ${i}`);
  }
  return Buffer.from(lines.join("\n"));
}

const spec: MappingSpec = {
  dataset: "calls",
  columns: { call_id: "Call ID", started_at: "Start Time", branch: "Company", caller_phone: "Customer Phone Number", tracking_number: "Tracking Phone Number", call_source: "Source", campaign: "Campaign", note: "Note" },
  constants: {},
  valueMaps: { branch: Object.fromEntries(branches.map((b) => [b.name, b.id])) },
  dateOrder: "MDY",
  localTime: "branch_local",
  moneyMeaning: {},
  exportedAt: null,
};

const ms = (t: number) => Math.round((performance.now() - t) * 10) / 10;
const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

async function main() {
  const ingest = process.argv.includes("--ingest");
  console.log(`Machine: ${os.cpus()[0]?.model} x${os.cpus().length}, ${mb(os.totalmem())} MB RAM, ${os.platform()} ${os.release()}, Node ${process.version}`);
  const pool = ingest ? createPool(process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54333/revenue_signal_test") : null;
  if (pool) console.log(`Postgres: ${(await pool.query<{ v: string }>("select version() as v")).rows[0].v.split(",")[0]}`);
  const now = new Date("2026-10-31T13:00:00Z");
  for (const n of SIZES) {
    global.gc?.();
    const heap0 = process.memoryUsage().heapUsed;
    const bytes = exportOf(n);
    let t = performance.now();
    const table = parseUpload({ filename: "bench.csv", bytes });
    if (isRefusal(table)) throw new Error(table.message);
    const parse = ms(t);
    t = performance.now();
    const profile = profileTable(table);
    const prof = ms(t);
    t = performance.now();
    suggestMappings(profile, { rows: table.rows });
    const assist = ms(t);
    t = performance.now();
    const out = compileRows(table, spec, now);
    const compile = ms(t);
    const eligible = out.filter((o): o is Extract<RowOutcome, { disposition: "eligible" }> => o.disposition === "eligible");
    const heap = mb(process.memoryUsage().heapUsed - heap0);
    let publish = "";
    if (pool) {
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
      t = performance.now();
      let projected = 0;
      for (let i = 0; i < eligible.length; i += 500) {
        const batch = eligible.slice(i, i + 500).map((o) => o.record);
        const s = await withTransaction(pool, (tx) => ingestRecords(tx, { source: "calls", records: batch, mapper: mapperFor("calls"), ctx: referenceContext, runId: null, now }));
        projected += s.projected;
      }
      const took = ms(t);
      publish = ` | publish ${took} ms (${Math.round(projected / (took / 1000))} rows/s, ${projected} projected)`;
    }
    console.log(
      `${String(n).padStart(6)} rows, ${mb(bytes.length)} MB | parse ${parse} ms | profile ${prof} ms | assistant ${assist} ms | compile+mapper ${compile} ms (${Math.round(n / ((compile || 1) / 1000))} rows/s) | eligible ${eligible.length} | heap +${heap} MB${publish}`,
    );
  }
  await pool?.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
