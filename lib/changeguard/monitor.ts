import type { Pool } from "pg";
import { ActionError } from "@/lib/actions";
import { getNow, withTransaction, type Queryable } from "@/lib/db";
import { feedFreshness, FRESHNESS_MAX_AGE_HOURS, staleReason } from "@/lib/decision/verdicts";
import { lockReconcile } from "@/lib/reconcile/reconcile";
import type { Viewer } from "@/lib/viewer";
import { syncCases } from "@/lib/workflow/cases";
import { assertChangeTransition, CampaignMappingPayload, type ChangeStatus } from "./model";
import { evidenceVerdict, readCampaignBase, type EvidenceVerdict } from "./preflight";
import { isOverdue, nextSlot, RETRY_AFTER_MS } from "./schedule";
import { assertScope, branchesOf, getChangeTx, recordEvent, toRow, type ChangeRow, type ReleaseEvidence, type Verification, type VerificationCheck } from "./service";

/**
 * Post-release monitoring for ChangeGuard campaign mappings (R-30).
 *
 * ONE check, run by the worker for each scheduled slot (./schedule.ts) and on request
 * ("Re-verify now"). It asks whether the released mapping can still be called current:
 *
 *   still_applied            the live mapping is the released one. A newer ChangeGuard release of
 *                            the same campaign REPLACES this change; any other move is a drift.
 *   campaign_id_unambiguous  leads carry a campaign id without a platform (R-46, open). When
 *                            another platform's campaign shares the id, the leads cannot be told
 *                            apart: the check says so and certifies nothing, rather than choosing.
 *   evidence_since_release   where the campaign's leads arrive now, against where they arrived
 *                            when the release was approved: the coverage rule the preflight
 *                            applied (evidenceVerdict) and the evidence branches the approval was
 *                            bound to (baseHashOf). A lead at a branch the approval never saw, a
 *                            verdict that worsened, or evidence withdrawn is a confirmed drift.
 *   feeds_current            the lead feeds that carry the campaign delivered recently enough
 *                            (the freshness rule Decision Lab and Shadow Mode use). A stale or
 *                            failing feed means the mapping cannot be certified as current.
 *
 * Outcomes: current · insufficient_evidence · drift · superseded, or error (the check did not
 * run). Precedence: replaced > mapping moved > ambiguous id > evidence drift > stale feed.
 * Stored records that contradict the mapping are a drift even while a feed is stale (what is
 * stored stays true); an ambiguous id blocks both verdicts, because the contradicting leads may
 * be the other campaign's.
 *
 * Writes, in one transaction under the mapping lock: the run (change_monitor_runs), the change's
 * monitoring columns and, for a drift, ONE review item (a mapping_drift exception keyed by the
 * change: created once, updated after) with its Action Center case. Never campaign_branch_map,
 * mapping versions, credits or any source record. last_verified_at moves only on "current".
 *
 * Concurrency: the evaluation reads outside the lock; the record step takes the mapping lock
 * (lockReconcile, which every mapping write takes), then the change row, and re-reads the mapping
 * version. If a release landed in between, the evaluation is redone under the lock, so a "current"
 * is never recorded for a mapping that was replaced meanwhile. A second worker on the same slot
 * finds it concluded and records nothing (a unique index backs that).
 */

export type MonitorOutcome = "current" | "insufficient_evidence" | "drift" | "superseded" | "error";
export type MonitorState = "current" | "overdue" | "insufficient_evidence" | "confirmed_drift" | "replaced";

const MONITORED: readonly ChangeStatus[] = ["verified", "degraded", "recovery_required"];
const RANK: Record<EvidenceVerdict, number> = { none: 0, agrees: 0, split: 1, disagrees: 2 };

export const LIMITATIONS = [
  "This check reads where the campaign's leads arrive, not which customer each lead credits: the shared-phone credit rule (R-39, open) is outside it.",
  "Leads carry a campaign id without a platform (R-46, open): when two platforms use one id, the check reports the overlap and certifies nothing.",
  "A record a feed never delivered is invisible here: a stale or failing feed is reported, never read as \"no new evidence\".",
  "A correct mapping is not evidence of more revenue: business improvement is not measured.",
];

export interface ConflictingLead {
  leadId: number;
  source: string;
  sourceLeadId: string;
  branchId: string;
  overridden: boolean;
  rawEventId: number;
  deliveredAt: string;
  firstSeenAt: string;
  /** The version before the current one, when the current one is a revision. */
  previousRawEventId: number | null;
  previousBranchId: string | null;
}

export interface MonitorEvidence {
  campaign: { id: number; externalId: string; platform: string; name: string };
  releasedBranchId: string;
  liveBranchId: string | null;
  mapping: { version: number | null; changeId: number | null; branchId: string | null };
  atRelease: ReleaseEvidence;
  now: { leadEvidence: Array<{ branchId: string; leads: number }>; verdict: EvidenceVerdict };
  newBranches: string[];
  conflicting: ConflictingLead[];
  /** Lead records of this campaign delivered since the release. */
  sinceRelease: { newLeads: number; revisions: number; excluded: number };
  /** Other campaigns using the same external id (R-46). */
  sharedId: Array<{ campaignId: number; platform: string; name: string; branchId: string | null }>;
  feeds: Array<{ source: string; stream: string | null; stale: string | null }>;
  /** Scheduled slots that passed with no run; this run covers them. */
  missedSlots: number;
  limitations: string[];
}

