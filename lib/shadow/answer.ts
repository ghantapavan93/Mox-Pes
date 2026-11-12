import { z } from "zod";
import { isModelCausalClaim } from "@/lib/ai/analyst";
import { metricFacts } from "@/lib/ai/facts";
import { judge, proveStatement, type Proof } from "@/lib/ai/proof";
import { getBranchMetrics, getBrandMetrics, getCashTrace, getMetricTrace, type ToolContext } from "@/lib/ai/tools";
import type { Queryable } from "@/lib/db";
import { BRANCHES, BRANDS, branchesOfBrands, type BrandId } from "@/lib/reference";
import { canSeeBranch, type Viewer } from "@/lib/viewer";

/**
 * AI Answer Assurance (docs/agent-work/SHADOW-MODE.md §3): another system's conversational
 * answer, checked claim by claim against the product's evidence.
 *
 * The answer is untrusted text: it is read, never followed. Each piece the proof engine reads
 * (lib/ai/proof.ts, the same closed reading the investigator's model text gets) becomes a claim
 * with one verdict. Facts come only from the read-only tools, run as the viewer, for the
 * branches and brands the answer names and the viewer may see; a piece naming anything else is
 * OUT_OF_SCOPE and nothing about it is read. A cause is never certified by a figure.
 */

export const AnswerSchema = z.strictObject({
  system: z.string().min(1).max(80),
  asOf: z.string().datetime({ offset: true }),
  question: z.string().max(1000).default(""),
  answer: z.string().min(1).max(8000),
});
export type AnswerInput = z.infer<typeof AnswerSchema>;

export type ClaimVerdict = "SUPPORTED" | "CONTRADICTED" | "UNSUPPORTED" | "OUT_OF_SCOPE";
export type OverallVerdict = "SUPPORTED" | "PARTLY_SUPPORTED" | "NOT_SUPPORTED";

export interface AnswerClaim {
  text: string;
  verdict: ClaimVerdict;
  reason: string;
  propositions: Array<{ figure: string; formula: string; claimed: number | null; computed: number | null; verdict: Proof["verdict"]; gap: Proof["gap"]; reason: string; evidenceIds: string[] }>;
}

export interface AnswerCheck {
  overall: OverallVerdict;
  claims: AnswerClaim[];
  /** What the answer names: the scopes read, and those refused (named, never read). */
  entities: { branches: string[]; brands: string[]; outOfScope: string[] };
  facts: number;
  limitations: string[];
}

/** At most this many branches are read for one answer: a bounded check, not a crawl. */
const MAX_BRANCHES = 4;

const BRANCH_ID = /\bB\d{2}\b/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BRANCH_NAME = BRANCHES.map((b) => ({ id: b.id, re: new RegExp(`\\b${escape(b.name)}\\b`) }));
/** A brand by its full name, or by its distinctive first word with a possessive ("Joshua's"). */
const BRAND_NAME = BRANDS.map((b) => ({ id: b.id, re: new RegExp(`\\b${escape(b.name)}\\b|\\b${escape(b.name.split(" ")[0])}(?:'s)? (?:Pest|brand|branches)\\b`, "i") }));

/** Words that make a piece a claim: a figure, a metric, an entity, a direction, a status or a cause. */
const CLAIM_WORD = /[$%\d]|\b(?:CAC|spend|spent|cost|revenue|cash|collect\w*|customers?|leads?|calls?|refund\w*|invoic\w*|billed|booked|budget|campaigns?|channels?|Meta|Google|Microsoft|Bing|LSA|Local Services|rose|rise|fell|fall|increase\w*|decrease\w*|grew|grow\w*|drop\w*|declin\w*|doubled|halved|higher|lower|up|down|because|due to|caus\w*|driv\w*|led to|ready|complete|stale|fresh)\b/i;

function mentions(text: string): { branches: string[]; brands: BrandId[] } {
  const branches = new Set<string>(text.match(BRANCH_ID) ?? []);
  for (const b of BRANCH_NAME) if (b.re.test(text)) branches.add(b.id);
  const brands = BRAND_NAME.filter((b) => b.re.test(text)).map((b) => b.id as BrandId);
  return { branches: [...branches].filter((id) => BRANCHES.some((b) => b.id === id)), brands };
}

const canSeeBrand = (viewer: Viewer, brand: BrandId) => branchesOfBrands([brand]).every((id) => canSeeBranch(viewer, id));

/** The pieces of the answer in reading order, each with its proofs (pieces with none included). */
function piecesOf(answer: string, proofs: Proof[]): Array<{ text: string; proofs: Proof[] }> {
  const byPiece = new Map<string, Proof[]>();
  for (const p of proofs) byPiece.set(p.piece, [...(byPiece.get(p.piece) ?? []), p]);
  const out = [...byPiece.entries()].map(([text, ps]) => ({ text, proofs: ps, at: answer.indexOf(text.trim()) }));
  // Sentences the engine produced no proof for still count when they name something (a cause,
  // an out-of-scope branch): nothing an answer says escapes a verdict by being unreadable.
  for (const sentence of answer.split(/(?<=[.!?])\s+/)) {
    const s = sentence.trim();
    if (!s || out.some((p) => p.text.includes(s) || s.includes(p.text.trim()))) continue;
    out.push({ text: s, proofs: [], at: answer.indexOf(s) });
  }
  return out.sort((a, b) => a.at - b.at).map(({ text, proofs: ps }) => ({ text: text.trim(), proofs: ps }));
}

