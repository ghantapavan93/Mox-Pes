import type { PoolClient } from "pg";
import { ActionError, mapCampaignToBranchInTransaction } from "@/lib/actions";
import { isExclusion, type RawRecord, type SourceName } from "@/lib/adapters/contract";
import { ACTIVE_VERSION, compareVersions, mapperFor, mapperVersions, referenceContext } from "@/lib/adapters/registry";
import type { Queryable } from "@/lib/db";
import { branchRows, paidCac } from "@/lib/metrics/scorecard";
import { canonicalJson, sha256 } from "@/lib/primitives";
import { PERIODS } from "@/lib/period";
import { lockReconcile, reconcile } from "@/lib/reconcile/reconcile";
import { BRANCH_BY_ID } from "@/lib/reference";
import type { Viewer } from "@/lib/viewer";
import {
  CHECK_IDS,
  dependenciesOf,
  verdictOf,
  type BranchImpact,
  type CampaignMappingPayload,
  type CheckId,
  type PreflightCheck,
  type PreflightResult,
  type SourceContractPayload,
} from "./model";

/**
 * The preflight engine. Deterministic, and it never mutates authoritative state:
 *
 *   campaign_mapping  runs the PRODUCTION write path (the same function the Action Center uses,
 *                     then reconciliation) inside the caller's transaction, measures the
 *                     reporting before and after, and the caller rolls the transaction back.
 *   source_contract   runs sample payloads through the DEPLOYED mapper (pure functions) and
 *                     compares their shape with the latest stored payload. Reads only.
 *
 * Every one of the fourteen checks is answered; one that does not apply says why.
 */

export interface CampaignBase {
  campaignId: number;
  externalCampaignId: string;
  name: string;
  platform: string;
  channelCode: string;
  /** The branch the campaign maps to now (null = unmapped). */
  currentBranchId: string | null;
  /** Where this campaign's leads actually arrive, by branch. */
  leadEvidence: Array<{ branchId: string; leads: number }>;
  /** Campaigns this one replaced or was replaced by, and where those map. */
  lineage: Array<{ campaignId: number; relation: "predecessor" | "successor"; branchId: string | null }>;
  spendCents: number;
  spendDays: { first: string | null; last: string | null; days: number };
  /** Media spend inside the reporting window: exactly what a mapping moves between branches' paid spend. */
  mediaSpendInWindowCents: number;
}

export async function readCampaignBase(db: Queryable, campaignId: number): Promise<CampaignBase | null> {
  const c = await db.query<{ id: string; external_campaign_id: string; name: string; platform: string; channel_code: string; branch_id: string | null }>(
    `select c.id, c.external_campaign_id, c.name, c.platform, c.channel_code, m.branch_id
     from ad_campaigns c left join campaign_branch_map m on m.campaign_id = c.id where c.id = $1`,
    [campaignId],
  );
  if (c.rowCount === 0) return null;
  const row = c.rows[0];
  // Sequential: `db` may be a single transaction client, which must not run queries concurrently.
  const evidence = await db.query<{ branch_id: string; n: string }>(
      "select effective_branch_id as branch_id, count(*) as n from v_leads where campaign_external_id = $1 group by effective_branch_id order by count(*) desc, effective_branch_id",
      [row.external_campaign_id],
    );
  const lineage = await db.query<{ campaign_id: string; relation: "predecessor" | "successor"; branch_id: string | null }>(
      `select l.predecessor_campaign_id as campaign_id, 'predecessor' as relation, m.branch_id
         from campaign_lineage l left join campaign_branch_map m on m.campaign_id = l.predecessor_campaign_id
        where l.successor_campaign_id = $1
       union all
       select l.successor_campaign_id, 'successor', m.branch_id
         from campaign_lineage l left join campaign_branch_map m on m.campaign_id = l.successor_campaign_id
        where l.predecessor_campaign_id = $1`,
      [campaignId],
    );
  const spend = await db.query<{ cents: string | null; first: string | null; last: string | null; days: string; media_in_window: string | null }>(
      `select sum(s.cost_cents) as cents, min(s.spend_date)::text as first, max(s.spend_date)::text as last, count(distinct s.spend_date) as days,
              sum(s.cost_cents) filter (where ch.cost_basis = 'media' and s.spend_date >= ($2::timestamptz at time zone 'UTC')::date and s.spend_date < ($3::timestamptz at time zone 'UTC')::date) as media_in_window
       from ad_spend_daily s join channels ch on ch.code = s.channel_code where s.campaign_id = $1`,
      [campaignId, PERIODS.all.from, PERIODS.all.to],
    );
  return {
    campaignId: Number(row.id),
    externalCampaignId: row.external_campaign_id,
    name: row.name,
    platform: row.platform,
    channelCode: row.channel_code,
    currentBranchId: row.branch_id,
    leadEvidence: evidence.rows.map((r) => ({ branchId: r.branch_id, leads: Number(r.n) })),
    lineage: lineage.rows.map((r) => ({ campaignId: Number(r.campaign_id), relation: r.relation, branchId: r.branch_id })),
    spendCents: Number(spend.rows[0].cents ?? 0),
    spendDays: { first: spend.rows[0].first, last: spend.rows[0].last, days: Number(spend.rows[0].days) },
    mediaSpendInWindowCents: Number(spend.rows[0].media_in_window ?? 0),
  };
}

