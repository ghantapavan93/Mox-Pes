import type { Pool } from "pg";
import { ActionError } from "@/lib/actions";
import { getNow, withTransaction, type Queryable } from "@/lib/db";
import { dateTime } from "@/lib/format";
import type { ExceptionRow } from "@/lib/queries";
import { lockReconcile } from "@/lib/reconcile/reconcile";
import { ForbiddenError, VIEWERS, canSeeBranch, requirePermission, type Role, type Viewer } from "@/lib/viewer";
import { ensureCaseForException, recordCaseEvent, supersedeLiveProposals, transitionCase } from "@/lib/workflow/cases";
import { OWNER_ROLES } from "@/lib/workflow/proposals";
import { caseForException, caseTimeline, type CaseEvent } from "@/lib/workflow/queries";
import { STATE_LABEL, type CaseState } from "@/lib/workflow/states";
import { factsKey, materialFacts, parseFact, unseenFacts } from "./facts";
import { toRun, type ConflictingLead, type MonitorRun } from "./monitor";
import { getChangeTx, type ReleaseEvidence } from "./service";
import { liveMapping, supportingRecord } from "./summary";

/**
 * The reviewer's decision on a post-release drift case, and what the case page reads.
 *
 * A confirmed drift is ONE review item per change (a mapping_drift exception and its Action Center
 * case, lib/changeguard/monitor.ts). Here a person records what they concluded, against the exact
 * check they read:
 *
 *   reviewed_no_change   closes the case (closed_acknowledged) and acknowledges the exception. The
 *                        check's finding stays as recorded and nothing is re-verified: the change
 *                        stays "confirmed drift" in ChangeGuard, its last successful verification
 *                        does not move.
 *   needs_investigation  keeps the case open (investigating) with an accountable owner role and a
 *                        statement of what needs checking (the assignment convention of
 *                        assignCaseOwner).
 *
 * The review binds to the check's MATERIAL FACTS (./facts.ts), not to its id: a newer check that
 * carries the same facts (a duplicate delivery, a second check, reordered rows, a later time, an
 * edit to a field the check does not judge) does not invalidate it. A newer check that carries a
 * fact the reviewer did not see does: the save is refused (409, the reviewer's draft is theirs to
 * keep) — enforced here, under the lock every check takes, not only in the page.
 *
 * A review writes the review row, the case's state and events, the exception's status and audit
 * rows. Never a mapping, spend, a credit, a source record or a check's result.
 */

export type DriftDisposition = "reviewed_no_change" | "needs_investigation";

export const DISPOSITION_LABEL: Record<DriftDisposition, string> = {
  reviewed_no_change: "Reviewed — no mapping change",
  needs_investigation: "Needs investigation",
};

/** The case states a review applies to: open, and not mid-way through a fix. */
const REVIEWABLE: readonly CaseState[] = ["detected", "investigating"];

export interface DriftReviewInput {
  exceptionId: number;
  /** The check the reviewer read, and the key of its material facts as the page showed them. */
  runId: number;
  evidenceKey: string;
  disposition: DriftDisposition;
  rationale: string;
  /** needs_investigation: the role accountable for the investigation. */
  owner?: Role | null;
  now?: Date;
}

export interface DriftReview {
  id: number;
  caseId: number;
  exceptionId: number;
  disposition: DriftDisposition;
  rationale: string;
  owner: Role | null;
  actorSubject: string;
  actorRole: Role;
  reviewedAt: string;
  runId: number;
  evidenceKey: string;
  facts: string[];
}

const toReview = (r: Record<string, unknown>): DriftReview => ({
  id: Number(r.id),
  caseId: Number(r.case_id),
  exceptionId: Number(r.exception_id),
  disposition: r.disposition as DriftDisposition,
  rationale: r.rationale as string,
  owner: (r.owner as Role | null) ?? null,
  actorSubject: r.actor_subject as string,
  actorRole: r.actor_role as Role,
  reviewedAt: new Date(r.reviewed_at as Date).toISOString(),
  runId: Number(r.run_id),
  evidenceKey: r.evidence_key as string,
  facts: r.facts as string[],
});