export interface MonitorScope {
  branches: string[];
  campaignIds: number[];
  rawEventIds: number[];
  spendAtStakeCents: number;
}

export interface Evaluation {
  outcome: Exclude<MonitorOutcome, "error">;
  reasons: string[];
  severity: "high" | "medium";
  supersededBy: number | null;
  mappingVersion: number | null;
  checks: VerificationCheck[];
  evidence: MonitorEvidence;
  scope: MonitorScope;
}

export interface MonitorRun {
  id: number;
  changeId: number;
  trigger: "scheduled" | "manual";
  slotAt: string | null;
  ranAt: string;
  ranBy: string;
  outcome: MonitorOutcome;
  mappingVersion: number | null;
  checks: VerificationCheck[];
  evidence: Partial<MonitorEvidence> & { reasons?: string[]; reevaluated?: boolean };
  scope: Partial<MonitorScope>;
  exceptionId: number | null;
  error: string | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function toRun(r: Record<string, unknown>): MonitorRun {
  return {
    id: Number(r.id),
    changeId: Number(r.change_id),
    trigger: r.trigger as MonitorRun["trigger"],
    slotAt: iso(r.slot_at as Date | null),
    ranAt: iso(r.ran_at as Date)!,
    ranBy: r.ran_by as string,
    outcome: r.outcome as MonitorOutcome,
    mappingVersion: r.mapping_version === null ? null : Number(r.mapping_version),
    checks: (r.checks as VerificationCheck[]) ?? [],
    evidence: (r.evidence as MonitorRun["evidence"]) ?? {},
    scope: (r.scope as MonitorRun["scope"]) ?? {},
    exceptionId: r.exception_id === null ? null : Number(r.exception_id),
    error: (r.error as string | null) ?? null,
  };
}

async function mappingVersion(db: Queryable, campaignId: number): Promise<{ version: number | null; changeId: number | null; branchId: string | null }> {
  const { rows } = await db.query<{ version: number; change_id: string | null; branch_id: string | null }>(
    "select version, change_id, branch_id from campaign_mapping_versions where campaign_id = $1 order by version desc limit 1",
    [campaignId],
  );
  const v = rows[0];
  return v ? { version: v.version, changeId: v.change_id === null ? null : Number(v.change_id), branchId: v.branch_id } : { version: null, changeId: null, branchId: null };
}

/** What the release was approved on. Older releases did not record it: the preflight's coverage evidence is what the reviewer saw. */
function releaseEvidenceOf(change: ChangeRow, branchId: string): ReleaseEvidence {
  if (change.verification?.releaseEvidence) return change.verification.releaseEvidence;
  const coverage = change.preflight?.checks.find((c) => c.id === "mapping_coverage");
  const leadEvidence = (coverage?.evidence?.leadEvidence as ReleaseEvidence["leadEvidence"] | undefined) ?? [];
  return { leadEvidence, verdict: evidenceVerdict({ leadEvidence }, branchId), sources: [] };
}

const describe = (evidence: Array<{ branchId: string; leads: number }>) => (evidence.length === 0 ? "no leads" : evidence.map((e) => `${e.leads} at ${e.branchId}`).join(", "));

/**
 * The records that contradict the approval: leads of this campaign at a branch the approval never
 * saw and, when the verdict worsened, leads at any other branch delivered (new or revised) after
 * the release. A lead at a second branch the approval DID see (a split release) contradicts
 * nothing on its own.
 */
async function conflictingLeads(db: Queryable, externalId: string, target: string, newBranches: string[], deliveredAfter: string | null): Promise<ConflictingLead[]> {
  const { rows } = await db.query(
    `select l.id as lead_id, l.source, l.source_lead_id, l.effective_branch_id as branch_id, l.branch_overridden, l.raw_event_id,
            cur.last_delivered_at as delivered_at,
            (select min(f.received_at) from raw_events f where f.source = cur.source and f.entity = cur.entity and f.entity_id = cur.entity_id) as first_seen_at,
            prev.id as previous_raw_event_id, payload_branch(prev.payload) as previous_branch_id
     from v_leads l
     join raw_events cur on cur.id = l.raw_event_id
     left join lateral (
       select p.id, p.payload from raw_events p
       where p.source = cur.source and p.entity = cur.entity and p.entity_id = cur.entity_id and p.id <> cur.id and p.received_at <= cur.received_at
       order by p.received_at desc, p.id desc limit 1) prev on true
     where l.campaign_external_id = $1 and l.effective_branch_id <> $2
       and (l.effective_branch_id = any($3::text[]) or ($4::timestamptz is not null and cur.last_delivered_at > $4::timestamptz))
     order by cur.last_delivered_at desc, l.id
     limit 200`,
    [externalId, target, newBranches, deliveredAfter],
  );
  return rows.map((r) => ({
    leadId: Number(r.lead_id),
    source: r.source,
    sourceLeadId: r.source_lead_id,
    branchId: r.branch_id,
    overridden: r.branch_overridden,
    rawEventId: Number(r.raw_event_id),
    deliveredAt: new Date(r.delivered_at).toISOString(),
    firstSeenAt: new Date(r.first_seen_at).toISOString(),
    previousRawEventId: r.previous_raw_event_id === null ? null : Number(r.previous_raw_event_id),
    previousBranchId: r.previous_branch_id ?? null,
  }));
}

async function sinceRelease(db: Queryable, externalId: string, releasedAt: string): Promise<MonitorEvidence["sinceRelease"]> {
  const { rows } = await db.query<{ new_leads: string; revisions: string; excluded: string }>(
    `select count(*) filter (where l.excluded_code is null and f.first_seen > $2) as new_leads,
            count(*) filter (where l.excluded_code is null and f.first_seen <= $2) as revisions,
            count(*) filter (where l.excluded_code is not null and l.excluded_at > $2) as excluded
     from leads l
     join raw_events cur on cur.id = l.raw_event_id
     cross join lateral (select min(x.received_at) as first_seen from raw_events x
                         where x.source = cur.source and x.entity = cur.entity and x.entity_id = cur.entity_id) f
     where l.campaign_external_id = $1 and (cur.last_delivered_at > $2 or l.excluded_at > $2)`,
    [externalId, releasedAt],
  );
  return { newLeads: Number(rows[0].new_leads), revisions: Number(rows[0].revisions), excluded: Number(rows[0].excluded) };
}

/** Reads only. `db` may be one transaction's client: queries run one at a time. */
export async function evaluate(db: Queryable, change: ChangeRow, now: Date): Promise<Evaluation> {
  const payload = CampaignMappingPayload.parse(change.payload);
  if (!change.releasedAt) throw new ActionError(`Change ${change.id} was never released`, 409);
  const base = await readCampaignBase(db, payload.campaignId);
  if (!base) throw new Error(`Campaign ${payload.campaignId} of change ${change.id} no longer exists`);
  const target = payload.branchId;
  const mapping = await mappingVersion(db, payload.campaignId);
  const atRelease = releaseEvidenceOf(change, target);

  const shared = await db.query<{ id: string; platform: string; name: string; branch_id: string | null }>(
    `select c.id, c.platform, c.name, m.branch_id from ad_campaigns c left join campaign_branch_map m on m.campaign_id = c.id
     where c.external_campaign_id = $1 and c.id <> $2 order by c.platform, c.id`,
    [base.externalCampaignId, base.campaignId],
  );
  const sharedId = shared.rows.map((r) => ({ campaignId: Number(r.id), platform: r.platform, name: r.name, branchId: r.branch_id }));

  const approved = new Set([target, ...atRelease.leadEvidence.map((e) => e.branchId)]);
  const newBranches = base.leadEvidence.map((e) => e.branchId).filter((b) => !approved.has(b));
  const verdictNow = evidenceVerdict(base, target);
  const withdrawn = atRelease.verdict !== "none" && verdictNow === "none";
  const worsened = RANK[verdictNow] > RANK[atRelease.verdict];
  const conflicting = newBranches.length > 0 || worsened ? await conflictingLeads(db, base.externalCampaignId, target, newBranches, worsened ? change.releasedAt : null) : [];
  const since = await sinceRelease(db, base.externalCampaignId, change.releasedAt);

  const used = await db.query<{ source: string }>("select distinct source from leads where campaign_external_id = $1", [base.externalCampaignId]);
  const sources = [...new Set([...atRelease.sources, ...used.rows.map((r) => r.source)])].sort();
  const watched = sources.length > 0 ? sources : ["calls", "web"];
  const states = await feedFreshness(db);
  const feeds: MonitorEvidence["feeds"] = [];
  for (const source of watched) {
    const own = states.filter((f) => f.source === source);
    if (own.length === 0) feeds.push({ source, stream: null, stale: `The ${source} feed has never delivered a record.` });
    for (const f of own) feeds.push({ source, stream: f.stream, stale: staleReason(f, now) });
  }
  const staleFeeds = feeds.filter((f) => f.stale !== null);

  const replaced = mapping.changeId !== null && mapping.changeId !== change.id;
  const moved = !replaced && base.currentBranchId !== target;
  const ambiguous = sharedId.length > 0;
  const conflict = newBranches.length > 0 || worsened || withdrawn;

  const reasons: string[] = [];
  let outcome: Evaluation["outcome"];
  if (replaced) {
    outcome = "superseded";
    reasons.push("REPLACED_BY_NEWER_RELEASE");
  } else if (moved) {
    outcome = "drift";
    reasons.push("MAPPING_MOVED_OUTSIDE_CHANGEGUARD");
  } else if (ambiguous) {
    outcome = "insufficient_evidence";
    reasons.push("CAMPAIGN_ID_AMBIGUOUS");
  } else if (conflict) {
    outcome = "drift";
    if (newBranches.length > 0) reasons.push("LEAD_OUTSIDE_APPROVED_EVIDENCE");
    if (worsened) reasons.push("EVIDENCE_VERDICT_WORSENED");
    if (withdrawn) reasons.push("EVIDENCE_WITHDRAWN");
  } else if (staleFeeds.length > 0) {
    outcome = "insufficient_evidence";
    reasons.push("FEED_STALE");
  } else {
    outcome = "current";
  }
  // A stale feed is named beside a drift or an ambiguity too: what was not delivered is unknown either way.
  if (staleFeeds.length > 0 && outcome !== "superseded" && !reasons.includes("FEED_STALE")) reasons.push("FEED_STALE");

  const live = base.currentBranchId ?? "unmapped";
  const total = base.leadEvidence.reduce((t, e) => t + e.leads, 0);
  const atTarget = base.leadEvidence.find((e) => e.branchId === target)?.leads ?? 0;
  const sinceText = `Since the release: ${since.newLeads} new lead(s), ${since.revisions} revised${since.excluded ? `, ${since.excluded} excluded` : ""}.`;
  const checks: VerificationCheck[] = [
    replaced
      ? { id: "still_applied", layer: "configuration", passed: false, status: "fail", detail: `Replaced by change #${mapping.changeId} (mapping version ${mapping.version}): the live mapping is ${live}. This change is no longer monitored.` }
      : moved
        ? { id: "still_applied", layer: "configuration", passed: false, status: "fail", detail: `The live mapping is ${live}, but no ChangeGuard release made it (released: ${target}, mapping version ${mapping.version}).` }
        : { id: "still_applied", layer: "configuration", passed: true, status: "pass", detail: `The live mapping is ${target}, as released (mapping version ${mapping.version}).` },
    ambiguous
      ? {
          id: "campaign_id_unambiguous",
          layer: "data_integrity",
          passed: false,
          status: "unknown",
          detail: `Leads carry campaign id ${base.externalCampaignId} without a platform, and ${sharedId.length} other campaign(s) use it (${sharedId.map((s) => s.platform).join(", ")}). Their leads cannot be told apart, so this check certifies nothing (R-46, open).`,
        }
      : { id: "campaign_id_unambiguous", layer: "data_integrity", passed: true, status: "pass", detail: `Only this campaign (${base.platform}) uses id ${base.externalCampaignId}.` },
    ambiguous
      ? {
          id: "evidence_since_release",
          layer: "operational",
          passed: false,
          status: "unknown",
          detail: `Not judged: the campaign id is ambiguous.${conflicting.length ? ` ${conflicting.length} lead(s) with this id arrive outside the approved evidence; they may be the other campaign's.` : ""} ${sinceText}`,
        }
      : conflict
        ? {
            id: "evidence_since_release",
            layer: "operational",
            passed: false,
            status: "fail",
            detail: [
              newBranches.length > 0 ? `${conflicting.filter((c) => newBranches.includes(c.branchId)).length} lead(s) carrying this campaign's id now arrive at ${newBranches.join(", ")}, a branch the approval did not see (approved on: ${describe(atRelease.leadEvidence)}).` : null,
              worsened ? `The coverage verdict went from ${atRelease.verdict} to ${verdictNow} (${atTarget} of ${total} at ${target}).` : null,
              withdrawn ? `The leads the release relied on are gone (${since.excluded} excluded since the release).` : null,
              sinceText,
            ].filter(Boolean).join(" "),
          }
        : { id: "evidence_since_release", layer: "operational", passed: true, status: "pass", detail: `${total} lead(s) carry this campaign's id, all at branches the approval saw (${describe(base.leadEvidence)}). ${sinceText}` },
    staleFeeds.length > 0
      ? { id: "feeds_current", layer: "operational", passed: false, status: "fail", detail: staleFeeds.map((f) => f.stale).join(" ") }
      : { id: "feeds_current", layer: "operational", passed: true, status: "pass", detail: `${watched.join(" and ")} delivered within ${FRESHNESS_MAX_AGE_HOURS} h of the check.` },
  ];

  const branches = new Set<string>([target]);
  if (base.currentBranchId) branches.add(base.currentBranchId);
  for (const b of newBranches) branches.add(b);
  for (const c of conflicting) branches.add(c.branchId);
  if (ambiguous) for (const e of base.leadEvidence) branches.add(e.branchId);
  for (const s of sharedId) if (s.branchId) branches.add(s.branchId);

  return {
    outcome,
    reasons,
    severity: moved || verdictNow === "disagrees" ? "high" : "medium",
    supersededBy: replaced ? mapping.changeId : null,
    mappingVersion: mapping.version,
    checks,
    evidence: {
      campaign: { id: base.campaignId, externalId: base.externalCampaignId, platform: base.platform, name: base.name },
      releasedBranchId: target,
      liveBranchId: base.currentBranchId,
      mapping,
      atRelease,
      now: { leadEvidence: base.leadEvidence, verdict: verdictNow },
      newBranches,
      conflicting,
      sinceRelease: since,
      sharedId,
      feeds,
      missedSlots: 0,
      limitations: LIMITATIONS,
    },
    scope: {
      branches: [...branches].sort(),
      campaignIds: [base.campaignId, ...sharedId.map((s) => s.campaignId)],
      rawEventIds: [...new Set(conflicting.flatMap((c) => [c.rawEventId, ...(c.previousRawEventId ? [c.previousRawEventId] : [])]))],
      spendAtStakeCents: base.mediaSpendInWindowCents,
    },
  };
}

export interface MonitorHooks {
  /** Test seam: runs between the evaluation and the record step (a controlled race). */
  beforeRecord?: (changeId: number) => Promise<void>;
}

export interface CheckOptions {
  trigger: "scheduled" | "manual";
  /** The scheduled slot this run answers (scheduled runs only). */
  slot: Date | null;
  /** Business clock. */
  now: Date;
  ranBy: string;
  /** Who a status change is attributed to (default: the monitoring system). */
  actor?: { subject: string; role: string };
  hooks?: MonitorHooks;
}

export interface CheckResult {
  changeId: number;
  runId: number | null;
  outcome: MonitorOutcome | "skipped";
  status: ChangeStatus;
  exceptionId: number | null;
  /** True when a release landed between the evaluation and the record step, and the check was redone. */
  reevaluated: boolean;
  detail?: string;
}

const SYSTEM = { subject: "system:monitor", role: "system" };

/** Same slot still open? A second worker on a slot finds it moved and records nothing. */
function slotIsOpen(row: ChangeRow, opts: CheckOptions): boolean {
  if (opts.trigger !== "scheduled") return true;
  return row.monitorDueAt !== null && opts.slot !== null && new Date(row.monitorDueAt).getTime() === opts.slot.getTime();
}

export async function runCheck(pool: Pool, changeId: number, opts: CheckOptions): Promise<CheckResult> {
  let first: Evaluation | null = null;
  let failure: Error | null = null;
  try {
    first = await evaluate(pool, await getChangeTx(pool, changeId), opts.now);
  } catch (error) {
    failure = error as Error;
  }
  await opts.hooks?.beforeRecord?.(changeId);
  if (failure) return recordError(pool, changeId, opts, failure);
  try {
    return await recordConclusion(pool, changeId, opts, first!);
  } catch (error) {
    if (error instanceof ActionError) throw error;
    return recordError(pool, changeId, opts, error as Error);
  }
}

async function recordConclusion(pool: Pool, changeId: number, opts: CheckOptions, first: Evaluation): Promise<CheckResult> {
  return withTransaction(pool, async (tx) => {
    // Mapping lock first (the order every exception and mapping writer uses), then the row.
    await lockReconcile(tx);
    const row = toRow((await tx.query("select * from config_changes where id = $1 for update", [changeId])).rows[0]);
    const skipped = (detail: string): CheckResult => ({ changeId, runId: null, outcome: "skipped", status: row.status, exceptionId: null, reevaluated: false, detail });
    if (!slotIsOpen(row, opts)) return skipped("This slot was already concluded by another run.");
    if (!MONITORED.includes(row.status)) return skipped(`The change is ${row.status}; it is not monitored.`);

    // The fencing token: if the mapping moved since the evaluation read it, judge again now, under the lock.
    const payload = CampaignMappingPayload.parse(row.payload);
    let ev = first;
    let reevaluated = false;
    if ((await mappingVersion(tx, payload.campaignId)).version !== first.mappingVersion) {
      ev = await evaluate(tx, row, opts.now);
      reevaluated = true;
    }

    const scheduled = opts.trigger === "scheduled";
    const until = row.monitorUntil ? new Date(row.monitorUntil) : null;
    const slot = scheduled ? nextSlot(opts.slot!, opts.now, until) : null;
    ev.evidence.missedSlots = slot?.missed ?? 0;

    let to: ChangeStatus = row.status;
    if (ev.outcome === "drift" && row.status !== "recovery_required") to = "recovery_required";
    if (ev.outcome === "current" && row.status !== "recovery_required") to = (row.verification?.checks ?? []).every((c) => c.passed) ? "verified" : "degraded";
    if (to !== row.status) assertChangeTransition(row.status, to);
    // Only a check that found the mapping current is a successful verification. While a drift is
    // open (recovery required), a later clean read does not certify the change either.
    const refresh = ev.outcome === "current" && to !== "recovery_required";

    const inserted = await tx.query<{ id: string }>(
      `insert into change_monitor_runs (change_id, trigger, slot_at, ran_at, ran_by, outcome, mapping_version, checks, evidence, scope)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict do nothing returning id`,
      [changeId, opts.trigger, opts.slot, opts.now, opts.ranBy, ev.outcome, ev.mappingVersion, JSON.stringify(ev.checks), { ...ev.evidence, reasons: ev.reasons, reevaluated }, ev.scope],
    );
    if (inserted.rowCount === 0) return skipped("This slot was already concluded by another run.");
    const runId = Number(inserted.rows[0].id);

    let exceptionId: number | null = null;
    if (ev.outcome === "drift") {
      exceptionId = await upsertReviewItem(tx, row, ev, runId, opts.now);
      await tx.query("update change_monitor_runs set exception_id = $2 where id = $1", [runId, exceptionId]);
    }

    const verification: Verification = {
      ...(row.verification ?? { checks: [], businessImprovement: "not measured", at: row.releasedAt! }),
      monitor: ev.checks,
      monitorRunId: runId,
    };
    const stopSchedule = ev.outcome === "superseded";
    const moveSchedule = scheduled || stopSchedule;
    await tx.query(
      `update config_changes set status = $2, verification = $3,
         last_verified_at = case when $4::boolean then $5::timestamptz else last_verified_at end,
         monitor_due_at   = case when $6::boolean then $7::timestamptz else monitor_due_at end,
         monitor_retry_at = case when $6::boolean then null else monitor_retry_at end
       where id = $1`,
      [changeId, to, verification, refresh, opts.now, moveSchedule, stopSchedule ? null : (slot?.next ?? null)],
    );
    if (to !== row.status) await recordEvent(tx, changeId, row.status, to, opts.actor ?? SYSTEM, opts.now, { runId, outcome: ev.outcome, reasons: ev.reasons });
    await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'config_change_monitor_check', $3, $4)", [
      opts.now,
      (opts.actor ?? SYSTEM).role,
      `config_change:${changeId}`,
      { runId, trigger: opts.trigger, slot: opts.slot?.toISOString() ?? null, outcome: ev.outcome, reasons: ev.reasons, by: opts.ranBy, exceptionId, reevaluated },
    ]);
    return { changeId, runId, outcome: ev.outcome, status: to, exceptionId, reevaluated };
  });
}

