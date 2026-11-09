import { NextResponse } from "next/server";
import { connection } from "next/server";
import { getPool } from "@/lib/server";

/** GET /api/health — database reachable, migrations applied, last ingestion per stream. */
export async function GET() {
  await connection();
  try {
    const pool = getPool();
    const [migrations, runs] = await Promise.all([
      pool.query("select name from schema_migrations order by name"),
      pool.query("select stream, max(finished_at) filter (where status = 'succeeded') as last_success from ingestion_runs group by stream"),
    ]);
    return NextResponse.json({ ok: true, migrations: migrations.rows.map((r) => r.name), streams: runs.rows });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", msg: "health check failed", error: (error as Error).message }));
    return NextResponse.json({ ok: false, error: "database unavailable" }, { status: 503 });
  }
}