/** Newer evidence than the reviewer read: their save is refused, and this says what to read. */
export class StaleEvidenceError extends Error {
  readonly status = 409;
  constructor(
    message: string,
    readonly conflict: { latestRunId: number; reviewedRunId: number; newFacts: number },
  ) {
    super(message);
  }
}

/** The material facts of a check, as recorded. */
export const factsOfRun = (run: Pick<MonitorRun, "evidence">): string[] => materialFacts(run.evidence);

/**
 * Every branch a check's stored result names anywhere: its scope, the evidence at release and now,
 * the contradicting leads and the versions they came from, the live mapping. Whoever decides on the
 * check, or reads a note about it, must be able to see all of them.
 */
export function branchesNamedBy(run: Pick<MonitorRun, "evidence" | "scope">): string[] {
  const e = run.evidence;
  const out = new Set<string>(run.scope.branches ?? []);
  const add = (b: string | null | undefined) => {
    if (b && /^B\d{2}$/.test(b)) out.add(b);
  };
  add(e.releasedBranchId);
  add(e.liveBranchId);
  add(e.mapping?.branchId);
  for (const r of e.atRelease?.leadEvidence ?? []) add(r.branchId);
  for (const r of e.now?.leadEvidence ?? []) add(r.branchId);
  for (const b of e.newBranches ?? []) add(b);
  for (const c of e.conflicting ?? []) {
    add(c.branchId);
    add(c.previousBranchId);
  }
  for (const s of e.sharedId ?? []) add(s.branchId);
  return [...out].sort();
}

const roleLabel = (role: string | null | undefined) => (role && role in VIEWERS ? VIEWERS[role as Role].label.split(" · ")[0] : (role ?? "unknown"));

async function driftRuns(db: Queryable, exceptionId: number): Promise<MonitorRun[]> {
  const { rows } = await db.query("select * from change_monitor_runs where exception_id = $1 and outcome = 'drift' order by id", [exceptionId]);
  return rows.map(toRun);
}

export async function listDriftReviews(db: Queryable, exceptionId: number): Promise<DriftReview[]> {
  const { rows } = await db.query("select * from case_reviews where exception_id = $1 order by id", [exceptionId]);
  return rows.map(toReview);
}

