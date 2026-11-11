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
  if (error instanceof PayloadTooLargeError) return NextResponse.json({ error: error.message }, { status: 413 });
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

export class PayloadTooLargeError extends Error {
  readonly status = 413;
}

/**
 * Reads a request body up to `maxBytes`, refusing (413) as soon as the declared length or the
 * bytes actually received exceed it. Route handlers have no body limit of their own: without
 * this, one oversized push holds memory and, downstream, an ingest transaction (ADV-42).
 */
export async function readBodyBytes(request: Request, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError(`Body over ${formatBytes(maxBytes)}`);
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new PayloadTooLargeError(`Body over ${formatBytes(maxBytes)}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** readBodyBytes, then JSON.parse (a SyntaxError becomes a 400 in errorResponse). */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  return JSON.parse((await readBodyBytes(request, maxBytes)).toString("utf8"));
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${Math.round((n / 1024 / 1024) * 10) / 10} MB` : `${Math.round(n / 1024)} KB`;
}