export async function assureAnswer(db: Queryable, viewer: Viewer, input: AnswerInput, now: Date): Promise<AnswerCheck> {
  const named = mentions(input.answer);
  const seen = named.branches.filter((id) => canSeeBranch(viewer, id));
  const refusedBranches = named.branches.filter((id) => !canSeeBranch(viewer, id));
  const seenBrands = named.brands.filter((b) => canSeeBrand(viewer, b));
  const refusedBrands = named.brands.filter((b) => !canSeeBrand(viewer, b));
  const read = seen.slice(0, MAX_BRANCHES);
  const limitations: string[] = [];
  if (seen.length > MAX_BRANCHES) limitations.push(`The answer names ${seen.length} branches; only ${MAX_BRANCHES} were read (${read.join(", ")}), so claims about the others are unsupported here.`);

  // Facts, from the read-only tools only, one call after another on the caller's connection.
  const ctx: ToolContext = { db, viewer, now };
  const steps: Array<{ kind: string; status: string; tool: string; output: unknown; evidenceIds: string[] }> = [];
  const call = async (tool: string, run: () => Promise<{ data: unknown; evidenceIds: string[] }>) => {
    try {
      const out = await run();
      steps.push({ kind: "tool_call", status: "ok", tool, output: out.data, evidenceIds: out.evidenceIds });
    } catch (error) {
      limitations.push(`${tool} could not be read: ${(error as Error).message}`);
    }
  };
  for (const branchId of read) {
    for (const period of ["sep", "oct"] as const) {
      await call("getBranchMetrics", () => getBranchMetrics.run(ctx, getBranchMetrics.input.parse({ branchId, period })));
      await call("getMetricTrace", () => getMetricTrace.run(ctx, getMetricTrace.input.parse({ branchId, period, metric: "paid_cac" })));
      await call("getCashTrace", () => getCashTrace.run(ctx, getCashTrace.input.parse({ branchId, period })));
    }
  }
  for (const brandId of seenBrands) {
    for (const period of ["sep", "oct"] as const) await call("getBrandMetrics", () => getBrandMetrics.run(ctx, getBrandMetrics.input.parse({ brandId, period })));
  }
  const facts = metricFacts(steps);

  const proofs = proveStatement(input.answer, { branchId: read[0] ?? null, facts, origin: "model" });
  const claims: AnswerClaim[] = [];
  for (const piece of piecesOf(input.answer, proofs)) {
    const named = mentions(piece.text);
    const outside = named.branches.some((id) => refusedBranches.includes(id)) || named.brands.some((b) => refusedBrands.includes(b));
    if (outside) {
      claims.push({ text: piece.text, verdict: "OUT_OF_SCOPE", reason: "It names a branch or brand outside your scope; it was not checked and nothing about it was read.", propositions: [] });
      continue;
    }
    const isClaim = piece.proofs.some((p) => p.gap !== "unproved") || CLAIM_WORD.test(piece.text);
    if (!isClaim) continue;
    const propositions = piece.proofs.map((p) => ({ figure: p.figure, formula: p.formula, claimed: p.claimed, computed: p.computed, verdict: p.verdict, gap: p.gap, reason: p.reason, evidenceIds: [...new Set(p.inputs.flatMap((i) => i.evidenceIds))] }));
    const contradicted = piece.proofs.find((p) => p.verdict === "CONTRADICTED");
    if (contradicted) {
      claims.push({ text: piece.text, verdict: "CONTRADICTED", reason: `${contradicted.figure ? `${contradicted.figure}: ` : ""}${contradicted.reason}`, propositions });
      continue;
    }
    const judgement = piece.proofs.length > 0 ? judge(piece.proofs, "model") : null;
    if (isModelCausalClaim(piece.text)) {
      claims.push({ text: piece.text, verdict: "UNSUPPORTED", reason: "It states a cause. The evidence can show what changed, not why; a cause needs a test (an experiment or an investigation workspace).", propositions });
      continue;
    }
    if (judgement?.status === "SUPPORTED") {
      claims.push({ text: piece.text, verdict: "SUPPORTED", reason: judgement.reason, propositions });
      continue;
    }
    claims.push({ text: piece.text, verdict: "UNSUPPORTED", reason: judgement?.reason ?? "Nothing in it is a proposition the evidence can prove.", propositions });
  }

  const supported = claims.filter((c) => c.verdict === "SUPPORTED").length;
  const overall: OverallVerdict = claims.length > 0 && supported === claims.length ? "SUPPORTED" : supported === 0 ? "NOT_SUPPORTED" : "PARTLY_SUPPORTED";
  if (refusedBranches.length > 0 || refusedBrands.length > 0) limitations.push("Claims about scopes you cannot see were not checked.");
  return {
    overall,
    claims,
    entities: { branches: read, brands: seenBrands, outOfScope: [...refusedBranches, ...refusedBrands] },
    facts: facts.length,
    limitations,
  };
}