/** Records one review. Throws 400 (input), 403 (role or scope), 404 (not visible), 409 (moved on). */
export async function recordDriftReview(pool: Pool, viewer: Viewer, input: DriftReviewInput): Promise<{ review: DriftReview; state: CaseState; message: string }> {
  requirePermission(viewer, "decide", "record a decision on this case");
  const rationale = input.rationale.trim();
  if (rationale.length < 10) throw new ActionError("Say what you checked in at least 10 characters", 400);
  if (rationale.length > 1000) throw new ActionError("Keep the note under 1,000 characters", 400);
  const owner = input.disposition === "needs_investigation" ? (input.owner ?? null) : null;
  if (input.disposition === "needs_investigation") {
    if (!owner) throw new ActionError("Name the role accountable for the investigation", 400);
    if (!OWNER_ROLES.includes(owner)) throw new ActionError(`${owner} cannot own a case`, 400);
  }

  return withTransaction(pool, async (tx) => {
    // The lock every post-release check and every exception writer takes: no check can record a
    // conclusion between the comparison below and this review's commit.
    await lockReconcile(tx);
    const found = await tx.query<{ id: string; kind: string; branch_id: string | null; status: string }>("select id, kind, branch_id, status from exceptions where id = $1 for update", [input.exceptionId]);
    const exception = found.rows[0];
    if (!exception || exception.kind !== "mapping_drift" || !canSeeBranch(viewer, exception.branch_id)) throw new ActionError("Case not found", 404);
    const now = input.now ?? (await getNow(tx));
    const kase = await ensureCaseForException(tx, input.exceptionId, now);

    const runs = await driftRuns(tx, input.exceptionId);
    const latest = runs.at(-1);
    if (!latest) throw new ActionError("This case has no check to review", 409);
    const reviewed = runs.find((r) => r.id === input.runId);
    if (!reviewed) throw new ActionError(`Check #${input.runId} is not a check of this case`, 400);

    // A reviewer closes only evidence they can read in full: every branch either check names.
    const outside = [...new Set([...branchesNamedBy(latest), ...branchesNamedBy(reviewed)])].filter((b) => !canSeeBranch(viewer, b));
    if (outside.length > 0) throw new ForbiddenError(`${viewer.label} cannot decide this case: part of its evidence is at a branch outside your scope`);

    const seen = factsOfRun(reviewed);
    if (factsKey(seen) !== input.evidenceKey) throw new ActionError(`The evidence on your page does not match check #${reviewed.id}. Reload the case.`, 409);

    const closing = (await listDriftReviews(tx, input.exceptionId)).filter((r) => r.disposition === "reviewed_no_change").at(-1);
    if (kase.state === "closed_acknowledged") {
      throw new ActionError(`Already reviewed${closing ? ` by ${roleLabel(closing.actorRole)} on ${dateTime(closing.reviewedAt)}` : ""}. Reload the case to read that decision.`, 409);
    }
    if (!REVIEWABLE.includes(kase.state)) throw new ActionError(`The case is ${STATE_LABEL[kase.state].toLowerCase()}; a review applies to an open case`, 409);

    const unseen = unseenFacts(factsOfRun(latest), seen);
    if (unseen.length > 0) {
      throw new StaleEvidenceError(
        `New evidence arrived while you were reviewing: check #${latest.id} found ${unseen.length === 1 ? "a contradiction" : `${unseen.length} contradictions`} that check #${reviewed.id} did not show. Nothing was saved; your note is kept. Read the new evidence, then save again.`,
        { latestRunId: latest.id, reviewedRunId: reviewed.id, newFacts: unseen.length },
      );
    }

    const inserted = await tx.query(
      `insert into case_reviews (case_id, exception_id, disposition, rationale, owner, actor_subject, actor_role, reviewed_at, run_id, evidence_key, facts)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) returning *`,
      [kase.id, input.exceptionId, input.disposition, rationale, owner, viewer.subject, viewer.role, now, reviewed.id, input.evidenceKey, JSON.stringify(seen)],
    );
    const review = toReview(inserted.rows[0]);
    // Branch-free on purpose, here and in the audit row below: case events and a case's audit rows
    // are shown wherever the released branch is in scope (the case page, the AI tools'
    // getAuditHistory). The rationale and the facts may name other branches; they are read only
    // from case_reviews, through scope (driftCase).
    const detail = { reviewId: review.id, runId: reviewed.id, disposition: input.disposition, ...(owner ? { owner } : {}) };

    let state: CaseState = kase.state;
    let message: string;
    if (input.disposition === "reviewed_no_change") {
      await supersedeLiveProposals(tx, [kase.id], viewer.role, now, "Reviewed — no mapping change");
      await transitionCase(tx, { caseId: kase.id, from: kase.state, to: "closed_acknowledged", reason: DISPOSITION_LABEL.reviewed_no_change, detail }, viewer.role, now);
      await tx.query("update exceptions set status = 'acknowledged', resolution = $2 where id = $1", [
        input.exceptionId,
        `Reviewed — no mapping change by ${roleLabel(viewer.role)} on ${dateTime(now)} (review #${review.id}, check #${reviewed.id}). The finding stands; the mapping was not re-verified.`,
      ]);
      state = "closed_acknowledged";
      message = "Saved. The case is closed as reviewed; it reopens only if a later check finds a contradiction this review did not see.";
    } else {
      if (kase.owner !== owner) {
        await tx.query("update cases set owner = $2, updated_at = $3 where id = $1", [kase.id, owner, now]);
        await recordCaseEvent(tx, { caseId: kase.id, event: "owner_assigned", auditAction: "case_assign", actor: viewer.role, now, detail: { from: kase.owner, to: owner, reviewId: review.id } });
      }
      if (kase.state === "detected") {
        await transitionCase(tx, { caseId: kase.id, from: "detected", to: "investigating", reason: DISPOSITION_LABEL.needs_investigation, detail }, viewer.role, now);
        state = "investigating";
      } else {
        await recordCaseEvent(tx, { caseId: kase.id, event: "review", auditAction: "drift_review_event", actor: viewer.role, now, detail: { ...detail, reason: DISPOSITION_LABEL.needs_investigation } });
      }
      message = `Saved. The case stays open; ${roleLabel(owner)} owns the investigation.`;
    }
    await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'drift_review', $3, $4)", [
      now,
      viewer.role,
      `case:${kase.id}`,
      { reviewId: review.id, exceptionId: input.exceptionId, disposition: input.disposition, owner, runId: reviewed.id, latestRunId: latest.id, by: viewer.subject },
    ]);
    return { review, state, message };
  });
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface FieldDiff {
  field: string;
  before: string | null;
  after: string | null;
  changed: boolean;
}

