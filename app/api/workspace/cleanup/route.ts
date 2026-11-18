import { NextResponse, connection } from "next/server";
import { errorResponse } from "@/lib/http";
import { getPool } from "@/lib/server";
import { deleteExpiredWorkspace } from "@/lib/workspace";

/**
 * GET /api/workspace/cleanup — deletes every visitor-workspace item past its 24 hours, whole, and
 * quota counters older than two days (release design §5.2). Vercel Cron calls it daily
 * (vercel.json), so expired rows leave the tables within a day even when the demo is quiet; every
 * onboarding and investigator request runs the same deletion first.
 *
 * Public and idempotent: it deletes only what has already expired, so it needs no secret, and a
 * second call finds nothing to do. It answers counts only.
 */
export async function GET() {
  await connection();
  try {
    return NextResponse.json({ deleted: await deleteExpiredWorkspace(getPool()) });
  } catch (error) {
    return errorResponse(error);
  }
}
