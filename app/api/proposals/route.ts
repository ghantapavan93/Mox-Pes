import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { getPool, getViewer } from "@/lib/server";
import { PROPOSAL_KINDS } from "@/lib/workflow/kinds";
import { createProposal } from "@/lib/workflow/proposals";

const body = z.object({
  exceptionId: z.number().int().positive(),
  kind: z.enum(PROPOSAL_KINDS),
  // Shape is checked per kind by the kind's own schema (lib/workflow/kinds.ts).
  params: z.record(z.string(), z.unknown()),
  rationale: z.string().trim().min(10).max(2000),
});

/**
 * POST /api/proposals — propose a fix for one exception (human source). The kind must apply
 * to the exception; params are validated by the kind. Requires `propose` and branch scope.
 * AI-sourced proposals are created by the investigator through the same createProposal().
 */
export async function POST(request: Request) {
  await connection();
  try {
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    const proposal = await createProposal(getPool(), { ...input, source: "human", actor: viewer });
    return NextResponse.json({ proposal, message: "Proposal recorded. Next: an integration engineer dry-runs it." }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