export interface StoredVersion {
  rawEventId: number;
  receivedAt: string;
  adapterVersion: string;
  branchId: string | null;
}

/** One lead the check found outside the approved branches, as this viewer may see it. */
export interface ChangedLead {
  fact: string;
  noun: string;
  source: string;
  sourceLeadId: string;
  branchNow: string;
  /** Where the lead was when the change was released; null when it first arrived after the release (or when that is withheld). */
  branchAtRelease: string | null;
  /** The version at release names a branch outside the viewer's scope: it is withheld, not compared. */
  atReleaseWithheld: boolean;
  /** When the source first put the lead where it is now (a later edit to another field does not move it). */
  movedAt: string;
  /** Marked new: since the check the reviewer was reading (a refused save), else since the last "reviewed — no mapping change" while the case is reopened. */
  newSince: "check" | "review" | null;
  isNew: boolean;
  /** Not seen by the last "reviewed — no mapping change" (only while the reopened case waits for a person). */
  sinceReview: boolean;
  /** The lead's own record page, at its row, when the viewer may open it. */
  recordHref: string | null;
  atRelease: StoredVersion | null;
  latest: StoredVersion;
  fields: FieldDiff[];
}

export interface ReviewView extends Omit<DriftReview, "rationale" | "facts" | "evidenceKey"> {
  /** null when the note may name something outside the viewer's scope. */
  rationale: string | null;
  actorLabel: string;
  ownerLabel: string | null;
  /** Lead contradictions this review saw (a count: the facts name branches). */
  leadsReviewed: number;
}

export interface HistoryItem {
  id: number;
  at: string;
  actor: string;
  title: string;
  note: string | null;
  tone: "neutral" | "good" | "warn" | "bad" | "accent";
}

export interface CheckRow {
  id: number;
  ranAt: string;
  trigger: string;
  outcome: string;
  /** Drift checks only: does it carry exactly the facts the case's latest review saw? */
  versusReview: "same" | "new" | null;
}

export interface DriftCaseView {
  caseId: number;
  state: CaseState;
  owner: Role | null;
  reopenCount: number;
  change: {
    id: number;
    campaign: string;
    campaignName: string;
    releasedAt: string;
    releasedBranch: string;
    /** The live mapping, read now: in scope, or null when the viewer may not see where it is. */
    liveBranch: string | null;
    liveVersion: number | null;
    /** The ChangeGuard change that set the live mapping (another one when a newer release replaced this). */
    liveChangeId: number | null;
    /** The live mapping is the one this change released. */
    unchanged: boolean;
  };
  release: { atTarget: number; total: number };
  /** `evidenceKey` only for a viewer who can decide (it hashes facts that may name hidden branches). */
  latest: { runId: number; ranAt: string; atTarget: number; total: number; evidenceKey: string; verdict: string | null } | null;
  leads: ChangedLead[];
  /** Contradicting leads at branches outside the viewer's scope: counted, not named. */
  hiddenLeads: number;
  mappingMoved: boolean;
  /** The decision in force: what closed the case, or what keeps it under investigation. */
  decision: ReviewView | null;
  /** While the case is open again after a "reviewed — no mapping change". */
  reopened: { at: string; runId: number; previous: ReviewView; newLeads: number; hiddenNewLeads: number; otherNewFacts: string[] } | null;
  /** After a refused save: what the latest check carries that the check the reviewer read did not. */
  sinceCheck: { runId: number; newLeads: number; hiddenNewLeads: number; otherNewFacts: string[] } | null;
  reviews: ReviewView[];
  history: HistoryItem[];
  checks: CheckRow[];
  spendAtStakeCents: number;
  canDecide: boolean;
  /** Why this viewer cannot decide (null when they can). */
  readOnlyReason: string | null;
}