/**
 * What an approval depends on, besides the configuration itself: the mapping it replaces and
 * where the evidence points. If either moves between preflight and release, the approval is
 * stale. Lead counts are deliberately not hashed (they grow every day); the branches they point
 * to are.
 */
export type EvidenceVerdict = "none" | "agrees" | "split" | "disagrees";

/**
 * How the campaign's leads relate to a proposed branch: the rule the coverage check applies.
 * "disagrees" means the evidence points elsewhere: the proposed branch has under half of the
 * leads AND another branch has more. Fragmented evidence where the proposed branch has the most
 * (or ties for the most) without a majority is "split": a person decides (held-out HO-50; it
 * used to be blocked as a contradiction of itself).
 */
export function evidenceVerdict(base: CampaignBase, branchId: string): EvidenceVerdict {
  const total = base.leadEvidence.reduce((t, e) => t + e.leads, 0);
  if (total === 0) return "none";
  const at = base.leadEvidence.find((e) => e.branchId === branchId)?.leads ?? 0;
  const most = Math.max(...base.leadEvidence.map((e) => e.leads));
  if (at / total < 0.5 && at < most) return "disagrees";
  return at < total ? "split" : "agrees";
}

export function baseHashOf(base: CampaignBase, branchId: string): string {
  return sha256(
    canonicalJson({
      currentBranchId: base.currentBranchId,
      // The coverage verdict itself: evidence that drifts across the 50% line changes the hash.
      verdict: evidenceVerdict(base, branchId),
      evidenceBranches: base.leadEvidence.map((e) => e.branchId).sort(),
      majority: base.leadEvidence[0]?.branchId ?? null,
      lineage: base.lineage,
    }),
  );
}

interface Snapshot {
  rows: Map<string, { paidSpendCents: number; paidAcquired: number; paidCacCents: number | null; canonical: string }>;
  open: Map<string, { kind: string; summary: string }>;
  totalSpendCents: number;
}

async function snapshot(tx: Queryable): Promise<Snapshot> {
  const period = PERIODS.all;
  // Sequential: one transaction client.
  const rows = await branchRows(tx, { from: period.from, to: period.to, branchIds: null });
  const open = await tx.query<{ fingerprint: string; kind: string; summary: string }>("select fingerprint, kind, summary from exceptions where status = 'open'");
  const total = await tx.query<{ cents: string | null }>("select sum(cost_cents) as cents from ad_spend_daily");
  return {
    rows: new Map(rows.map((r) => [r.branchId, { paidSpendCents: r.paidSpendCents, paidAcquired: r.paidAcquired, paidCacCents: paidCac(r.paidSpendCents, r.paidAcquired), canonical: canonicalJson(r) }])),
    open: new Map(open.rows.map((r) => [r.fingerprint, { kind: r.kind, summary: r.summary }])),
    totalSpendCents: Number(total.rows[0].cents ?? 0),
  };
}

