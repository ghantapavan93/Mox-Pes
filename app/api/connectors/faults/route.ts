import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { clearFaults, createFault, faultInputSchema, listFaults } from "@/lib/connectors/faults";
import { errorResponse } from "@/lib/http";
import { businessNow, getPool, getViewer } from "@/lib/server";
import { ForbiddenError, requirePermission } from "@/lib/viewer";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), fault: faultInputSchema }),
  z.object({ action: z.literal("clear"), faultId: z.number().int().positive() }),
  z.object({ action: z.literal("clear_all") }),
]);

/** Fault injection drives the mock for every office, so it is company-wide only. */
async function engineer() {
  const viewer = await getViewer();
  if (viewer.branchIds) throw new ForbiddenError(`${viewer.label} cannot manage mock faults (company-wide only)`);
  return viewer;
}

/** GET /api/connectors/faults — active mock faults. */
export async function GET() {
  await connection();
  try {
    await engineer();
    return NextResponse.json({ faults: await listFaults(getPool()) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/connectors/faults — create or clear faults on the MOCK FieldRoutes server
 * (permission `sync`). Faults change only what the local mock answers. Audited.
 */
export async function POST(request: Request) {
  await connection();
  try {
    const input = body.parse(await request.json());
    const viewer = await engineer();
    requirePermission(viewer, "sync", "inject mock faults");
    const pool = getPool();
    const stamps = { actor: viewer.role, now: new Date(), auditAt: await businessNow() };
    if (input.action === "create") {
      const id = await createFault(pool, { input: input.fault, ...stamps });
      return NextResponse.json({ faultId: id }, { status: 201 });
    }
    const cleared = await clearFaults(pool, { faultId: input.action === "clear" ? input.faultId : null, ...stamps });
    return NextResponse.json({ cleared });
  } catch (error) {
    return errorResponse(error);
  }
}