const leadNoun = (source: string) => (source === "calls" ? "Call" : source === "web" ? "Web lead" : "Lead");

async function storedVersions(
  db: Queryable,
  lead: ConflictingLead,
  releasedAt: string,
): Promise<{ atRelease: (StoredVersion & { payload: unknown }) | null; latest: StoredVersion & { payload: unknown }; movedAt: string }> {
  const pick = (r: Record<string, unknown>) => ({
    rawEventId: Number(r.id),
    receivedAt: new Date(r.received_at as Date).toISOString(),
    adapterVersion: r.adapter_version as string,
    branchId: (r.branch_id as string | null) ?? null,
    payload: r.payload,
  });
  const latest = await db.query("select id, received_at, adapter_version, payload, payload_branch(payload) as branch_id from raw_events where id = $1", [lead.rawEventId]);
  // The version the release saw: the newest one received at or before the release.
  const before = await db.query(
    `select p.id, p.received_at, p.adapter_version, p.payload, payload_branch(p.payload) as branch_id
     from raw_events cur join raw_events p on p.source = cur.source and p.entity = cur.entity and p.entity_id = cur.entity_id
     where cur.id = $1 and p.received_at <= $2 order by p.received_at desc, p.id desc limit 1`,
    [lead.rawEventId, releasedAt],
  );
  // The first version after the release at the lead's current branch: a later edit of another
  // field (an agent note) or a re-delivery is not when it moved.
  const moved = await db.query<{ at: Date | null }>(
    `select min(p.received_at) as at from raw_events cur join raw_events p on p.source = cur.source and p.entity = cur.entity and p.entity_id = cur.entity_id
     where cur.id = $1 and p.received_at > $2 and payload_branch(p.payload) = $3`,
    [lead.rawEventId, releasedAt, lead.branchId],
  );
  return { atRelease: before.rows[0] ? pick(before.rows[0]) : null, latest: pick(latest.rows[0]), movedAt: new Date(moved.rows[0]?.at ?? lead.deliveredAt).toISOString() };
}

