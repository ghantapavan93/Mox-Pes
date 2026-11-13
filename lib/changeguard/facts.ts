import { canonicalJson, sha256 } from "@/lib/primitives";

/**
 * The material facts of a confirmed drift: what a reviewer actually judges, with everything
 * incidental to one check run left out.
 *
 * A post-release check stores a lot about itself: its id, when it ran, which raw event is each
 * lead's current version, delivery times, the order of its rows. None of that is a contradiction.
 * Two checks that read the same contradictions carry the same facts, whatever else differs: a
 * duplicate delivery, a second check of the same slot, a new check id, rows in another order, a
 * later timestamp, or a source edit to a field the check does not judge (a call's agent note).
 *
 * The facts are:
 *   lead|<source>|<source lead id>|<branch>  a lead of the campaign that arrives where the release
 *                                            did not see it (the check's contradicting rows). The
 *                                            lead is named by its source id, not by the raw event
 *                                            of its current version, so a re-delivery or a revision
 *                                            that leaves it where it was is the same fact.
 *   mapping|<branch>                         the live mapping moved without a ChangeGuard release
 *   verdict|<verdict>                        the coverage verdict worsened, and to what
 *   withdrawn                                the leads the release relied on were excluded since
 *
 * Recurrence compares facts, never check ids: a reviewed case reopens only when a later check
 * carries a fact the review did not see (lib/changeguard/review.ts, lib/changeguard/monitor.ts).
 * Facts name branches, so they are stored on the check and the review, which apply the viewer's
 * scope when read; the review item (exception) carries only their hash.
 */

export interface FactSource {
  conflicting?: Array<{ source: string; sourceLeadId: string; branchId: string }>;
  /** Branches the approval never saw. Only a lead there is a contradiction by itself. */
  newBranches?: string[];
  reasons?: string[];
  liveBranchId?: string | null;
  now?: { verdict?: string } | null;
}

/** How far the coverage verdict is from "agrees": a better verdict is never new evidence. */
const VERDICT_RANK: Record<string, number> = { none: 0, agrees: 0, split: 1, disagrees: 2 };

export type DriftFact =
  | { kind: "lead"; source: string; sourceLeadId: string; branchId: string }
  | { kind: "mapping"; branchId: string }
  | { kind: "verdict"; verdict: string }
  | { kind: "withdrawn" };

/**
 * The material facts of one drift check, sorted and without duplicates.
 *
 * A lead is a fact only at a branch the approval never saw (`newBranches`). When the verdict
 * worsens the check also lists leads at approved branches delivered after the release; a
 * re-delivery or an edit bumps that time without changing anything the approval judged, so those
 * rows are not facts: the worse verdict is.
 */
export function materialFacts(evidence: FactSource): string[] {
  const reasons = evidence.reasons ?? [];
  const facts = new Set<string>();
  const outside = evidence.newBranches ? new Set(evidence.newBranches) : null;
  for (const c of evidence.conflicting ?? []) {
    if (outside && !outside.has(c.branchId)) continue;
    facts.add(`lead|${c.source}|${c.sourceLeadId}|${c.branchId}`);
  }
  if (reasons.includes("MAPPING_MOVED_OUTSIDE_CHANGEGUARD")) facts.add(`mapping|${evidence.liveBranchId ?? "unmapped"}`);
  if (reasons.includes("EVIDENCE_VERDICT_WORSENED") && evidence.now?.verdict) facts.add(`verdict|${evidence.now.verdict}`);
  if (reasons.includes("EVIDENCE_WITHDRAWN")) facts.add("withdrawn");
  return [...facts].sort();
}

/** A stable key for a set of facts: equal sets, equal keys, whatever order they came in. */
export function factsKey(facts: readonly string[]): string {
  return sha256(canonicalJson([...new Set(facts)].sort()));
}

/**
 * Facts in `current` that `seen` does not contain: what is new since a review. A verdict counts as
 * new only when it is worse than every verdict seen: "disagrees" seen, "split" now is not new.
 */
export function unseenFacts(current: readonly string[], seen: readonly string[]): string[] {
  const known = new Set(seen);
  const worstSeen = Math.max(-1, ...seen.filter((f) => f.startsWith("verdict|")).map((f) => VERDICT_RANK[f.slice(8)] ?? 0));
  return [...new Set(current)]
    .filter((f) => (f.startsWith("verdict|") ? (VERDICT_RANK[f.slice(8)] ?? 0) > worstSeen : !known.has(f)))
    .sort();
}

export function parseFact(fact: string): DriftFact | null {
  const [kind, ...rest] = fact.split("|");
  if (kind === "lead" && rest.length === 3) return { kind, source: rest[0], sourceLeadId: rest[1], branchId: rest[2] };
  if (kind === "mapping" && rest.length === 1) return { kind, branchId: rest[0] };
  if (kind === "verdict" && rest.length === 1) return { kind, verdict: rest[0] };
  if (kind === "withdrawn" && rest.length === 0) return { kind };
  return null;
}

/** The branches a set of facts names (for scope checks). */
export function factBranches(facts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const f of facts) {
    const p = parseFact(f);
    // "unmapped" is not a branch: a mapping moved to nothing names none.
    if ((p?.kind === "lead" || p?.kind === "mapping") && p.branchId !== "unmapped") out.add(p.branchId);
  }
  return [...out].sort();
}
