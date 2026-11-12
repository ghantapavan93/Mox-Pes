import type { Pool } from "pg";
import { withTransaction, type Queryable } from "@/lib/db";
import { traceAttribution, traceCash } from "@/lib/lineage/cash";
import { traceBranchMetric } from "@/lib/lineage/trace";
import { branchRows } from "@/lib/metrics/scorecard";
import type { Period } from "@/lib/period";
import type { Viewer } from "@/lib/viewer";
import { decisionVerdicts, type ChannelVerdicts } from "./verdicts";

/**
 * Verified decision readiness: whether a budget decision on a channel can rest on numbers that
 * are PROVED, not just computed. One deterministic policy, evaluated in order, every rule shown
 * with its result and evidence:
 *
 *   NOT_READY              a readiness blocker (the Decision Lab's own rules), failing data
 *                          integrity, or the paid-CAC trace / the cash trace not reproducing the
 *                          scorecard, or a broken money invariant.
 *   NEEDS_REVIEW           an open investigation workspace at the branch says the change may be
 *                          measurement (H3 misclassification or H4 missing data supported or open),
 *                          or integrity passes only with warnings.
 *   READY_WITH_LIMITATIONS ready, but the decision rests on attribution, not a measured effect, or
 *                          on figures that leave records out (customers whose campaign's spend is
 *                          held), or on a high unknown-channel share.
 *   READY                  ready, integrity passes, every figure reproduces, nothing left out, and
 *                          a completed randomized holdout measured the channel's effect.
 */

export type VerifiedState = "READY" | "READY_WITH_LIMITATIONS" | "NEEDS_REVIEW" | "NOT_READY";

export interface PolicyRule {
  code: string;
  /** Which state the rule can force when it fails. */
  forces: VerifiedState;
  passed: boolean;
  text: string;
  href?: string;
}

export interface VerifiedChannel {
  channelCode: string;
  label: string;
  state: VerifiedState;
  rules: PolicyRule[];
  /** The failed rules that set the state, plain. */
  because: string[];
}

export interface VerifiedReadiness {
  branchId: string;
  period: { key: string; label: string };
  channels: VerifiedChannel[];
  /** The policy, in order, as text. */
  policy: string[];
}

export const POLICY = [
  "NOT_READY if any readiness blocker fails, data integrity fails, a trace does not reproduce the scorecard, or a money invariant is broken.",
  "NEEDS_REVIEW if an open investigation workspace at the branch supports or leaves open misclassification (H3) or missing data (H4), or integrity passes only with warnings.",
  "READY_WITH_LIMITATIONS if the decision rests on attribution without a measured effect, on figures that leave held records out, or on an unknown-channel share above 20%.",
  "READY otherwise: every rule passed, including a completed randomized holdout for the channel.",
];

const UNKNOWN_SHARE_LIMIT = 0.2;
const ORDER: VerifiedState[] = ["NOT_READY", "NEEDS_REVIEW", "READY_WITH_LIMITATIONS", "READY"];

/** The policy's decision: the most severe state any failed rule forces, else READY; with the reasons for it. */
export function stateOf(rules: PolicyRule[]): { state: VerifiedState; because: string[] } {
  const failed = rules.filter((r) => !r.passed);
  const state = ORDER.find((s) => s !== "READY" && failed.some((r) => r.forces === s)) ?? "READY";
  return { state, because: failed.filter((r) => r.forces === state).map((r) => r.text) };
}

/**
 * Every rule read from ONE snapshot: a read-only repeatable-read transaction, so an ingest
 * committing mid-evaluation cannot make the traces and the scorecard disagree (review
 * 2026-11-12, authorization 13). Pages call this; `verifiedReadiness` takes a client already in one.
 */
export async function verifiedReadinessSnapshot(pool: Pool, viewer: Viewer, args: { branchId: string; period: Period }): Promise<VerifiedReadiness> {
  return withTransaction(pool, async (tx) => {
    await tx.query("set transaction isolation level repeatable read read only");
    return verifiedReadiness(tx, viewer, args);
  });
}