const show = (v: unknown): string | null => (v === undefined || v === null ? null : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Field by field, the changed ones first (aligned before/after; the rest are one click away). */
export function diffFields(before: unknown, after: unknown): FieldDiff[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  const rows = keys.map((field) => {
    const x = show(b[field]);
    const y = show(a[field]);
    return { field, before: x, after: y, changed: x !== y };
  });
  return [...rows.filter((r) => r.changed), ...rows.filter((r) => !r.changed)];
}

function reviewView(r: DriftReview, viewer: Viewer, run: MonitorRun | undefined): ReviewView {
  const branches = [
    ...new Set([
      ...(run ? branchesNamedBy(run) : []),
      ...r.facts.flatMap((f) => {
        const p = parseFact(f);
        return p && (p.kind === "lead" || p.kind === "mapping") ? [p.branchId] : [];
      }),
    ]),
  ];
  // Free text cannot be reliably cleaned: a note about evidence that reaches outside the viewer's
  // scope — any branch the reviewed check names, the versions at release included — is withheld
  // whole (it may name the branch, the office or the lead). No run read means no note shown.
  const visible = run !== undefined && branches.every((b) => b === "unmapped" || canSeeBranch(viewer, b));
  const { rationale, facts, evidenceKey: _key, ...rest } = r;
  void _key;
  return {
    ...rest,
    rationale: visible ? rationale : null,
    actorLabel: roleLabel(r.actorRole),
    ownerLabel: r.owner ? roleLabel(r.owner) : null,
    leadsReviewed: facts.filter((f) => f.startsWith("lead|")).length,
  };
}

function historyOf(events: CaseEvent[], reviews: Map<number, DriftReview>): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const e of events) {
    const d = e.detail ?? {};
    const review = typeof d.reviewId === "number" ? reviews.get(d.reviewId) : undefined;
    const at = new Date(e.at).toISOString();
    const actor = e.actor === "reconcile" || e.actor === "monitor" ? "Post-release check" : roleLabel(e.actor);
    if (e.event === "transition" && e.fromState === null) {
      items.push({ id: e.id, at, actor, title: "Case opened: a check confirmed a drift", note: null, tone: "warn" });
    } else if (e.event === "transition" && e.toState === "closed_acknowledged" && review) {
      items.push({ id: e.id, at, actor, title: "Reviewed — no mapping change", note: `Review #${review.id} of check #${review.runId}. The case closed; the finding stands.`, tone: "good" });
    } else if (e.event === "transition" && e.toState === "detected" && d.trigger === "new_material_evidence") {
      const n = Number(d.newFacts ?? 0);
      items.push({ id: e.id, at, actor, title: "Reopened: new evidence", note: `Check #${String(d.runId)} found ${n === 1 ? "a contradiction" : `${n} contradictions`} review #${String(d.reviewId)} did not see.`, tone: "bad" });
    } else if (e.event === "transition" && e.toState === "investigating" && review) {
      items.push({ id: e.id, at, actor, title: "Needs investigation", note: `Review #${review.id} of check #${review.runId}. Owner: ${roleLabel(review.owner)}.`, tone: "warn" });
    } else if (e.event === "review" && review) {
      items.push({ id: e.id, at, actor, title: "Needs investigation (recorded again)", note: `Review #${review.id} of check #${review.runId}. Owner: ${roleLabel(review.owner)}.`, tone: "warn" });
    } else if (e.event === "owner_assigned") {
      // Shown as part of the review that assigned it.
      if (typeof d.reviewId === "number") continue;
      items.push({ id: e.id, at, actor, title: `Owner: ${d.to ? roleLabel(String(d.to)) : "unassigned"}`, note: null, tone: "neutral" });
    } else if (e.event === "transition") {
      items.push({ id: e.id, at, actor, title: `${e.fromState ? STATE_LABEL[e.fromState] : "New"} → ${STATE_LABEL[e.toState!]}`, note: typeof d.reason === "string" ? d.reason : null, tone: "neutral" });
    } else {
      items.push({ id: e.id, at, actor, title: e.event.replace(/_/g, " "), note: typeof d.reason === "string" ? d.reason : null, tone: "neutral" });
    }
  }
  return items;
}

/**
 * Everything the case page shows for a drift, with the viewer's branch scope applied. Reads only.
 * `sinceRunId`: the check a reviewer was reading when their save was refused; what the latest
 * check adds to it is marked new.
 */