/** The production write: the Action Center's mapping core for a new mapping, the same rule for a remap. */
export async function applyCampaignMapping(
  tx: PoolClient,
  args: { campaignId: number; branchId: string; actor: string; reason: string; now: Date; expectedPrevious?: string | null },
): Promise<void> {
  // Serialise with every other mapping write first, then re-read: a mapping made since the
  // caller looked must never be silently overwritten.
  await lockReconcile(tx);
  const current = await tx.query<{ branch_id: string }>("select branch_id from campaign_branch_map where campaign_id = $1 for update", [args.campaignId]);
  const now = current.rows[0]?.branch_id ?? null;
  if (args.expectedPrevious !== undefined && now !== args.expectedPrevious) {
    throw new ActionError(`The campaign maps to ${now ?? "no branch"} now, not ${args.expectedPrevious ?? "no branch"} as reviewed`, 409);
  }
  if (current.rowCount === 0) {
    await mapCampaignToBranchInTransaction(tx, args);
    return;
  }
  await tx.query("update campaign_branch_map set branch_id = $2, mapped_by = $3, mapped_at = $4 where campaign_id = $1", [args.campaignId, args.branchId, args.actor, args.now]);
  await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'remap_campaign', $3, $4)", [
    args.now,
    args.actor,
    `campaign:${args.campaignId}`,
    { from: current.rows[0].branch_id, to: args.branchId, reason: args.reason },
  ]);
  await reconcile(tx, args.now);
}

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const na = (id: CheckId, detail: string): PreflightCheck => ({ id, status: "not_applicable", detail });

function inScope(viewer: Viewer, branchId: string | null): boolean {
  return branchId === null || viewer.branchIds === null || viewer.branchIds.includes(branchId);
}

/** Orders checks as CHECK_IDS so every preflight reads the same way. */
function ordered(checks: PreflightCheck[]): PreflightCheck[] {
  const missing = CHECK_IDS.filter((id) => !checks.some((c) => c.id === id));
  if (missing.length > 0) throw new Error(`preflight left checks unanswered: ${missing.join(", ")}`);
  return CHECK_IDS.map((id) => checks.find((c) => c.id === id)!);
}

/**
 * Preflight of a campaign → branch mapping. Runs inside `tx`; the CALLER must roll it back
 * (lib/changeguard/service.ts uses withRollback). Returns the result and the base hash.
 */
