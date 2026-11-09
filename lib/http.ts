import { NextResponse, after } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { ForbiddenError } from "@/lib/viewer";

/** Uniform JSON errors for route handlers. Unexpected errors are logged, never leaked. */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "Invalid request", issues: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  }
  if (error instanceof ForbiddenError) return NextResponse.json({ error: error.message }, { status: 403 });
  if (error instanceof ActionError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Body is not valid JSON" }, { status: 400 });
  console.error(JSON.stringify({ level: "error", msg: "unhandled route error", error: (error as Error).message }));
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

/**
 * Runs follow-up work after the response is sent (Next's after()). A handler invoked outside a
 * Next request scope (the integration tests call route handlers directly) has no response to
 * wait for, and after() throws there: the follow-up is skipped and logged instead of failing
 * the request that already succeeded. Only use it for work a later run catches up on.
 */
export function afterResponse(label: string, task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    console.log(JSON.stringify({ level: "info", msg: "follow-up skipped outside a request scope", task: label }));
  }
}
