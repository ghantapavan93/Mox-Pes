import { NextResponse } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { authorizeCurrencyRule, revokeCurrencyRule } from "@/lib/currency/rules";
import { errorResponse } from "@/lib/http";
import { businessNow, getPool, getViewer } from "@/lib/server";

const body = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("authorize") }),
  z.strictObject({ action: z.literal("revoke"), reason: z.string().min(10).max(500) }),
]);

/**
 * POST /api/currency-rules/:id — `authorize` (a person with approval rights other than the
 * proposer; the account's held spend is re-projected) or `revoke` (the spend it made countable is
 * excluded again).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ruleId = Number(id);
    if (!Number.isInteger(ruleId) || ruleId <= 0) throw new ActionError("Not a rule id", 400);
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    const pool = getPool();
    const now = await businessNow();
    if (input.action === "authorize") return NextResponse.json(await authorizeCurrencyRule(pool, viewer, { ruleId, now }));
    return NextResponse.json(await revokeCurrencyRule(pool, viewer, { ruleId, reason: input.reason, now }));
  } catch (error) {
    return errorResponse(error);
  }
}
