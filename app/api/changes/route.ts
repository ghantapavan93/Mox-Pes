import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { NewChangeSchema } from "@/lib/changeguard/model";
import { createChange, listChanges } from "@/lib/changeguard/service";
import { errorResponse, readJsonBody } from "@/lib/http";
import { getPool, getViewer } from "@/lib/server";

const body = z.intersection(NewChangeSchema, z.object({ supersedes: z.number().int().positive().nullable().optional() }));

/** GET /api/changes — configuration changes in the caller's scope, newest first. */
export async function GET() {
  await connection();
  try {
    const viewer = await getViewer();
    return NextResponse.json({ changes: await listChanges(getPool(), viewer) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/changes — propose a configuration change; it is preflighted at once (the production
 * write path in a rolled-back transaction). Requires the propose permission and both branches in
 * scope. `supersedes` marks a corrected resubmission of an earlier change.
 */
export async function POST(request: Request) {
  try {
    const input = body.parse(await readJsonBody(request, 256 * 1024));
    const viewer = await getViewer();
    const change = await createChange(getPool(), viewer, input);
    return NextResponse.json({ change }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
