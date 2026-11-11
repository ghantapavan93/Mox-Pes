import type { Pool } from "pg";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { getNow, withTransaction, type Queryable } from "@/lib/db";
import { PERIODS, type PeriodKey } from "@/lib/period";
import { ForbiddenError, resolveScope, type Viewer } from "@/lib/viewer";
import { missedFollowUp, retentionBeforeService, type JourneyBrief, type JourneyId } from "./journeys";
import { checkOverride, LEVELS, type ReadinessAssessment, type ReadinessLevel } from "./readiness";

export const JOURNEYS: Record<JourneyId, typeof missedFollowUp> = {
  missed_follow_up: missedFollowUp,
  retention: retentionBeforeService,
};

export const OverrideRequestSchema = z.object({
  journey: z.enum(["missed_follow_up", "retention"]),
  period: z.enum(["oct", "sep", "all"]),
  branch: z.string().regex(/^B\d{2}$/).nullable().default(null),
  to: z.enum(LEVELS as [ReadinessLevel, ...ReadinessLevel[]]),
  reason: z.string().max(1000),
});
export type OverrideRequestInput = z.infer<typeof OverrideRequestSchema>;

export const scopeKeyOf = (branchIds: string[] | null) => (branchIds === null ? "*" : [...branchIds].sort().join(","));

export interface OverrideRow {
  id: number;
  journey: JourneyId;
  assessedLevel: ReadinessLevel;
  overrideLevel: ReadinessLevel;
  acceptedRisks: string[];
  reason: string;
  subject: string;
  role: string;
  createdAt: string;
}

/** Computes a journey for the viewer's scope (a requested branch must be in scope). */
export async function journeyFor(db: Queryable, viewer: Viewer, journey: JourneyId, period: PeriodKey, branch: string | null): Promise<JourneyBrief> {
  const branchIds = resolveScope(viewer, branch);
  return JOURNEYS[journey](db, { period: PERIODS[period], branchIds });
}

/**
 * Records an override. The assessment is recomputed here, inside the transaction, from stored
 * data: the client's idea of the current level is never trusted. Refusals come from the policy
 * (checkOverride), not from this function.
 */
export async function recordOverride(pool: Pool, viewer: Viewer, input: OverrideRequestInput): Promise<{ override: OverrideRow; brief: JourneyBrief }> {
  return withTransaction(pool, async (tx) => {
    const brief = await journeyFor(tx, viewer, input.journey, input.period, input.branch);
    const verdict = checkOverride(brief.readiness, { viewer, reason: input.reason, to: input.to });
    if (!verdict.ok) {
      if (verdict.code === "FORBIDDEN") throw new ForbiddenError(verdict.message);
      throw new ActionError(verdict.message, verdict.code === "REASON_REQUIRED" ? 400 : 409);
    }
    const now = await getNow(tx);
    const scopeKey = scopeKeyOf(brief.scope);
    const { rows } = await tx.query<{ id: string }>(
      `insert into opportunity_overrides (journey, period_key, scope_key, assessed_level, override_level, accepted_risks, reason, assessment, subject, role, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [input.journey, input.period, scopeKey, verdict.from, verdict.to, verdict.acceptedRisks, input.reason.trim(), { readiness: brief.readiness, input: brief.readinessInput }, viewer.subject, viewer.role, now],
    );
    const id = Number(rows[0].id);
    await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'override_opportunity_readiness', $3, $4)", [
      now,
      viewer.role,
      `opportunity_override:${id}`,
      { journey: input.journey, period: input.period, scope: scopeKey, from: verdict.from, to: verdict.to, acceptedRisks: verdict.acceptedRisks, by: viewer.subject },
    ]);
    return {
      brief,
      override: { id, journey: input.journey, assessedLevel: verdict.from, overrideLevel: verdict.to, acceptedRisks: verdict.acceptedRisks, reason: input.reason.trim(), subject: viewer.subject, role: viewer.role, createdAt: now.toISOString() },
    };
  });
}

/**
 * The override that applies now, if any: the newest one recorded against the level the data
 * still assesses at, provided every check failing NOW is one that override accepted. A new
 * failure (a stale feed, an open data-quality exception, or a different risk) lapses it.
 */
export function activeOverride(readiness: ReadinessAssessment, overrides: OverrideRow[]): OverrideRow | null {
  const failing = readiness.checks.filter((c) => !c.passed);
  if (failing.some((c) => !c.overridable)) return null;
  return (
    overrides.find((o) => o.assessedLevel === readiness.level && failing.every((c) => o.acceptedRisks.includes(c.key))) ?? null
  );
}

/** Overrides for one journey, period and scope, newest first. */
export async function listOverrides(db: Queryable, journey: JourneyId, period: PeriodKey, branchIds: string[] | null, limit = 5): Promise<OverrideRow[]> {
  const { rows } = await db.query<{ id: string; journey: JourneyId; assessed_level: ReadinessLevel; override_level: ReadinessLevel; accepted_risks: string[]; reason: string; subject: string; role: string; created_at: Date }>(
    `select id, journey, assessed_level, override_level, accepted_risks, reason, subject, role, created_at from opportunity_overrides
     where journey = $1 and period_key = $2 and scope_key = $3 order by created_at desc, id desc limit $4`,
    [journey, period, scopeKeyOf(branchIds), limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    journey: r.journey,
    assessedLevel: r.assessed_level,
    overrideLevel: r.override_level,
    acceptedRisks: r.accepted_risks,
    reason: r.reason,
    subject: r.subject,
    role: r.role,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}