/** The check did not run to a conclusion: nothing is concluded, nothing is refreshed; the slot is tried again later. */
async function recordError(pool: Pool, changeId: number, opts: CheckOptions, failure: Error): Promise<CheckResult> {
  const message = failure.message.slice(0, 500);
  console.error(JSON.stringify({ level: "error", msg: "post-release check failed", changeId, trigger: opts.trigger, slot: opts.slot?.toISOString() ?? null, error: message }));
  return withTransaction(pool, async (tx) => {
    const row = toRow((await tx.query("select * from config_changes where id = $1 for update", [changeId])).rows[0]);
    if (!slotIsOpen(row, opts)) return { changeId, runId: null, outcome: "skipped", status: row.status, exceptionId: null, reevaluated: false, detail: "This slot was already concluded by another run." };
    const run = await tx.query<{ id: string }>(
      "insert into change_monitor_runs (change_id, trigger, slot_at, ran_at, ran_by, outcome, error) values ($1, $2, $3, $4, $5, 'error', $6) returning id",
      [changeId, opts.trigger, opts.slot, opts.now, opts.ranBy, message],
    );
    if (opts.trigger === "scheduled") await tx.query("update config_changes set monitor_retry_at = $2 where id = $1", [changeId, new Date(opts.now.getTime() + RETRY_AFTER_MS)]);
    await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, 'system', 'config_change_monitor_check', $2, $3)", [
      opts.now,
      `config_change:${changeId}`,
      { runId: Number(run.rows[0].id), trigger: opts.trigger, outcome: "error", error: message, by: opts.ranBy },
    ]);
    return { changeId, runId: Number(run.rows[0].id), outcome: "error", status: row.status, exceptionId: null, reevaluated: false, detail: message };
  });
}