export async function preflightCampaignMapping(
  tx: PoolClient,
  args: { payload: CampaignMappingPayload; viewer: Viewer; now: Date; changeId: number | null },
): Promise<{ result: PreflightResult; baseHash: string; base: CampaignBase | null }> {
  const { payload, viewer, now } = args;
  const base = await readCampaignBase(tx, payload.campaignId);
  const target = BRANCH_BY_ID.get(payload.branchId);
  const checks: PreflightCheck[] = [];
  const limitations = [
    "A mapping applies to the campaign's whole history (mappings are not effective-dated); the preview shows that retroactive effect.",
    "Lead evidence is the campaign id carried on call and web leads. Campaigns whose leads carry no campaign id cannot be checked this way.",
  ];

  if (!base || !target) {
    checks.push({
      id: "identifier_presence",
      status: "fail",
      code: !base ? "UNKNOWN_CAMPAIGN" : "UNKNOWN_BRANCH",
      detail: !base ? `Campaign ${payload.campaignId} does not exist` : `Branch ${payload.branchId} does not exist`,
    });
    for (const id of CHECK_IDS) if (id !== "identifier_presence") checks.push(na(id, "Not evaluated: the change names something that does not exist."));
    const result: PreflightResult = { kind: "campaign_mapping", verdict: "fail", checks: ordered(checks), impact: [], exceptionsOpened: [], exceptionsCleared: [], unrelatedBranchesChanged: [], dependentMetrics: dependenciesOf("campaign_branch_map"), limitations };
    return { result, baseHash: sha256("missing"), base };
  }

  const previous = base.currentBranchId;
  checks.push({ id: "identifier_presence", status: "pass", detail: `Campaign ${base.externalCampaignId} (${base.platform}) and branch ${target.id} ${target.name} exist.` });
  checks.push(na("schema_compatibility", "A mapping changes no source payload or mapper."));
  checks.push({ id: "identity_stability", status: "pass", detail: `The campaign keeps its identity (${base.platform} + ${base.externalCampaignId}); only its branch changes.` });
  checks.push(na("time_and_dates", "A mapping moves whole spend days between branches; no time is reinterpreted."));
  checks.push(na("quarantine_behaviour", "No source record is re-mapped, so nothing is newly quarantined."));
  checks.push({ id: "source_authority", status: "pass", detail: "Spend is owned by the ad platform and is not changed; the mapping is a person-owned configuration, changed only through approval." });

  // ── Coverage: does the evidence agree with the proposed branch? ──
  const totalLeads = base.leadEvidence.reduce((t, e) => t + e.leads, 0);
  const atTarget = base.leadEvidence.find((e) => e.branchId === target.id)?.leads ?? 0;
  const majority = base.leadEvidence[0] ?? null;
  const majorityBrand = majority ? BRANCH_BY_ID.get(majority.branchId)?.brandId ?? null : null;
  const previousBrand = previous ? BRANCH_BY_ID.get(previous)?.brandId ?? null : null;
  const nameBranch = /^(B\d{2})\b/.exec(base.name)?.[1] ?? null;
  const verdict = evidenceVerdict(base, target.id);
  if (previous === target.id) {
    checks.push({ id: "mapping_coverage", status: "fail", code: "NO_CHANGE", detail: `The campaign already maps to ${target.id}; this change would do nothing.` });
  } else if (verdict === "none") {
    checks.push({
      id: "mapping_coverage",
      status: "warn",
      code: "NO_LEAD_EVIDENCE",
      detail: "No lead carries this campaign's id, so the mapping cannot be checked against where its leads arrive. A person must confirm it.",
    });
  } else if (verdict === "disagrees") {
    checks.push({
      id: "mapping_coverage",
      status: "fail",
      code: "LEAD_EVIDENCE_DISAGREES",
      detail: `${totalLeads} lead(s) carry this campaign's id; ${atTarget} arrived at ${target.id} and ${majority!.leads} at ${majority!.branchId}. The mapping contradicts the campaign's own leads.`,
      evidence: { leadEvidence: base.leadEvidence },
    });
  } else if (verdict === "split") {
    checks.push({
      id: "mapping_coverage",
      status: "warn",
      code: "LEAD_EVIDENCE_SPLIT",
      detail: `${atTarget} of ${totalLeads} lead(s) for this campaign arrived at ${target.id}; the rest at ${base.leadEvidence.filter((e) => e.branchId !== target.id).map((e) => e.branchId).join(", ")}.`,
      evidence: { leadEvidence: base.leadEvidence },
    });
  } else {
    checks.push({ id: "mapping_coverage", status: "pass", detail: `All ${totalLeads} lead(s) carrying this campaign's id arrived at ${target.id}.`, evidence: { leadEvidence: base.leadEvidence } });
  }

  // ── Collisions: brand, lineage, name, competing changes ──
  const collisions: string[] = [];
  let collisionStatus: PreflightCheck["status"] = "pass";
  let collisionCode: string | undefined;
  // A campaign belongs to one brand's account: the brand of most of its leads, or for a remap the
  // brand it maps to now. Moving it to another brand is a cross-brand transfer, never routine.
  if (majorityBrand && majorityBrand !== target.brandId) {
    collisionStatus = "fail";
    collisionCode = "CROSS_BRAND";
    collisions.push(`${target.id} belongs to brand "${target.brandId}", but most of this campaign's leads arrive at brand "${majorityBrand}".`);
  } else if (previousBrand && previousBrand !== target.brandId && majorityBrand === target.brandId) {
    // The current mapping is in another brand, but the campaign's own leads arrive at the
    // proposed brand: a correction toward the evidence. Still never routine, so a person must
    // accept the brand change, but blocking it left a mis-mapped campaign with no path to repair
    // (held-out HO-48).
    collisionStatus = "warn";
    collisionCode = "CROSS_BRAND_CORRECTION";
    collisions.push(`The campaign maps to ${previous} (brand "${previousBrand}") now, but most of its leads arrive at brand "${target.brandId}": moving its spend across brands needs a person to confirm which ad account it belongs to.`);
  } else if (previousBrand && previousBrand !== target.brandId) {
    collisionStatus = "fail";
    collisionCode = "CROSS_BRAND";
    collisions.push(`The campaign maps to ${previous} (brand "${previousBrand}") now; moving it to brand "${target.brandId}" is a cross-brand transfer.`);
  }
  const lineageElsewhere = base.lineage.filter((l) => l.branchId !== null && l.branchId !== target.id);
  if (lineageElsewhere.length > 0) {
    if (collisionStatus === "pass") collisionStatus = "warn";
    collisionCode ??= "LINEAGE_ELSEWHERE";
    collisions.push(`Its ${lineageElsewhere.map((l) => `${l.relation} campaign ${l.campaignId} maps to ${l.branchId}`).join("; ")}.`);
  }
  if (nameBranch && nameBranch !== target.id) {
    if (collisionStatus === "pass") collisionStatus = "warn";
    collisionCode ??= "NAME_SUGGESTS_OTHER_BRANCH";
    collisions.push(`The campaign's name starts with ${nameBranch} (a naming convention, not authoritative).`);
  }
  const competing = await tx.query<{ id: string }>(
    `select id from config_changes where kind = 'campaign_mapping' and status in ('ready_for_review', 'approved')
       and (payload ->> 'campaignId')::bigint = $1 and ($2::bigint is null or id <> $2)`,
    [payload.campaignId, args.changeId],
  );
  if (competing.rowCount! > 0) {
    collisionStatus = "fail";
    collisionCode = "COMPETING_CHANGE";
    collisions.push(`Change ${competing.rows.map((r) => r.id).join(", ")} for this campaign is already in review or approved.`);
  }
  checks.push({
    id: "mapping_collision",
    status: collisionStatus,
    code: collisionStatus === "pass" ? undefined : collisionCode,
    detail: collisions.length > 0 ? collisions.join(" ") : previous ? `Remaps the campaign from ${previous} to ${target.id}; no other mapping or change competes.` : "A new mapping; no other mapping or change competes.",
  });

  // ── Permissions ──
  const scopeOk = inScope(viewer, target.id) && inScope(viewer, previous);
  checks.push({
    id: "permissions",
    status: viewer.can.propose && scopeOk ? "pass" : "fail",
    code: viewer.can.propose && scopeOk ? undefined : "NOT_PERMITTED",
    detail:
      viewer.can.propose && scopeOk
        ? "The author may propose this change. Release needs approval by a different person with the approve permission and both branches in scope."
        : `${viewer.label} cannot propose a change touching ${[previous, target.id].filter(Boolean).join(" and ")}.`,
  });

  // ── Run the production write, then measure, then the caller rolls back ──
  const before = await snapshot(tx);
  await applyCampaignMapping(tx, { campaignId: payload.campaignId, branchId: target.id, actor: `preflight:${viewer.subject}`, reason: "preflight (rolled back)", now });
  const after = await snapshot(tx);

  // Branches the change legitimately moves: the spend's old and new home, and the branches where
  // the campaign's leads land (their paid-customer count depends on the campaign being mapped).
  const spendBranches = [previous, target.id].filter((b): b is string => b !== null);
  const evidenceBranches = base.leadEvidence.map((e) => e.branchId).filter((b) => !spendBranches.includes(b));
  const affected = [...spendBranches, ...evidenceBranches];
  const unrelated = [...before.rows.keys()].filter((b) => !affected.includes(b) && before.rows.get(b)!.canonical !== after.rows.get(b)?.canonical);
  const impact: BranchImpact[] = affected
    .map((b): BranchImpact => {
      const pick = (s: Snapshot) => {
        const r = s.rows.get(b);
        return { paidSpendCents: r?.paidSpendCents ?? 0, paidAcquired: r?.paidAcquired ?? 0, paidCacCents: r?.paidCacCents ?? null };
      };
      return { branchId: b, role: b === target.id ? "proposed" : b === previous ? "previous" : "lead_evidence", before: pick(before), after: pick(after) };
    })
    // An evidence branch whose numbers did not move is not news.
    .filter((i) => i.role !== "lead_evidence" || i.before.paidAcquired !== i.after.paidAcquired || i.before.paidSpendCents !== i.after.paidSpendCents);
  const opened = [...after.open].filter(([f]) => !before.open.has(f)).map(([fingerprint, v]) => ({ fingerprint, ...v }));
  const cleared = [...before.open].filter(([f]) => !after.open.has(f)).map(([fingerprint, v]) => ({ fingerprint, ...v }));

  // Money moves, it is not created: the proposed branch gains exactly the campaign's media spend in
  // the window, the previous branch loses exactly that, and company spend is unchanged.
  const moved = base.mediaSpendInWindowCents;
  const delta = (b: string | null) => (b ? (after.rows.get(b)?.paidSpendCents ?? 0) - (before.rows.get(b)?.paidSpendCents ?? 0) : 0);
  const exact = delta(target.id) === moved && (previous === null || delta(previous) === -moved) && before.totalSpendCents === after.totalSpendCents;
  checks.push(
    exact
      ? { id: "financial_precision", status: "pass", detail: `${target.id} gains exactly ${dollars(moved)} of paid spend${previous ? `, ${previous} loses exactly that` : " (from unallocated)"}; company spend is unchanged to the cent (${dollars(before.totalSpendCents)}).` }
      : {
          id: "financial_precision",
          status: "fail",
          code: "SPEND_NOT_CONSERVED",
          detail: `Expected ${target.id} +${dollars(moved)}${previous ? ` and ${previous} −${dollars(moved)}` : ""}; the preview moved ${dollars(delta(target.id))}${previous ? ` and ${dollars(delta(previous))}` : ""} (company spend ${dollars(before.totalSpendCents)} → ${dollars(after.totalSpendCents)}).`,
        },
  );
  const fmtCac = (c: number | null) => (c === null ? "n/a" : dollars(c));
  checks.push({
    id: "reporting_impact",
    status: unrelated.length > 0 ? "fail" : "pass",
    code: unrelated.length > 0 ? "UNRELATED_BRANCHES_CHANGED" : undefined,
    detail:
      unrelated.length > 0
        ? `Branches outside the change moved in the preview: ${unrelated.join(", ")}.`
        : `${impact.map((i) => `${i.branchId} (${i.role.replace("_", " ")}): paid spend ${dollars(i.before.paidSpendCents)} → ${dollars(i.after.paidSpendCents)}, paid customers ${i.before.paidAcquired} → ${i.after.paidAcquired}, paid CAC ${fmtCac(i.before.paidCacCents)} → ${fmtCac(i.after.paidCacCents)}`).join("; ")}. Every other branch is unchanged. Applies to ${base.spendDays.days} spend day(s)${base.spendDays.first ? ` from ${base.spendDays.first} to ${base.spendDays.last}` : ""}.`,
  });
  checks.push({
    id: "downstream_completeness",
    status: opened.length > 0 ? "warn" : "pass",
    code: opened.length > 0 ? "OPENS_EXCEPTIONS" : undefined,
    detail: `Reconciliation after the change: ${cleared.length} exception(s) would clear${cleared.length ? ` (${cleared.map((c) => c.kind).join(", ")})` : ""}, ${opened.length} would open${opened.length ? ` (${opened.map((o) => o.kind).join(", ")})` : ""}.`,
  });
  checks.push({
    id: "replay_safety",
    status: "pass",
    detail: "Releasing is idempotent: the approval binds one configuration hash, the release locks the change row, and a change can be released once.",
  });
  checks.push({
    id: "recovery",
    status: "pass",
    detail: previous
      ? `Reversible by a compensating change back to ${previous}, with its own preflight and approval. No external system is touched.`
      : "Reversible by unmapping through a compensating change; no external system is touched. Spend returns to unallocated.",
  });

  const ordering = ordered(checks);
  const result: PreflightResult = {
    kind: "campaign_mapping",
    verdict: verdictOf(ordering),
    checks: ordering,
    impact,
    exceptionsOpened: opened,
    exceptionsCleared: cleared,
    unrelatedBranchesChanged: unrelated,
    dependentMetrics: dependenciesOf("campaign_branch_map"),
    limitations,
  };
  return { result, baseHash: baseHashOf(base, target.id), base };
}

