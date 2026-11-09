import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { LIFECYCLE_FILTERS, searchCustomers } from "@/lib/identity";
import { getPool, getViewer } from "@/lib/server";
import { resolveScope } from "@/lib/viewer";

const query = z.object({
  q: z.string().trim().max(64).optional(),
  branch: z.string().regex(/^B\d{2}$/).optional(),
  lifecycle: z.enum(LIFECYCLE_FILTERS).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/customers?q=&branch=&lifecycle=&page=&pageSize= — resolved customers and prospects,
 * paged, most recent activity first. `q` matches a CRM customer id, a lead's source id (CAL…,
 * msg-…, S-…) or a prospect reference (P-<id>). Branch scope is enforced in SQL; asking for a
 * branch outside your scope is a 403, not an empty list.
 */
export async function GET(request: Request) {
  // Outside try: during prerendering connection() rejects by design, and that must not be logged as a route error.
  await connection();
  try {
    const params = Object.fromEntries([...new URL(request.url).searchParams].filter(([, v]) => v !== ""));
    const input = query.parse(params);
    const viewer = await getViewer();
    const scope = resolveScope(viewer, input.branch ?? null);
    const page = await searchCustomers(getPool(), { q: input.q, lifecycle: input.lifecycle, page: input.page, pageSize: input.pageSize }, scope);
    return NextResponse.json({ scope: scope ?? "all", ...page });
  } catch (error) {
    return errorResponse(error);
  }
}
