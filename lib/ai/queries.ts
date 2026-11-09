import { ActionError } from "@/lib/actions";
import type { Queryable } from "@/lib/db";
import { ForbiddenError, canSeeBranch, type Viewer } from "@/lib/viewer";
import type { InvestigationResult } from "./contract";
import { parseEvidenceId } from "./evidence";
import type { InvestigationStep } from "./steps";
import { TOOLS, type ToolContext } from "./tools";

/**
 * Read models for the investigator pages and API. Scope rules:
 *
 *   * an investigation is visible to a viewer whose branch scope covers the scope it ran with
 *     (a branch partner sees investigations that ran within their branch; company-wide
 *     viewers see all) — so a result can never show a partner another branch's records;
 *   * evidence is resolved only for ids that a step of THAT investigation returned, and is
 *     re-read through the same scoped tool, so the drawer can never show more than the tools
 *     would to this viewer now.
 */

export interface InvestigationSummary {
  id: number;
  question: string;
  branchId: string | null;
  actor: string;
  mode: "deterministic" | "model";
  intent: string | null;
  status: "running" | "completed" | "failed";
  confidence: string | null;
  observations: number;
  proposals: number;
  claimsDropped: number;
  latencyMs: number | null;
  costMicros: number;
  createdAt: string;
}

