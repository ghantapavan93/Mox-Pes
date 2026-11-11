import { NextResponse, connection, type NextRequest } from "next/server";
import { ActionError } from "@/lib/actions";
import { errorResponse } from "@/lib/http";
import { rowResults } from "@/lib/onboarding/service";
import { parseRecordId } from "@/lib/record-id";
import { getPool, getViewer } from "@/lib/server";

const DISPOSITIONS = new Set(["eligible", "invalid", "quarantined", "duplicate_in_file", "conflict_in_file", "matches_ledger", "differs_from_ledger", "published"]);

/** GET /api/onboarding/uploads/:id/rows?disposition=&page= — row-level results of the latest dry run, 50 per page. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const id = parseRecordId((await ctx.params).id);
    if (id === null) throw new ActionError("Upload not found", 404);
    const d = request.nextUrl.searchParams.get("disposition");
    const page = parseRecordId(request.nextUrl.searchParams.get("page")) ?? 1;
    return NextResponse.json(await rowResults(getPool(), await getViewer(), { uploadId: id, disposition: d && DISPOSITIONS.has(d) ? d : undefined, page: Math.min(page, 10_000) }));
  } catch (error) {
    return errorResponse(error);
  }
}