export async function driftCase(db: Queryable, viewer: Viewer, exception: ExceptionRow, opts: { sinceRunId?: number | null } = {}): Promise<DriftCaseView> {
  const kase = await caseForException(db, exception.id);
  if (!kase) throw new ActionError("This case has not been opened yet", 404);
  const change = await getChangeTx(db, Number(exception.evidence.changeId));
  const payload = change.payload as { campaignId: number; branchId: string };
  const target = payload.branchId;
  const releasedAt = change.releasedAt!;

  const runs = (await db.query("select * from change_monitor_runs where change_id = $1 order by id", [change.id])).rows.map(toRun);
  const drift = runs.filter((r) => r.outcome === "drift" && r.exceptionId === exception.id);
  const latestRun = drift.at(-1) ?? null;
  const reviews = await listDriftReviews(db, exception.id);
  const byId = new Map(reviews.map((r) => [r.id, r]));
  const runById = new Map(runs.map((r) => [r.id, r]));
  const lastClosing = reviews.filter((r) => r.disposition === "reviewed_no_change").at(-1) ?? null;
  const lastReview = reviews.at(-1) ?? null;

  const releaseEvidence: ReleaseEvidence | undefined = change.verification?.releaseEvidence;
  const atReleaseRows = releaseEvidence?.leadEvidence ?? (latestRun?.evidence.atRelease?.leadEvidence ?? []);
  const release = { atTarget: atReleaseRows.find((r) => r.branchId === target)?.leads ?? 0, total: atReleaseRows.reduce((t, r) => t + r.leads, 0) };

  const live = await liveMapping(db, payload.campaignId);
  const currentFacts = latestRun ? factsOfRun(latestRun) : [];
  const open = kase.state === "detected" || kase.state === "investigating";
  const reopenedEvent = (await caseTimeline(db, kase.id)).filter((e) => e.event === "transition" && e.toState === "detected" && e.detail?.trigger === "new_material_evidence").at(-1);
  const decidedSinceReopen = kase.state === "investigating" && lastReview?.disposition === "needs_investigation" && reopenedEvent !== undefined && lastReview.id > (lastClosing?.id ?? 0);
  // "New since the last review" only while the reopened case waits for a person: once someone
  // decides again, that decision covers what reopened it.
  const newSinceReview = open && lastClosing && reopenedEvent && !decidedSinceReopen ? new Set(unseenFacts(currentFacts, lastClosing.facts)) : new Set<string>();
  // Only while the case is open: once someone decides, "new since the check you were reading" is moot.
  const sinceRun = open && opts.sinceRunId && latestRun && opts.sinceRunId < latestRun.id ? drift.find((r) => r.id === opts.sinceRunId) : undefined;
  const newSinceCheck = sinceRun ? new Set(unseenFacts(currentFacts, factsOfRun(sinceRun))) : new Set<string>();

  // The contradicting leads: those at a branch the approval never saw (the material facts; a lead
  // at an approved branch contradicts nothing on its own), as this viewer may see them. Counts of
  // the hidden ones come from the stored run: counts are not hidden, branches and records are.
  const outsideApproved = new Set(latestRun?.evidence.newBranches ?? []);
  const material = (latestRun?.evidence.conflicting ?? []).filter((c) => outsideApproved.size === 0 || outsideApproved.has(c.branchId));
  const leads: ChangedLead[] = [];
  for (const c of material.filter((m) => canSeeBranch(viewer, m.branchId))) {
    const versions = await storedVersions(db, c, releasedAt);
    const fact = `lead|${c.source}|${c.sourceLeadId}|${c.branchId}`;
    // The version at release may be at a branch outside the viewer's scope (a split release):
    // then it is withheld, not compared, and its branch is not named.
    const withheld = versions.atRelease !== null && versions.atRelease.branchId !== null && !canSeeBranch(viewer, versions.atRelease.branchId);
    const shownBefore = withheld ? null : versions.atRelease;
    const { payload: before, ...atRelease } = shownBefore ?? { payload: undefined };
    const { payload: after, ...latest } = versions.latest;
    const newSince = newSinceCheck.has(fact) ? "check" : newSinceReview.has(fact) ? "review" : null;
    leads.push({
      fact,
      noun: leadNoun(c.source),
      source: c.source,
      sourceLeadId: c.sourceLeadId,
      branchNow: c.branchId,
      branchAtRelease: shownBefore?.branchId ?? null,
      atReleaseWithheld: withheld,
      movedAt: versions.movedAt,
      newSince,
      isNew: newSince !== null,
      sinceReview: newSinceReview.has(fact),
      recordHref: await supportingRecord(db, viewer, c),
      atRelease: shownBefore ? (atRelease as StoredVersion) : null,
      latest: latest as StoredVersion,
      fields: withheld ? diffFields(after, after) : diffFields(shownBefore ? before : {}, after),
    });
  }
  // New ones first, then the order the check recorded.
  leads.sort((a, b) => Number(b.isNew) - Number(a.isNew));
  const hiddenLeads = material.length - leads.length;
  const newLeadFacts = [...newSinceReview].filter((f) => f.startsWith("lead|"));
  const visibleNew = leads.filter((l) => newSinceReview.has(l.fact)).length;
  const sinceLeadFacts = [...newSinceCheck].filter((f) => f.startsWith("lead|"));
  const visibleSince = leads.filter((l) => newSinceCheck.has(l.fact)).length;

  const reviewViews = reviews.map((r) => reviewView(r, viewer, runById.get(r.runId)));
  const viewOf = (r: DriftReview | null) => (r ? reviewViews.find((v) => v.id === r.id)! : null);
  const decision =
    kase.state === "closed_acknowledged" ? viewOf(lastClosing) : kase.state === "investigating" && lastReview?.disposition === "needs_investigation" ? viewOf(lastReview) : null;

  const outside = (latestRun ? branchesNamedBy(latestRun) : []).filter((b) => !canSeeBranch(viewer, b));
  const readOnlyReason = !viewer.can.decide
    ? `Read-only for your role (${viewer.label}): a marketing analyst or an integration engineer records the decision.`
    : outside.length > 0
      ? "Part of this evidence is at a branch outside your scope, so a company-wide reviewer decides."
      : null;

  const nowRows = latestRun?.evidence.now?.leadEvidence ?? [];
  return {
    caseId: kase.id,
    state: kase.state,
    owner: (kase.owner as Role | null) ?? null,
    reopenCount: kase.reopenCount,
    change: {
      id: change.id,
      campaign: String(exception.evidence.campaign ?? latestRun?.evidence.campaign?.externalId ?? ""),
      campaignName: latestRun?.evidence.campaign?.name ?? "",
      releasedAt,
      releasedBranch: target,
      liveBranch: live.branchId !== null && canSeeBranch(viewer, live.branchId) ? live.branchId : null,
      liveVersion: live.version,
      liveChangeId: live.changeId,
      unchanged: live.branchId === target && live.changeId === change.id,
    },
    release,
    latest: latestRun
      ? {
          runId: latestRun.id,
          ranAt: latestRun.ranAt,
          atTarget: nowRows.find((r) => r.branchId === target)?.leads ?? 0,
          total: nowRows.reduce((t, r) => t + r.leads, 0),
          evidenceKey: readOnlyReason === null ? factsKey(currentFacts) : "",
          verdict: latestRun.evidence.now?.verdict ?? null,
        }
      : null,
    leads,
    hiddenLeads,
    mappingMoved: (latestRun?.evidence.reasons ?? []).includes("MAPPING_MOVED_OUTSIDE_CHANGEGUARD"),
    decision,
    reopened:
      open && lastClosing && reopenedEvent
        ? {
            at: new Date(reopenedEvent.at).toISOString(),
            runId: Number(reopenedEvent.detail.runId),
            previous: viewOf(lastClosing)!,
            newLeads: newLeadFacts.length,
            hiddenNewLeads: newLeadFacts.length - visibleNew,
            otherNewFacts: [...newSinceReview].filter((f) => !f.startsWith("lead|")),
          }
        : null,
    sinceCheck:
      sinceRun && newSinceCheck.size > 0
        ? { runId: sinceRun.id, newLeads: sinceLeadFacts.length, hiddenNewLeads: sinceLeadFacts.length - visibleSince, otherNewFacts: [...newSinceCheck].filter((f) => !f.startsWith("lead|")) }
        : null,
    reviews: [...reviewViews].reverse(),
    history: historyOf(await caseTimeline(db, kase.id), byId),
    checks: runs
      .map((r) => ({
        id: r.id,
        ranAt: r.ranAt,
        trigger: r.trigger,
        outcome: r.outcome,
        versusReview: r.outcome === "drift" && lastReview && r.id > lastReview.runId ? (unseenFacts(factsOfRun(r), lastReview.facts).length > 0 ? ("new" as const) : ("same" as const)) : null,
      }))
      .reverse(),
    spendAtStakeCents: exception.amountCents,
    canDecide: readOnlyReason === null && open,
    readOnlyReason,
  };
}