/** The refusal code a mapper gives a record, or null if it projects it. */
function misreadBy(mapper: ReturnType<typeof mapperFor>, record: RawRecord): string | null {
  const identity = mapper.identify(record, referenceContext);
  if (!("entityId" in identity)) return identity.code;
  const mapped = mapper.map(record, { ...referenceContext, receivedAt: new Date(0) });
  return mapped.ok ? null : mapped.code;
}

function shapeOf(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? [path, ...shapeOf(v, path)] : [path];
  });
}

/**
 * Preflight of an upstream shape change: sample payloads through the deployed mapper. Pure
 * mapper calls plus one read of the latest stored payload; nothing is written.
 */
export async function preflightSourceContract(db: Queryable, args: { payload: SourceContractPayload; viewer: Viewer }): Promise<{ result: PreflightResult; baseHash: string }> {
  const { payload } = args;
  const source = payload.source as SourceName;
  const mapper = mapperFor(source);
  const latest = await db.query<{ payload: unknown }>("select payload from raw_events where source = $1 and entity = $2 and status = 'projected' order by id desc limit 1", [source, payload.entity]);
  const knownShape = new Set(latest.rowCount ? shapeOf(latest.rows[0].payload) : []);
  const stagedVersions = mapperVersions(source).filter((v) => compareVersions(v, ACTIVE_VERSION[source]) > 0);
  const seen = new Set<string>();
  const samples = payload.samples.map((sample, index) => {
    const record: RawRecord = { entity: payload.entity, payload: sample };
    const shape = shapeOf(sample);
    const added = knownShape.size ? shape.filter((p) => !knownShape.has(p)) : [];
    const removed = knownShape.size ? [...knownShape].filter((p) => !shape.includes(p)) : [];
    const identity = mapper.identify(record, referenceContext);
    if (!("entityId" in identity)) return { index, outcome: `refused:${identity.code}`, detail: identity.detail, addedFields: added, removedFields: removed };
    if (seen.has(identity.externalId)) return { index, outcome: "duplicate", detail: "same record version as an earlier sample", addedFields: added, removedFields: removed };
    seen.add(identity.externalId);
    const mapped = mapper.map(record, { ...referenceContext, receivedAt: new Date(0) });
    if (isExclusion(mapped)) return { index, outcome: `excluded:${mapped.code}`, detail: mapped.detail, addedFields: added, removedFields: removed };
    if (!mapped.ok) return { index, outcome: `refused:${mapped.code}`, detail: mapped.detail, addedFields: added, removedFields: removed };
    // A staged version reads documented vendor fields the deployed one ignores. If it refuses a
    // record the deployed mapper projects, the deployed mapper would count it with no signal
    // (outbound or spam calls as leads, another currency as dollars; held-out HO-24 / HO-25).
    const misread = stagedVersions.map((v) => ({ v, r: misreadBy(mapperFor(source, v), record) })).find((x) => x.r !== null);
    return { index, outcome: `projected:${mapped.projection.table}`, detail: "", addedFields: added, removedFields: removed, ...(misread ? { stagedOutcome: `${source}@${misread.v} refused:${misread.r}` } : {}) };
  });
  const misreads = samples.filter((s): s is typeof s & { stagedOutcome: string } => "stagedOutcome" in s && typeof s.stagedOutcome === "string");
  const misreadCodes = [...new Set(misreads.map((s) => s.stagedOutcome))];
  const refused = samples.filter((s) => s.outcome.startsWith("refused:"));
  const excluded = samples.filter((s) => s.outcome.startsWith("excluded:"));
  const duplicates = samples.filter((s) => s.outcome === "duplicate");
  const codes = [...new Set(refused.map((s) => s.outcome.slice(8)))];
  const added = [...new Set(samples.flatMap((s) => s.addedFields))];
  const removed = [...new Set(samples.flatMap((s) => s.removedFields))];
  const deps = dependenciesOf(source, source === "crm" ? payload.entity : undefined);
  const version = `${source}@${ACTIVE_VERSION[source]}`;
  const structural = added.length || removed.length ? ` Shape differs from the latest stored ${payload.entity}: added ${added.join(", ") || "none"}; missing ${removed.join(", ") || "none"}.` : "";

  const checks: PreflightCheck[] = [
    refused.length > 0
      ? { id: "schema_compatibility", status: "fail", code: "INCOMPATIBLE_SHAPE", detail: `${refused.length} of ${samples.length} sample(s) are refused by the deployed mapper ${version} (${codes.join(", ")}).${structural}` }
      : misreads.length > 0
        ? {
            id: "schema_compatibility",
            status: "warn",
            code: "DEPLOYED_MAPPER_MISREADS",
            detail: `${misreads.length} of ${samples.length} sample(s) map under the deployed ${version}, but the staged version, which reads documented vendor fields ${version} ignores, refuses them (${misreadCodes.join(", ")}). The deployed mapper would count them with no signal; ${deps.join(", ") || "its metrics"} would include them. Activating the staged version is a code deploy; a person must decide before this shape is connected.${structural}`,
          }
        : { id: "schema_compatibility", status: "pass", detail: `Every sample maps under the deployed ${version}${stagedVersions.length ? ` and under the staged ${stagedVersions.map((v) => `${source}@${v}`).join(", ")}` : ""}.${structural}${added.length && !removed.length ? " Added fields are ignored by the mapper: a structural difference, not a contract violation." : ""}` },
    refused.some((s) => /MISSING_IDENTITY|MISSING_FIELD/.test(s.outcome))
      ? { id: "identifier_presence", status: "fail", code: "MISSING_IDENTIFIER", detail: "Some samples lack a required identifier or field." }
      : { id: "identifier_presence", status: "pass", detail: "Every sample carries the identifiers the mapper requires." },
    na("mapping_coverage", "A shape change does not touch branch or brand mappings; branch codes are still validated by the mapper."),
    na("mapping_collision", "No mapping is changed."),
    { id: "identity_stability", status: "pass", detail: "Record identity is computed by the deployed mapper's identify(), unchanged by this preflight." },
    refused.some((s) => /TIMESTAMP|TIME_ZONE/.test(s.outcome))
      ? { id: "time_and_dates", status: "fail", code: "INVALID_TIME", detail: "Some samples carry times the mapper cannot place." }
      : { id: "time_and_dates", status: "pass", detail: "Every sample's times parse under the mapper's rules." },
    { id: "financial_precision", status: "pass", detail: "Money is validated by the mapper itself (exact cents, at most 13 whole digits); a sample that breaks it is refused, never rounded." },
    { id: "replay_safety", status: "pass", detail: duplicates.length ? `${duplicates.length} sample(s) repeat an earlier record version: intake stores them once and counts the re-delivery.` : "No sample repeats a record version." },
    { id: "source_authority", status: "pass", detail: `${source} is the authority for ${payload.entity} records; nothing here overrides it.` },
    { id: "reporting_impact", status: refused.length ? "warn" : "pass", code: refused.length ? "DEPENDENT_METRICS" : undefined, detail: `Metrics reading ${source} ${payload.entity}: ${deps.join(", ") || "none listed"}.` },
    { id: "permissions", status: args.viewer.can.propose ? "pass" : "fail", code: args.viewer.can.propose ? undefined : "NOT_PERMITTED", detail: args.viewer.can.propose ? "The author may propose this check." : `${args.viewer.label} cannot propose changes.` },
    refused.length
      ? { id: "downstream_completeness", status: "fail", code: "RECORDS_WOULD_NOT_ARRIVE", detail: `${refused.length} record(s) of this shape would not reach the ledger's projection; ${deps.join(", ")} would be understated until a fix and replay.` }
      : excluded.length
        ? {
            id: "downstream_completeness",
            status: "warn",
            code: "RECORDS_EXCLUDED",
            detail: `${excluded.length} of ${samples.length} sample(s) are marked by the source as not counted (${[...new Set(excluded.map((s) => s.outcome.slice(9)))].join(", ")}): they would be kept as evidence and left out of ${deps.join(", ") || "the metrics"}. A person should confirm that is what this shape means.`,
          }
        : { id: "downstream_completeness", status: "pass", detail: "Every sample would reach its projection." },
    { id: "quarantine_behaviour", status: "pass", detail: refused.length ? `Refused records are quarantined with their code (${codes.join(", ")}) and stay replayable; nothing is dropped or guessed.` : "Nothing would be quarantined." },
    { id: "recovery", status: "pass", detail: "Preflight only. Activating a mapper version is a code deploy here; held records are recovered by a replay through the Action Center." },
  ];
  const ordering = ordered(checks);
  return {
    result: {
      kind: "source_contract",
      verdict: verdictOf(ordering),
      checks: ordering,
      impact: [],
      exceptionsOpened: [],
      exceptionsCleared: [],
      unrelatedBranchesChanged: [],
      dependentMetrics: deps,
      limitations: ["A sample shows what the deployed mapper does with these payloads; it says nothing about payloads not sampled.", "Releasing a mapper version needs a code deploy, so this kind stops at review."],
      samples: samples.map((s) => ({ index: s.index, outcome: s.outcome, addedFields: s.addedFields, removedFields: s.removedFields, ...("stagedOutcome" in s && s.stagedOutcome ? { stagedOutcome: s.stagedOutcome } : {}) })),
    },
    baseHash: sha256(canonicalJson({ version, knownShape: [...knownShape].sort() })),
  };
}
