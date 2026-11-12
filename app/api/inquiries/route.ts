import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { listInquiries, openCacInquiry } from "@/lib/inquiry/store";
import { businessNow, getPool, getViewer } from "@/lib/server";

const body = z.strictObject({ kind: z.literal("cac_change"), branchId: z.string().regex(/^B\d{2}$/) });

/** GET /api/inquiries — the workspaces the viewer may see. */
export async function GET() {
  try {
    const viewer = await getViewer();
    return NextResponse.json({ inquiries: await listInquiries(getPool(), viewer) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/inquiries — open "Why did <branch>'s paid CAC increase?" and run its six tests. */
export async function POST(request: Request) {
  try {
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    const id = await openCacInquiry(getPool(), viewer, { branchId: input.branchId, now: await businessNow() });
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
