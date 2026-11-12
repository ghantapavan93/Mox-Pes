import { NextResponse } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { errorResponse } from "@/lib/http";
import { addInquiryNote, getInquiry, retestInquiry } from "@/lib/inquiry/store";
import { businessNow, getPool, getViewer } from "@/lib/server";

const body = z.discriminatedUnion("action", [z.strictObject({ action: z.literal("retest") }), z.strictObject({ action: z.literal("note"), text: z.string().min(3).max(2000) })]);

const idOf = async (params: Promise<{ id: string }>) => {
  const n = Number((await params).id);
  if (!Number.isInteger(n) || n <= 0) throw new ActionError("Not an investigation id", 400);
  return n;
};

/** GET /api/inquiries/:id — the workspace (404 when out of scope). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const inquiry = await getInquiry(getPool(), await getViewer(), await idOf(params));
    if (!inquiry) throw new ActionError("Investigation not found", 404);
    return NextResponse.json(inquiry);
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/inquiries/:id — `retest` (a new version) or `note`. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = await idOf(params);
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    const pool = getPool();
    const now = await businessNow();
    if (input.action === "retest") return NextResponse.json({ version: await retestInquiry(pool, viewer, { id, now }) });
    await addInquiryNote(pool, viewer, { id, text: input.text, now });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