export const reviewFingerprint = (changeId: number) => `mapping_drift:change:${changeId}`;

/**
 * The review item for a confirmed drift: one per change. A later drift updates it (evidence, last
 * detected); one a person resolved re-opens, one they acknowledged stays acknowledged, as
 * reconciliation treats its own exceptions. Its summary names no branch but the released one:
 * the full scope is on the check's evidence page, which applies the viewer's branch scope.
 */
async function upsertReviewItem(tx: Queryable, row: ChangeRow, ev: Evaluation, runId: number, now: Date): Promise<number> {
  const e = ev.evidence;
  const what = ev.reasons.includes("MAPPING_MOVED_OUTSIDE_CHANGEGUARD")
    ? "the live mapping moved without a ChangeGuard release"
    : `${e.conflicting.length} lead(s) with this campaign's id arrive outside the evidence the release was approved on`;
  const summary = `Change #${row.id} (${e.campaign.externalId} → ${e.releasedBranchId}): ${what}. The mapping was left as released; a person decides.`;
  const { rows } = await tx.query<{ id: string }>(
    `insert into exceptions as e (kind, severity, fingerprint, branch_id, subject_type, subject_id, summary, evidence,
       amount_cents, customer_ids, status, first_detected_at, last_detected_at)
     values ('mapping_drift', $1, $2, $3, 'config_change', $4, $5, $6, $7, '{}', 'open', $8, $8)
     on conflict (fingerprint) do update set
       severity = excluded.severity, summary = excluded.summary, evidence = excluded.evidence,
       amount_cents = excluded.amount_cents, last_detected_at = excluded.last_detected_at,
       status = case when e.status = 'acknowledged' then 'acknowledged' else 'open' end,
       resolution = case when e.status = 'acknowledged' then e.resolution else null end,
       resolved_at = null
     returning id`,
    [
      ev.severity,
      reviewFingerprint(row.id),
      e.releasedBranchId,
      String(row.id),
      summary,
      {
        // No other branch is named here: this row is shown wherever the released branch is in
        // scope (incident page, AI tools). The affected branches and records are on the run,
        // whose evidence page applies the viewer's scope.
        changeId: row.id,
        runId,
        campaign: e.campaign.externalId,
        releasedBranch: e.releasedBranchId,
        reasons: ev.reasons.join(", "),
        conflictingLeads: e.conflicting.length,
        affectedBranchCount: ev.scope.branches.length,
        mappingVersion: e.mapping.version,
      },
      ev.scope.spendAtStakeCents,
      now,
    ],
  );
  await syncCases(tx, now);
  return Number(rows[0].id);
}

