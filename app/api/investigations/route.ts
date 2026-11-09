import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { runInvestigation } from "@/lib/ai/investigate";
import { listInvestigations } from "@/lib/ai/queries";
import type { InvestigationStreamEvent } from "@/lib/ai/stream-events";
import { errorResponse } from "@/lib/http";
import { getPool, getViewer } from "@/lib/server";
import { ForbiddenError, requirePermission, resolveScope } from "@/lib/viewer";

const body = z.strictObject({
  question: z.string().trim().min(3).max(2000),
  branchId: z.string().regex(/^B\d{2}$/, "a branch id like B09").nullable().default(null),
  /** true → application/x-ndjson: one event per line as the investigation runs. */
  stream: z.boolean().default(false),
});

const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) });

/** GET /api/investigations?limit= — recent investigations visible in the viewer's scope. */
export async function GET(request: Request) {
  // Outside try: during prerendering connection() rejects by design, and that must not be logged as a route error.
  await connection();
  try {
    const input = query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const viewer = await getViewer();
    return NextResponse.json({ investigations: await listInvestigations(getPool(), viewer, input.limit) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/investigations — run an investigation as the current viewer (needs `investigate`;
 * a branch outside the viewer's scope is a 403). With `stream: true` the response is NDJSON:
 * `started` (with the id), one `step` per tool call / model turn / analyst / planner step as it
 * is recorded, then `done` or `error`. Every step is also persisted, so a client that loses the
 * stream can read the investigation by id.
 */
export async function POST(request: Request) {
  // Outside try: during prerendering connection() rejects by design, and that must not be logged as a route error.
  await connection();
  try {
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    // Checked before streaming starts, so refusals are ordinary 403/400 responses.
    requirePermission(viewer, "investigate", "run investigations");
    if (input.branchId) resolveScope(viewer, input.branchId);
    const pool = getPool();
    const args = { question: input.question, branchId: input.branchId, viewer };

    if (!input.stream) {
      const out = await runInvestigation(pool, args);
      return NextResponse.json({ id: out.id, status: out.status, mode: out.mode, latencyMs: out.latencyMs, result: out.result }, { status: 201 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let id: number | null = null;
        const send = (event: InvestigationStreamEvent) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            // The client went away; the investigation keeps running and is persisted.
          }
        };
        try {
          const out = await runInvestigation(pool, {
            ...args,
            onStart: (info) => {
              id = info.id;
              send({ type: "started", ...info });
            },
            onStep: (step) => send({ type: "step", step }),
          });
          send({ type: "done", id: out.id, mode: out.mode, latencyMs: out.latencyMs });
        } catch (error) {
          const known = error instanceof ActionError || error instanceof ForbiddenError;
          if (!known) console.error(JSON.stringify({ level: "error", msg: "investigation failed", investigationId: id, error: (error as Error).message }));
          send({ type: "error", id, message: known ? (error as Error).message : "The investigation failed; the steps so far were saved." });
        } finally {
          try {
            controller.close();
          } catch {
            // already closed by a disconnect
          }
        }
      },
    });
    return new Response(stream, {
      status: 201,
      headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
