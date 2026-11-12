import { NextResponse } from "next/server";
import { z } from "zod";
import { accountsAwaitingCurrency, listCurrencyRules, proposeCurrencyRule } from "@/lib/currency/rules";
import { errorResponse } from "@/lib/http";
import { businessNow, getPool, getViewer } from "@/lib/server";
import { ForbiddenError } from "@/lib/viewer";

const body = z.strictObject({
  platform: z.string().min(1).max(20),
  adAccountId: z.string().min(1).max(80),
  reason: z.string().min(10).max(500),
});

/** GET /api/currency-rules — live rules and the ad accounts whose spend is held for lacking a stated currency. Engineers and approvers. */
export async function GET() {
  try {
    const viewer = await getViewer();
    if (!viewer.can.sync && !viewer.can.approve) throw new ForbiddenError(`${viewer.label} cannot view currency rules`);
    const pool = getPool();
    return NextResponse.json({ rules: await listCurrencyRules(pool), awaiting: await accountsAwaitingCurrency(pool) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/currency-rules — an integration engineer proposes "this account reports in USD". It counts only after another person authorizes it. */
export async function POST(request: Request) {
  try {
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    const pool = getPool();
    const result = await proposeCurrencyRule(pool, viewer, { ...input, now: await businessNow() });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
