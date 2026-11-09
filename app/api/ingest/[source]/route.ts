import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { withTransaction } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { ingestRecords } from "@/lib/ingest/ingest";
import { businessNow, getPool } from "@/lib/server";

const PUSH_SOURCES = ["web", "calls", "d2d"] as const;
const body = z.object({
  records: z.array(z.object({ entity: z.string().min(1).max(40), payload: z.record(z.string(), z.unknown()) })).min(1).max(500),
});

function authorised(request: Request): boolean {
  const expected = process.env.INGEST_API_KEY ?? (process.env.NODE_ENV === "production" ? null : "dev-ingest-key");
  if (!expected) return false; // fail closed: a production deploy without a key accepts nothing
  const given = request.headers.get("x-ingest-key") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * POST /api/ingest/:source — push ingestion for sources that deliver events (website
 * lead events, call-tracking webhooks, the D2D app). Same pipeline as polling: redact,
 * validate, write once per (source, external_id), project or quarantine.
 * Re-posting the same batch is safe: it is counted as duplicate delivery.
 */
export async function POST(request: Request, ctx: { params: Promise<{ source: string }> }) {
  try {
    if (!authorised(request)) return NextResponse.json({ error: "Missing or invalid x-ingest-key" }, { status: 401 });
    const { source } = await ctx.params;
    if (!PUSH_SOURCES.includes(source as (typeof PUSH_SOURCES)[number])) {
      return NextResponse.json({ error: `Push ingestion is not enabled for "${source}"` }, { status: 404 });
    }
    const { records } = body.parse(await request.json());
    const now = await businessNow();
    // Reconciliation is not run inline: it scans all history and would make every push
    // wait on the reconcile lock. It runs on its schedule (POST /api/reconcile).
    const stats = await withTransaction(getPool(), (tx) =>
      ingestRecords(tx, { source: source as (typeof PUSH_SOURCES)[number], records, mapper: mapperFor(source as "web"), ctx: referenceContext, runId: null, now }),
    );
    // 200 even when some records were quarantined: they were accepted and are held for replay.
    return NextResponse.json(stats);
  } catch (error) {
    return errorResponse(error);
  }
}
