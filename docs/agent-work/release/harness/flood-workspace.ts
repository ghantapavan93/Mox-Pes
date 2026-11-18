/**
 * Floods the visitor workspace the way a script would (release design §5.2, WP-D): 35 uploads a
 * minute for 3 minutes, each a different 10,000-row file of fictional calls, each from a new
 * visitor (no cookie), so no per-visitor rule can help. Records what the server answered, how the
 * workspace tables grew, and how much WAL the flood wrote, into
 * docs/agent-work/release/flood.md.
 *
 *   DATABASE_URL=<the rehearsal database> npx tsx docs/agent-work/release/harness/flood-workspace.ts <baseUrl>
 *
 * Never against the shared production database: it refuses a URL without "rehearse" or "rc" in its
 * database name. Not part of CI.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { manyCallsCsv } from "../../../../tests/fixtures/onboarding/unseen";

const base = process.argv[2];
const url = process.env.DATABASE_URL ?? "";
if (!base) throw new Error("usage: flood-workspace.ts <baseUrl>");
const database = new URL(url).pathname.slice(1);
if (!/rehearse|_rc$/.test(database)) throw new Error(`refusing to flood database "${database}": use the rehearsal database`);

const PER_MINUTE = 35;
const MINUTES = 3;
const pool = new pg.Pool({ connectionString: url, max: 2 });

const TABLES = ["onboarding_uploads", "onboarding_rows", "onboarding_mappings", "onboarding_dry_runs", "onboarding_row_results", "workspace_quota"];

async function sizes() {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = Number((await pool.query<{ b: string }>("select pg_total_relation_size($1::regclass) as b", [t])).rows[0].b);
  return out;
}
const lsn = async () => (await pool.query<{ l: string }>("select pg_current_wal_lsn()::text as l")).rows[0].l;
const walBytes = async (from: string, to: string) => Number((await pool.query<{ d: string }>("select pg_wal_lsn_diff($2::pg_lsn, $1::pg_lsn) as d", [from, to])).rows[0].d);
const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;

async function main() {
  const before = await sizes();
  const lsnBefore = await lsn();
  const statuses = new Map<string, number>();
  const timings: number[] = [];
  let bytesSent = 0;
  const started = Date.now();
  for (let minute = 0; minute < MINUTES; minute++) {
    const minuteStart = Date.now();
    await Promise.all(
      Array.from({ length: PER_MINUTE }, async (_, i) => {
        // Spread the minute's uploads over it, as a steady script would.
        await new Promise((r) => setTimeout(r, Math.round((i * 60_000) / PER_MINUTE)));
        const body = Buffer.from(manyCallsCsv(10_000, minute * PER_MINUTE + i + 1));
        bytesSent += body.length;
        const t0 = Date.now();
        const res = await fetch(new URL("/api/onboarding/uploads", base), { method: "POST", headers: { "x-filename": "flood.csv", "content-type": "application/octet-stream" }, body });
        timings.push(Date.now() - t0);
        const json = (await res.json().catch(() => ({}))) as { refused?: { code: string } };
        const key = `${res.status}${json.refused ? ` ${json.refused.code}` : ""}`;
        statuses.set(key, (statuses.get(key) ?? 0) + 1);
      }),
    );
    const rest = 60_000 - (Date.now() - minuteStart);
    if (rest > 0 && minute < MINUTES - 1) await new Promise((r) => setTimeout(r, rest));
  }
  const after = await sizes();
  const wal = await walBytes(lsnBefore, await lsn());
  const held = (await pool.query<{ n: number; rows: number }>("select count(*)::int as n, coalesce(sum(row_count), 0)::int as rows from onboarding_uploads where workspace_owner is not null")).rows[0];
  timings.sort((x, y) => x - y);
  const p = (q: number) => timings[Math.min(timings.length - 1, Math.floor(q * timings.length))];

  const lines = [
    "# Workspace flood (WP-D)",
    "",
    `Run ${new Date().toISOString()} against ${new URL(base).host}, database \`${database}\`: ${PER_MINUTE} uploads a minute for ${MINUTES} minutes, each a different 10,000-row file (${mb(bytesSent / (PER_MINUTE * MINUTES))} each), each from a new visitor. ${((Date.now() - started) / 1000).toFixed(0)} s in all.`,
    "",
    "| Answer | Uploads |",
    "|---|---|",
    ...[...statuses.entries()].sort().map(([k, v]) => `| ${k} | ${v} |`),
    "",
    `Response time: median ${p(0.5)} ms, p95 ${p(0.95)} ms, slowest ${timings[timings.length - 1]} ms.`,
    "",
    `Workspace uploads held afterwards: ${held.n}, ${held.rows.toLocaleString("en-US")} rows (budget ${(100_000 / 2).toLocaleString("en-US")} rows, counted twice).`,
    "",
    "| Table | Before | After |",
    "|---|---|---|",
    ...TABLES.map((t) => `| ${t} | ${mb(before[t])} | ${mb(after[t])} |`),
    "",
    `WAL written during the flood: ${mb(wal)}.`,
    "",
  ];
  const out = path.join(process.cwd(), "docs", "agent-work", "release", "flood.md");
  writeFileSync(out, lines.join("\n"));
  console.log(lines.join("\n"));
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