export interface InvestigationDetail extends Omit<InvestigationSummary, "confidence" | "observations" | "proposals" | "claimsDropped"> {
  scopeBranchIds: string[] | null;
  model: string | null;
  result: InvestigationResult | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  finishedAt: string | null;
  steps: InvestigationStep[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** investigations, as node-postgres returns it (bigint columns arrive as strings). */
interface InvestigationRow {
  id: string;
  question: string;
  branch_id: string | null;
  scope_branch_ids: string[] | null;
  actor: string;
  mode: "deterministic" | "model";
  model: string | null;
  intent: string | null;
  status: "running" | "completed" | "failed";
  result: InvestigationResult | null;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_micros: string;
  latency_ms: number | null;
  created_at: Date;
  finished_at: Date | null;
}

/** Does the viewer's scope cover the scope the investigation ran with? */
export function canSeeInvestigation(viewer: Viewer, row: { scope_branch_ids: string[] | null; branch_id: string | null }): boolean {
  if (!viewer.branchIds) return true;
  if (row.branch_id && !viewer.branchIds.includes(row.branch_id)) return false;
  return row.scope_branch_ids !== null && row.scope_branch_ids.every((b) => viewer.branchIds!.includes(b));
}

export async function listInvestigations(db: Queryable, viewer: Viewer, limit = 25): Promise<InvestigationSummary[]> {
  const { rows } = await db.query(
    `select id, question, branch_id, scope_branch_ids, actor, mode, intent, status, latency_ms, cost_micros, created_at,
            result -> 'confidence' ->> 'level' as confidence,
            coalesce(jsonb_array_length(result -> 'observations'), 0) as observations,
            coalesce(jsonb_array_length(result -> 'proposals'), 0) as proposals,
            coalesce((grounding ->> 'claimsDropped')::int, 0) as claims_dropped
     from investigations
     where $1::text[] is null
        or (scope_branch_ids is not null and scope_branch_ids <@ $1::text[] and (branch_id is null or branch_id = any($1::text[])))
     order by created_at desc, id desc limit $2`,
    [viewer.branchIds, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    question: r.question,
    branchId: r.branch_id ?? null,
    actor: r.actor,
    mode: r.mode,
    intent: r.intent ?? null,
    status: r.status,
    confidence: r.confidence ?? null,
    observations: Number(r.observations),
    proposals: Number(r.proposals),
    claimsDropped: Number(r.claims_dropped),
    latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
    costMicros: Number(r.cost_micros),
    createdAt: r.created_at.toISOString(),
  }));
}

const toStep = (r: Record<string, unknown>): InvestigationStep => ({
  seq: Number(r.seq),
  stage: r.stage as InvestigationStep["stage"],
  kind: r.kind as InvestigationStep["kind"],
  tool: (r.tool as string | null) ?? null,
  input: r.input as Record<string, unknown>,
  outputSummary: r.output_summary as string,
  output: r.output ?? null,
  evidenceIds: r.evidence_ids as string[],
  status: r.status as InvestigationStep["status"],
  error: (r.error as string | null) ?? null,
  ms: Number(r.ms),
  at: (r.at as Date).toISOString(),
});

/** Null when missing or outside the viewer's scope (indistinguishable, as elsewhere). */
export async function getInvestigation(db: Queryable, viewer: Viewer, id: number, opts: { afterSeq?: number } = {}): Promise<InvestigationDetail | null> {
  const { rows } = await db.query<InvestigationRow>("select * from investigations where id = $1", [id]);
  const r = rows[0];
  if (!r || !canSeeInvestigation(viewer, r)) return null;
  const steps = await db.query("select * from investigation_steps where investigation_id = $1 and seq > $2 order by seq", [id, opts.afterSeq ?? 0]);
  return {
    id: Number(r.id),
    question: r.question,
    branchId: r.branch_id ?? null,
    scopeBranchIds: r.scope_branch_ids ?? null,
    actor: r.actor,
    mode: r.mode,
    model: r.model ?? null,
    intent: r.intent ?? null,
    status: r.status,
    result: r.result ?? null,
    error: r.error ?? null,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    costMicros: Number(r.cost_micros),
    latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
    createdAt: r.created_at.toISOString(),
    finishedAt: iso(r.finished_at),
    steps: steps.rows.map(toStep),
  };
}

// ── proposals as they stand now ─────────────────────────────────────────────

export interface ProposalState {
  proposalId: number;
  exceptionId: number;
  caseId: number;
  kind: string;
  source: string;
  proposedRole: string;
  status: string;
  caseState: string;
  dryRun: { ok: boolean; at: string | null; by: string | null; error: string | null } | null;
  approvals: Array<{ decision: string; role: string; reason: string; at: string }>;
  execution: { status: string; actor: string; at: string; verified: boolean | null; problems: string[]; error: string | null } | null;
}

/**
 * The live Action Center state of the proposals an investigation created or linked: status,
 * dry run, approvals by role, and — after execution — the verification result.
 */
export async function proposalStates(db: Queryable, viewer: Viewer, proposalIds: number[]): Promise<ProposalState[]> {
  if (proposalIds.length === 0) return [];
  const { rows } = await db.query(
    `select p.*, c.state as case_state, e.branch_id
     from action_proposals p join cases c on c.id = p.case_id join exceptions e on e.id = p.exception_id
     where p.id = any($1::bigint[]) order by p.id`,
    [proposalIds],
  );
  const visible = rows.filter((r) => canSeeBranch(viewer, r.branch_id ?? null));
  const ids = visible.map((r) => Number(r.id));
  const approvals = await db.query("select * from action_approvals where proposal_id = any($1::bigint[]) order by id", [ids]);
  const executions = await db.query("select * from action_executions where proposal_id = any($1::bigint[])", [ids]);
  return visible.map((r) => {
    const dry = r.dry_run as { ok: boolean; at: string; by: string; error: string | null } | null;
    const x = executions.rows.find((e) => Number(e.proposal_id) === Number(r.id));
    const verification = (x?.verification ?? null) as { ok?: boolean; problems?: string[] } | null;
    return {
      proposalId: Number(r.id),
      exceptionId: Number(r.exception_id),
      caseId: Number(r.case_id),
      kind: r.kind,
      source: r.source,
      proposedRole: r.proposed_role,
      status: r.status,
      caseState: r.case_state,
      dryRun: dry ? { ok: Boolean(dry.ok), at: dry.at ?? null, by: dry.by ?? null, error: dry.error ?? null } : null,
      approvals: approvals.rows
        .filter((a) => Number(a.proposal_id) === Number(r.id))
        .map((a) => ({ decision: a.decision, role: a.role, reason: a.reason, at: a.decided_at.toISOString() })),
      execution: x
        ? {
            status: x.status,
            actor: x.actor,
            at: x.finished_at.toISOString(),
            verified: verification ? Boolean(verification.ok) : null,
            problems: verification?.problems ?? [],
            error: x.error ?? null,
          }
        : null,
    };
  });
}

// ── evidence drawer ──────────────────────────────────────────────────────────

export interface EvidenceView {
  evidenceId: string;
  kind: string;
  title: string;
  /** Where the record lives in the product, if it has a page. */
  href: string | null;
  /** The record, re-read now through the scoped tool; or the stored tool output for derived figures. */
  record: unknown;
  source: "live" | "stored_step";
  /** The step(s) of this investigation that returned the id. */
  returnedBy: Array<{ seq: number; tool: string | null; summary: string }>;
}

/**
 * Resolves one cited evidence id for the drawer. Only ids a step of this investigation
 * returned are served (anything else is 404), and records are re-read through the same tool
 * with the viewer's scope.
 */
export async function resolveEvidence(ctx: ToolContext, investigationId: number, evidenceId: string): Promise<EvidenceView> {
  const inv = await getInvestigation(ctx.db, ctx.viewer, investigationId);
  if (!inv) throw new ActionError("Investigation not found", 404);
  const parsed = parseEvidenceId(evidenceId);
  if (!parsed) throw new ActionError("Not an evidence id", 400);
  const returning = inv.steps.filter((s) => s.evidenceIds.includes(evidenceId));
  if (returning.length === 0) throw new ActionError("This investigation did not return that evidence", 404);
  const returnedBy = returning.map((s) => ({ seq: s.seq, tool: s.tool, summary: s.outputSummary }));
  const n = Number(parsed.key);
  const live = async (tool: keyof typeof TOOLS, input: unknown, title: string, href: string | null): Promise<EvidenceView> => {
    const def = TOOLS[tool];
    const out = await (def.run as (c: ToolContext, i: unknown) => Promise<{ data: unknown }>)(ctx, def.input.parse(input));
    return { evidenceId, kind: parsed.kind, title, href, record: out.data, source: "live", returnedBy };
  };
  try {
    switch (parsed.kind) {
      case "exception":
        return await live("getReconciliationExceptions", { exceptionId: n }, `Exception ${n}`, `/exceptions/${n}`);
      case "raw_event":
        return await live("getSourceLineage", { rawEventId: n }, `Raw event ${n}`, null);
      case "campaign":
        return await live("getSourceLineage", { campaignId: n }, `Campaign ${n}`, null);
      case "lead":
        return await live("getSourceLineage", { leadId: n }, `Lead ${n}`, null);
      case "customer":
        return await live("getCustomerJourney", { customerId: n }, `Customer ${n}`, `/customers/${n}`);
      case "metric_definition":
        return await live("getMetricDefinition", { key: parsed.key }, `Metric definition: ${parsed.key}`, "/definitions");
      case "audit": {
        const { rows } = await ctx.db.query("select * from audit_log where id = $1", [n]);
        if (!rows[0]) throw new ActionError(`Audit row ${n} not found`, 404);
        return { evidenceId, kind: parsed.kind, title: `Audit row ${n}`, href: null, record: rows[0], source: "live", returnedBy };
      }
      default: {
        // Derived figures (metrics, readiness), payments, runs, cases: show what the tool returned.
        const step = returning[0];
        return {
          evidenceId,
          kind: parsed.kind,
          title: evidenceTitle(parsed.kind, parsed.parts),
          href: evidenceHref(parsed.kind, parsed.parts),
          record: step.output,
          source: "stored_step",
          returnedBy,
        };
      }
    }
  } catch (error) {
    // A record that left the viewer's scope (or was deleted) since the run is not served.
    if (error instanceof ForbiddenError) throw new ActionError(`${evidenceId} is not in your scope`, 404);
    throw error;
  }
}

function evidenceTitle(kind: string, parts: string[]): string {
  switch (kind) {
    case "branch_metrics":
      return `Branch metrics ${parts[0]} (${parts[1]})`;
    case "channel_metrics":
      return `Channel metrics ${parts[0]} ${parts[2]} (${parts[1]})`;
    case "readiness":
      return `Decision readiness ${parts[0]} ${parts[2]} (${parts[1]})`;
    default:
      return `${kind.replace(/_/g, " ")} ${parts.join(":")}`;
  }
}

function evidenceHref(kind: string, parts: string[]): string | null {
  switch (kind) {
    case "branch_metrics":
    case "channel_metrics":
      return `/branches/${parts[0]}?period=${parts[1]}`;
    case "readiness":
      return `/decisions?branch=${parts[0]}&period=${parts[1]}`;
    case "ingestion_run":
      return "/audit";
    default:
      return null;
  }
}

// ── suggested questions ──────────────────────────────────────────────────────

export interface SuggestedQuestion {
  question: string;
  branchId: string | null;
  /** Why it is suggested (what in the data it comes from). */
  basis: string;
}

const shortChannel = (label: string) => label.replace(/^Google /, "");

/**
 * Questions built from the data in the viewer's scope — never a fixed list: the open coverage
 * gap (the golden path), the branch whose paid CAC a quarantine distorts, and a real paid
 * customer to trace. A scope with none of these gets fewer suggestions.
 */
export async function suggestedQuestions(db: Queryable, viewer: Viewer): Promise<SuggestedQuestion[]> {
  const scope = viewer.branchIds;
  const out: SuggestedQuestion[] = [];
  const gap = await db.query<{ id: string; branch_id: string; evidence: Record<string, unknown> }>(
    `select id, branch_id, evidence from exceptions
     where kind = 'channel_coverage_gap' and status = 'open' and ($1::text[] is null or branch_id = any($1::text[]))
     order by amount_cents desc, id limit 1`,
    [scope],
  );
  const g = gap.rows[0];
  if (g) {
    const succ = ((g.evidence.successors as Array<{ classifiedAs?: string[] }> | null) ?? [])[0];
    const into = await db.query<{ label: string }>("select label from channels where code = any($1::text[]) order by code limit 1", [succ?.classifiedAs ?? []]);
    const label = String(g.evidence.channelLabel ?? g.evidence.channel);
    out.push({
      question: into.rows[0]
        ? `Why does ${label} at ${g.branch_id} look so much cheaper than ${shortChannel(into.rows[0].label)} in October?`
        : `Why did ${label} spend at ${g.branch_id} stop while its leads kept arriving?`,
      branchId: g.branch_id,
      basis: `Open channel coverage gap (exception ${g.id})`,
    });
  }
  const quarantine = await db.query<{ id: string; branch_id: string }>(
    `select id, branch_id from exceptions
     where kind = 'quarantined_source_records' and status = 'open' and branch_id is not null and ($1::text[] is null or branch_id = any($1::text[]))
     order by amount_cents desc, id limit 1`,
    [scope],
  );
  const q = quarantine.rows[0];
  if (q) out.push({ question: `Why is ${q.branch_id}'s paid CAC so high?`, branchId: q.branch_id, basis: `Open quarantine (exception ${q.id}) at ${q.branch_id}` });
  const customer = await db.query<{ crm_customer_id: string; branch_id: string }>(
    `select a.crm_customer_id, a.branch_id from v_acquisitions a join channels ch on ch.code = a.channel_code and ch.is_paid
     where a.attribution_basis = 'lead_evidence' and a.initial_status = 'completed'
       and a.branch_id = coalesce($2::text, a.branch_id) and ($1::text[] is null or a.branch_id = any($1::text[]))
     order by a.crm_customer_id limit 1`,
    [scope, g?.branch_id ?? q?.branch_id ?? null],
  );
  const c = customer.rows[0];
  if (c) out.push({ question: `Where did customer ${c.crm_customer_id} come from?`, branchId: null, basis: `A paid, serviced customer at ${c.branch_id}` });
  return out;
}
