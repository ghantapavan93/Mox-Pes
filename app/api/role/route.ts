import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { ROLES, ROLE_COOKIE } from "@/lib/viewer";

// One list of roles, from lib/viewer.ts: a role added there is selectable here.
const body = z.object({ role: z.enum(ROLES) });

/** Demo-only role picker. Production derives the viewer from SSO; see lib/viewer.ts. */
export async function POST(request: Request) {
  try {
    const { role } = body.parse(await request.json());
    const res = NextResponse.json({ role });
    res.cookies.set(ROLE_COOKIE, role, { httpOnly: true, sameSite: "lax", path: "/" });
    return res;
  } catch (error) {
    return errorResponse(error);
  }
}
