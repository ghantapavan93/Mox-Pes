import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { listIdentityConflicts } from "@/lib/identity";
import { getPool, getViewer } from "@/lib/server";
import { resolveScope } from "@/lib/viewer";

const query = z.object({
  status: z.enum(["pending", "accepted", "rejected", "superseded", "all"]).default("pending"),
  branch: z.string().regex(/^B\d{2}$/).optional(),
  customer: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/identity/conflicts?status=&branch=&customer=&page=&pageSize= — ambiguous identity
 * matches, newest first. A scoped viewer sees a conflict only when every branch it involves (the
 * lead's and the candidate customer's) is in scope.
 */
export async function GET(request: Request) {
  // Outside try: during prerendering connection() rejects by design, and that must not be logged as a route error.
  await connection();
  try {
    const params = Object.fromEntries([...new URL(request.url).searchParams].filter(([, v]) => v !== ""));
    const input = query.parse(params);
    const viewer = await getViewer();
    const scope = resolveScope(viewer, input.branch ?? null);
    const { rows, total } = await listIdentityConflicts(
      getPool(),
      { status: input.status, crmCustomerId: input.customer, limit: input.pageSize, offset: (input.page - 1) * input.pageSize },
      scope,
    );
    return NextResponse.json({ scope: scope ?? "all", page: input.page, pageSize: input.pageSize, total, rows });
  } catch (error) {
    return errorResponse(error);
  }
}