export async function verifiedReadiness(db: Queryable, viewer: Viewer, args: { branchId: string; period: Period }): Promise<VerifiedReadiness> {
  // Sequential reads: `db` may be one transaction client.
  const verdicts = await decisionVerdicts(db, viewer, args);
  const trace = await traceBranchMetric(db, viewer, { branchId: args.branchId, period: args.period, metric: "paid_cac" });
  const cash = args.period.key === "all" ? null : await traceCash(db, viewer, { branchId: args.branchId, period: args.period });
  const attribution = await traceAttribution(db, viewer, { branchId: args.branchId, period: args.period });
  const [row] = await branchRows(db, { from: args.period.from, to: args.period.to, branchIds: [args.branchId] });
  // The branch's most recently TESTED workspace, ties broken by version and id: the business clock
  // can be frozen, so creation time alone picked one arbitrarily (review 2026-11-12,
  // authorization 6). A workspace compares September with October, so it bears on October only.
  const workspace =
    args.period.key === "oct"
      ? await db.query<{ id: string; version: number; result: { hypotheses: Array<{ code: string; status: string }> } }>(
          `select i.id, v.version, v.result from inquiries i
           join lateral (select version, tested_at, result from inquiry_versions x where x.inquiry_id = i.id order by x.version desc limit 1) v on true
           where i.branch_id = $1 order by v.tested_at desc, v.version desc, i.id desc limit 1`,
          [args.branchId],
        )
      : { rows: [] };
  const latest = workspace.rows[0] ?? null;
  const hyp = latest?.result.hypotheses ?? [];
  const measurementDoubt = hyp.filter((h) => (h.code === "H3" || h.code === "H4") && (h.status === "SUPPORTED" || h.status === "UNRESOLVED"));
  const workspaceText =
    measurementDoubt.length > 0
      ? `Investigation workspace ${latest?.id} (version ${latest?.version}) leaves measurement open: ${measurementDoubt.map((h) => `${h.code} ${h.status.toLowerCase()}`).join(", ")}.`
      : latest
        ? `Investigation workspace ${latest.id} (version ${latest.version}) finds no sign that the change is measurement.`
        : args.period.key === "oct"
          ? "No investigation workspace is open for this branch."
          : "Investigation workspaces compare September with October; they bear on October only.";
  const brokenInvariants = (cash?.invariants ?? []).filter((i) => !i.holds).concat(attribution.invariants.filter((i) => !i.holds));
  const share = attribution.value.reproduced.unknownShare;

  const channels = verdicts.channels.map((c: ChannelVerdicts): VerifiedChannel => {
    const rules: PolicyRule[] = [
      { code: "readiness", forces: "NOT_READY", passed: c.readiness.status === "ready", text: c.readiness.status === "ready" ? "Every Decision Lab readiness rule passes." : `Readiness blockers: ${c.readiness.blockers.map((b) => b.text).join(" ")}` },
      { code: "integrity", forces: "NOT_READY", passed: c.integrity.status !== "fail", text: c.integrity.status === "fail" ? "Data integrity fails for this channel." : `Data integrity ${c.integrity.status === "warn" ? "passes with warnings" : "passes"}.` },
      { code: "cac_reproduces", forces: "NOT_READY", passed: trace.value.matches, text: trace.value.matches ? "The paid-CAC figure reproduces exactly from stored records." : `The paid-CAC trace does not reproduce: ${trace.value.discrepancies.join(" ")}`, href: `/branches/${args.branchId}/trace` },
      { code: "cash_reproduces", forces: "NOT_READY", passed: cash === null || cash.value.matches, text: cash === null ? "Cash is traced per month; not checked for both months together." : cash.value.matches ? "Collected cash reproduces to the cent from payment records." : `Collected cash does not reproduce: ${cash.value.discrepancies.join(" ")}` },
      { code: "invariants", forces: "NOT_READY", passed: brokenInvariants.length === 0, text: brokenInvariants.length === 0 ? "Every money and attribution invariant holds." : `Broken: ${brokenInvariants.map((i) => `${i.name} (${i.detail})`).join("; ")}` },
      { code: "integrity_warnings", forces: "NEEDS_REVIEW", passed: c.integrity.status !== "warn", text: c.integrity.status === "warn" ? `Integrity warnings: ${c.integrity.reasons.filter((r) => r.status === "warn").map((r) => r.text).join(" ")}` : "No integrity warnings." },
      { code: "workspace", forces: "NEEDS_REVIEW", passed: measurementDoubt.length === 0, text: workspaceText, ...(latest ? { href: `/investigator/inquiries/${latest.id}` } : {}) },
      { code: "measured_effect", forces: "READY_WITH_LIMITATIONS", passed: c.effectiveness.status === "measured", text: c.effectiveness.status === "measured" ? "A completed randomized holdout measured this channel's effect." : "No experiment measured this channel's effect: the decision rests on attribution, an association." },
      {
        code: "complete",
        forces: "READY_WITH_LIMITATIONS",
        passed: row.heldCampaignAcquired === 0 && row.partlyHeldAcquired === 0,
        text:
          row.heldCampaignAcquired === 0 && row.partlyHeldAcquired === 0
            ? "No paid customer is left out, or under-costed, by held spend."
            : [
                row.heldCampaignAcquired > 0 ? `${row.heldCampaignAcquired} paid customer(s) are left out because their campaign's spend is held at intake.` : "",
                row.partlyHeldAcquired > 0 ? `${row.partlyHeldAcquired} paid customer(s) are counted while some of their campaign's spend is held at intake, so the CAC is understated.` : "",
              ].filter(Boolean).join(" "),
      },
      { code: "attribution_coverage", forces: "READY_WITH_LIMITATIONS", passed: share === null || share <= UNKNOWN_SHARE_LIMIT, text: share === null ? "No new customers to measure coverage on." : `${(share * 100).toFixed(1)}% of new customers have no evidenced channel (limit ${UNKNOWN_SHARE_LIMIT * 100}%).` },
    ];
    const { state, because } = stateOf(rules);
    return { channelCode: c.channelCode, label: c.label, state, rules, because };
  });
  return { branchId: args.branchId, period: { key: args.period.key, label: args.period.label }, channels, policy: POLICY };
}