/**
 * The worker's step: every change whose slot (or retry) is due on the business clock, one check
 * each. Called on every worker loop (lib/jobs/tick.ts); cheap when nothing is due.
 */
export async function runDueChecks(pool: Pool, opts: { ranBy: string; now?: Date; limit?: number; hooks?: MonitorHooks }): Promise<CheckResult[]> {
  const now = opts.now ?? (await getNow(pool));
  const due = await pool.query<{ id: string; monitor_due_at: Date; status: ChangeStatus }>(
    `select id, monitor_due_at, status from config_changes
     where kind = 'campaign_mapping' and monitor_due_at is not null and status = any($3::text[])
       and coalesce(monitor_retry_at, monitor_due_at) <= $1
     order by monitor_due_at, id limit $2`,
    [now, opts.limit ?? 25, MONITORED],
  );
  const results: CheckResult[] = [];
  for (const r of due.rows) {
    try {
      results.push(await runCheck(pool, Number(r.id), { trigger: "scheduled", slot: new Date(r.monitor_due_at), now, ranBy: opts.ranBy, hooks: opts.hooks }));
    } catch (error) {
      // runCheck records its own errors; this is one that could not even be recorded (the
      // database refused). The slot stays due, and the other changes are still checked.
      console.error(JSON.stringify({ level: "error", msg: "post-release check could not be recorded", changeId: Number(r.id), error: (error as Error).message }));
      results.push({ changeId: Number(r.id), runId: null, outcome: "error", status: r.status, exceptionId: null, reevaluated: false, detail: (error as Error).message });
    }
  }
  return results;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface MonitorView {
  state: MonitorState;
  /** The release verification, fixed at release. */
  release: { at: string; passed: number; of: number };
  /** The latest run of any outcome (an error included), and the latest that concluded. */
  latest: MonitorRun | null;
  latestConclusion: MonitorRun | null;
  lastVerifiedAt: string | null;
  nextDueAt: string | null;
  retryAt: string | null;
  windowEndsAt: string | null;
  windowEnded: boolean;
  /** When the slot became overdue (its due time plus the grace period), if it is. */
  overdue: boolean;
  runs: number;
  reviewItem: { id: number; status: string; branchId: string | null } | null;
}

export function monitorState(change: Pick<ChangeRow, "status" | "monitorDueAt" | "lastVerifiedAt">, latestConclusion: Pick<MonitorRun, "outcome"> | null, now: Date): MonitorState {
  if (latestConclusion?.outcome === "superseded") return "replaced";
  if (change.status === "recovery_required" || latestConclusion?.outcome === "drift") return "confirmed_drift";
  if (isOverdue(change.monitorDueAt, now)) return "overdue";
  if (latestConclusion?.outcome === "insufficient_evidence" || change.lastVerifiedAt === null) return "insufficient_evidence";
  return "current";
}

/** The monitoring summary for a released campaign mapping, or null for any other change. */
export async function monitorView(db: Queryable, change: ChangeRow, now: Date): Promise<MonitorView | null> {
  if (change.kind !== "campaign_mapping" || !change.releasedAt || !change.verification) return null;
  const latest = await db.query("select * from change_monitor_runs where change_id = $1 order by id desc limit 1", [change.id]);
  const concluded = await db.query("select * from change_monitor_runs where change_id = $1 and outcome <> 'error' order by id desc limit 1", [change.id]);
  const count = await db.query<{ n: number }>("select count(*)::int as n from change_monitor_runs where change_id = $1", [change.id]);
  const item = await db.query<{ id: string; status: string; branch_id: string | null }>("select id, status, branch_id from exceptions where fingerprint = $1", [reviewFingerprint(change.id)]);
  const latestConclusion = concluded.rows[0] ? toRun(concluded.rows[0]) : null;
  const checks = change.verification.checks;
  return {
    state: monitorState(change, latestConclusion, now),
    release: { at: change.releasedAt, passed: checks.filter((c) => c.passed).length, of: checks.length },
    latest: latest.rows[0] ? toRun(latest.rows[0]) : null,
    latestConclusion,
    lastVerifiedAt: change.lastVerifiedAt,
    nextDueAt: change.monitorDueAt,
    retryAt: change.monitorRetryAt,
    windowEndsAt: change.monitorUntil,
    windowEnded: change.monitorDueAt === null && latestConclusion?.outcome !== "superseded" && change.monitorUntil !== null && now.getTime() >= new Date(change.monitorUntil).getTime(),
    overdue: isOverdue(change.monitorDueAt, now),
    runs: count.rows[0].n,
    reviewItem: item.rows[0] ? { id: Number(item.rows[0].id), status: item.rows[0].status, branchId: item.rows[0].branch_id } : null,
  };
}

/** Does `text` name only branches the viewer may see? Free-text details are shown only then. */
export function namesOnlyVisibleBranches(viewer: Pick<Viewer, "branchIds">, text: string): boolean {
  if (!viewer.branchIds) return true;
  return [...text.matchAll(/\bB\d{2}\b/g)].every((m) => viewer.branchIds!.includes(m[0]));
}

export interface RedactedRun {
  run: MonitorRun;
  /** Rows the viewer may not see, counted instead of listed. */
  hidden: { branches: number; leads: number; records: number };
}

/**
 * One run, as this viewer may see it: rows at branches outside their scope are counted, not
 * listed, and a check's sentence that names such a branch is replaced. Read-only.
 */
export function redactRun(run: MonitorRun, viewer: Pick<Viewer, "branchIds">): RedactedRun {
  if (!viewer.branchIds) return { run, hidden: { branches: 0, leads: 0, records: 0 } };
  const ok = (b: string | null | undefined) => b !== null && b !== undefined && viewer.branchIds!.includes(b);
  const e = run.evidence;
  const outside = new Set<string>();
  const keepRows = (rows: Array<{ branchId: string; leads: number }> | undefined) =>
    (rows ?? []).filter((r) => {
      if (!ok(r.branchId)) outside.add(r.branchId);
      return ok(r.branchId);
    });
  const conflicting = (e.conflicting ?? []).filter((c) => ok(c.branchId));
  const hiddenLeads = (e.conflicting ?? []).length - conflicting.length;
  for (const b of run.scope.branches ?? []) if (!ok(b)) outside.add(b);
  const visibleRaw = new Set(conflicting.flatMap((c) => [c.rawEventId, ...(c.previousRawEventId ? [c.previousRawEventId] : [])]));
  return {
    run: {
      ...run,
      checks: run.checks.map((c) => (namesOnlyVisibleBranches(viewer, c.detail) ? c : { ...c, detail: "This finding names a branch outside your scope; a company-wide role can read it in full." })),
      evidence: {
        ...e,
        liveBranchId: ok(e.liveBranchId) || e.liveBranchId === null ? e.liveBranchId : "outside your scope",
        mapping: e.mapping ? { ...e.mapping, branchId: ok(e.mapping.branchId) || e.mapping.branchId === null ? e.mapping.branchId : "outside your scope" } : e.mapping,
        atRelease: e.atRelease ? { ...e.atRelease, leadEvidence: keepRows(e.atRelease.leadEvidence) } : e.atRelease,
        now: e.now ? { ...e.now, leadEvidence: keepRows(e.now.leadEvidence) } : e.now,
        newBranches: (e.newBranches ?? []).filter(ok),
        conflicting: conflicting.map((c) => (ok(c.previousBranchId) || c.previousBranchId === null ? c : { ...c, previousBranchId: "outside your scope" })),
        sharedId: (e.sharedId ?? []).map((s) => (ok(s.branchId) || s.branchId === null ? s : { ...s, branchId: "outside your scope" })),
      },
      scope: { ...run.scope, branches: (run.scope.branches ?? []).filter(ok), rawEventIds: (run.scope.rawEventIds ?? []).filter((id) => visibleRaw.has(id)) },
    },
    hidden: { branches: outside.size, leads: hiddenLeads, records: (run.scope.rawEventIds ?? []).length - [...visibleRaw].length },
  };
}

/** One run of one change, for its evidence page. Scope is the change's: a viewer who cannot read the change cannot read its runs. */
export async function getMonitorRun(db: Queryable, viewer: Viewer, changeId: number, runId: number): Promise<{ change: ChangeRow; redacted: RedactedRun; view: MonitorView | null }> {
  const change = await getChangeTx(db, changeId);
  assertScope(viewer, branchesOf(change), "read this change");
  const { rows } = await db.query("select * from change_monitor_runs where id = $1 and change_id = $2", [runId, changeId]);
  if (rows.length === 0) throw new ActionError(`Check ${runId} of change ${changeId} not found`, 404);
  return { change, redacted: redactRun(toRun(rows[0]), viewer), view: await monitorView(db, change, await getNow(db)) };
}

/** Runs of one change, newest first, for the change page's history. */
export async function listMonitorRuns(db: Queryable, changeId: number, limit = 20): Promise<MonitorRun[]> {
  const { rows } = await db.query("select * from change_monitor_runs where change_id = $1 order by id desc limit $2", [changeId, limit]);
  return rows.map(toRun);
}
