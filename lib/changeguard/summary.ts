import type { Queryable } from "@/lib/db";
import { dateTime } from "@/lib/format";
import type { Viewer } from "@/lib/viewer";
import { redactRun, type ConflictingLead, type MonitorState, type MonitorView } from "./monitor";
import type { ChangeRow } from "./service";

/**
 * The decision summary at the top of a released change's page: what was true at release, what
 * the latest check found, what changed in the evidence, what the system did NOT change, and one
 * next action for the viewer's role. Built only from stored results (the release verification,
 * the latest concluded check) plus a fresh read of the live mapping, with the viewer's branch
 * scope applied to every row it names.
 *
 * It never turns evidence into a verdict about the mapping: a revised lead is a contradiction to
 * check, and the summary says so instead of suggesting a remap.
 */

export interface SummaryAction {
  label: string;
  /** Null when the action is a hand-off to another role, not a page to open. */
  href: string | null;
  /** The page's primary button: only for roles that act on the outcome. */
  primary: boolean;
  /** One sentence: what the action is for and who decides what follows. */
  note: string;
}

export interface DecisionSummary {
  release: { verdict: "verified" | "degraded"; at: string; passed: number; of: number; approvedOn: string };
  latest: { state: MonitorState; at: string | null; runId: number | null; overdue: boolean; dueAt: string | null };
  changed: string[];
  unchanged: string[];
  /** Said whenever the evidence moved: what it does and does not show. */
  caution: string | null;
  next: SummaryAction;
}

type Row = { branchId: string; leads: number };

const inScope = (viewer: Pick<Viewer, "branchIds">, branchId: string | null | undefined) => viewer.branchIds === null || (branchId !== null && branchId !== undefined && viewer.branchIds.includes(branchId));

/** "10 at B44", with rows outside the viewer's scope counted, not named. */
function describeRows(rows: Row[], viewer: Pick<Viewer, "branchIds">): string {
  const shown = rows.filter((r) => inScope(viewer, r.branchId));
  const hidden = rows.filter((r) => !inScope(viewer, r.branchId)).reduce((t, r) => t + r.leads, 0);
  const parts = shown.map((r) => `${r.leads} at ${r.branchId}`);
  if (hidden > 0) parts.push(`${hidden} outside your scope`);
  return parts.length ? parts.join(", ") : "no leads";
}

/** The customer or prospect page that holds a lead and every stored version of it, if the viewer may open it. */
export async function supportingRecord(db: Queryable, viewer: Pick<Viewer, "branchIds">, lead: Pick<ConflictingLead, "leadId" | "rawEventId">): Promise<string | null> {
  const { rows } = await db.query<{ id: string; kind: "customer" | "prospect"; crm_customer_id: string | null; branch_id: string | null }>(
    `select i.id, i.kind, i.crm_customer_id, i.branch_id from identity_links k join identities i on i.id = k.identity_id
     where k.record_table = 'leads' and k.record_id = $1`,
    [lead.leadId],
  );
  const identity = rows[0];
  // The journey page reads out of scope as missing; do not offer a link it would refuse.
  if (!identity || !inScope(viewer, identity.branch_id)) return null;
  const ref = identity.kind === "customer" && identity.crm_customer_id !== null ? identity.crm_customer_id : `P-${identity.id}`;
  return `/customers/${ref}#raw-${lead.rawEventId}`;
}

async function liveMapping(db: Queryable, campaignId: number): Promise<{ branchId: string | null; version: number | null; changeId: number | null }> {
  const { rows } = await db.query<{ branch_id: string | null; version: number | null; change_id: string | null }>(
    `select m.branch_id, v.version, v.change_id from ad_campaigns c
     left join campaign_branch_map m on m.campaign_id = c.id
     left join lateral (select version, change_id from campaign_mapping_versions where campaign_id = c.id order by version desc limit 1) v on true
     where c.id = $1`,
    [campaignId],
  );
  const r = rows[0];
  return { branchId: r?.branch_id ?? null, version: r?.version ?? null, changeId: r?.change_id ? Number(r.change_id) : null };
}

const leadNoun = (c: Pick<ConflictingLead, "source">) => (c.source === "calls" ? "Call" : c.source === "web" ? "Web lead" : "Lead");

export async function decisionSummary(db: Queryable, viewer: Viewer, change: ChangeRow, view: MonitorView): Promise<DecisionSummary> {
  const payload = change.payload as { campaignId: number; branchId: string };
  const target = payload.branchId;
  const evidencePage = (runId: number) => `/changes/${change.id}/checks/${runId}`;
  const atRelease = change.verification?.releaseEvidence;
  const verdict = view.release.passed === view.release.of ? "verified" : "degraded";
  const release = {
    verdict: verdict as "verified" | "degraded",
    at: view.release.at,
    passed: view.release.passed,
    of: view.release.of,
    approvedOn: atRelease ? `${describeRows(atRelease.leadEvidence, viewer)} (${atRelease.verdict})` : "the preflight's lead evidence",
  };
  const concluded = view.latestConclusion ? redactRun(view.latestConclusion, viewer) : null;
  const latest = { state: view.state, at: view.latestConclusion?.ranAt ?? null, runId: view.latestConclusion?.id ?? null, overdue: view.overdue, dueAt: view.nextDueAt };
  const canAct = viewer.can.propose || viewer.can.approve;
  const engineer = viewer.can.sync;

  // ── What did not change: the live mapping read now, and what no check ever writes ──
  const live = await liveMapping(db, payload.campaignId);
  const unchanged: string[] = [];
  if (live.branchId === target && live.changeId === change.id) unchanged.push(`The mapping is still ${target} (version ${live.version}), as released.`);
  else if (live.changeId !== null && live.changeId !== change.id) unchanged.push(`The mapping is ${inScope(viewer, live.branchId) ? (live.branchId ?? "unmapped") : "at a branch outside your scope"}, set by change #${live.changeId}; this change released ${target}.`);
  else unchanged.push(`The mapping is ${inScope(viewer, live.branchId) ? (live.branchId ?? "unmapped") : "at a branch outside your scope"}, but this change released ${target} and no ChangeGuard release moved it.`);
  unchanged.push(
    view.reviewItem
      ? `No check edited spend, customers, credits or source records, and nothing was rolled back. The checks recorded their results and one review item${inScope(viewer, view.reviewItem.branchId) ? ` (incident #${view.reviewItem.id})` : ""}.`
      : "No check edited spend, customers, credits or source records, and nothing was rolled back. The checks recorded only their results.",
  );

  // ── What changed in the evidence, and the one next action ──
  const changed: string[] = [];
  let caution: string | null = null;
  let next: SummaryAction;
  // Rows and records come from the redacted run; totals from the stored one (counts are not
  // hidden, only the branches and records behind them).
  const e = concluded?.run.evidence;
  const stored = view.latestConclusion?.evidence;
  const reasons = e?.reasons ?? [];
  const dueText = view.nextDueAt ? dateTime(view.nextDueAt) : "—";

  if (!concluded) {
    changed.push(`No check has run yet; the first is due ${dueText}.`);
  } else if (concluded.run.outcome === "superseded") {
    changed.push(`A newer ChangeGuard release of this campaign replaced this change (change #${e?.mapping?.changeId ?? live.changeId}).`);
  } else if (concluded.run.outcome === "current") {
    const s = e?.sinceRelease;
    changed.push(`Nothing the approval relied on has changed: the campaign's leads still arrive only where the approval saw them (${describeRows(stored?.now?.leadEvidence ?? [], viewer)}).`);
    if (s && s.revisions > 0) changed.push(`${s.revisions} lead(s) were revised since the release without moving them.`);
  } else if (concluded.run.outcome === "insufficient_evidence") {
    if (reasons.includes("CAMPAIGN_ID_AMBIGUOUS")) {
      changed.push(`Another platform's campaign (${(e?.sharedId ?? []).map((s) => s.platform).join(", ")}) now uses this campaign's id, so their leads cannot be told apart. Nothing was decided between them (R-46, open).`);
    }
    for (const f of (e?.feeds ?? []).filter((f) => f.stale)) changed.push(f.stale!);
  } else if (concluded.run.outcome === "drift") {
    if (reasons.includes("MAPPING_MOVED_OUTSIDE_CHANGEGUARD")) {
      changed.push(`The live mapping moved to ${inScope(viewer, e?.liveBranchId) ? (e?.liveBranchId ?? "unmapped") : "a branch outside your scope"} without a ChangeGuard release.`);
    }
    const newBranches = new Set(e?.newBranches ?? []);
    for (const c of (e?.conflicting ?? []).slice(0, 3)) {
      const where = newBranches.has(c.branchId) ? `${c.branchId}, a branch the approval did not see` : c.branchId;
      changed.push(
        c.previousRawEventId
          ? `${leadNoun(c)} ${c.sourceLeadId} was revised at the source: it now arrives at ${where}${c.previousBranchId && c.previousBranchId !== c.branchId ? ` (it was ${c.previousBranchId})` : ""}.`
          : `${leadNoun(c)} ${c.sourceLeadId} arrived at ${where}.`,
      );
    }
    const more = (e?.conflicting ?? []).length - 3;
    if (more > 0) changed.push(`${more} more lead(s) like it, listed on the check's evidence page.`);
    if (concluded.hidden.leads > 0) changed.push(`${concluded.hidden.leads} lead(s) now arrive at a branch outside your scope.`);
    const now = stored?.now;
    if (now && atRelease && now.verdict !== atRelease.verdict) {
      const total = now.leadEvidence.reduce((t, r) => t + r.leads, 0);
      const atTarget = now.leadEvidence.find((r) => r.branchId === target)?.leads ?? 0;
      changed.push(`The campaign's leads now read "${now.verdict}" (${atTarget} of ${total} at ${target}); at release they read "${atRelease.verdict}".`);
    }
    const shown = (e?.conflicting ?? []).length + concluded.hidden.leads;
    if (reasons.includes("EVIDENCE_WITHDRAWN") && shown === 0) {
      caution = "The leads the release relied on were excluded at the source since. Check why before proposing anything.";
    } else if (!reasons.includes("MAPPING_MOVED_OUTSIDE_CHANGEGUARD")) {
      const total = now?.leadEvidence.reduce((t, r) => t + r.leads, 0) ?? 0;
      const atTarget = now?.leadEvidence.find((r) => r.branchId === target)?.leads ?? 0;
      const still = total > 0 && atTarget * 2 > total ? `most of the campaign's leads (${atTarget} of ${total}) still arrive at ${target}` : `the largest share of the campaign's leads still arrives at ${target}`;
      caution =
        now?.verdict === "disagrees"
          ? `Most of the campaign's leads now arrive away from ${target}. Review them before proposing anything: a compensating change is one possible outcome, not the default.`
          : `${shown === 1 ? "One changed lead does" : `${shown} changed leads do`} not show the mapping is wrong: ${still}, and a revision can be a correction at the source. Check the record first.`;
    }
  }

  // One next action for this viewer.
  if (view.state === "replaced") {
    const n = e?.mapping?.changeId ?? live.changeId;
    next = { label: `Open change #${n}`, href: n ? `/changes/${n}` : null, primary: false, note: "This change is no longer monitored; the newer release is." };
  } else if (view.state === "confirmed_drift" && concluded) {
    const visible = e?.conflicting ?? [];
    if (reasons.includes("MAPPING_MOVED_OUTSIDE_CHANGEGUARD")) {
      next = { label: "Review the mapping change", href: evidencePage(concluded.run.id), primary: canAct, note: "The live mapping moved without a release; the audit history below says who moved it." };
    } else if (visible.length === 1) {
      const record = await supportingRecord(db, viewer, visible[0]);
      next = {
        label: canAct ? "Review the changed lead" : "Read the changed lead",
        href: record ?? evidencePage(concluded.run.id),
        primary: canAct,
        note: canAct
          ? "Compare its stored versions. If it is a correction, acknowledge the incident; if more leads follow it, propose a compensating change for a second person to approve."
          : "Read-only for your role: an analyst or approver decides what to do.",
      };
    } else if (visible.length > 1) {
      next = { label: canAct ? `Review the ${visible.length} changed leads` : "Read the changed leads", href: evidencePage(concluded.run.id), primary: canAct, note: "Each one, with its stored versions, is on the check's evidence page." };
    } else {
      next = { label: "Read the evidence", href: evidencePage(concluded.run.id), primary: false, note: "The changed lead is at a branch outside your scope; a company-wide analyst reviews it." };
    }
  } else if (view.state === "overdue") {
    next = engineer
      ? { label: "Check the worker", href: "/audit", primary: true, note: `No check has concluded for the slot due ${dueText}. Nothing certifies the mapping until the worker (npm run worker) runs one.` }
      : { label: "Ask an integration engineer to check the worker", href: null, primary: false, note: `The check due ${dueText} has not run. This is not a drift: nothing was found, nothing was checked.` };
  } else if (view.state === "insufficient_evidence") {
    if (reasons.includes("CAMPAIGN_ID_AMBIGUOUS") && concluded) {
      next = { label: "Read the shared-id evidence", href: evidencePage(concluded.run.id), primary: false, note: "Nothing can be certified until campaign ids carry a platform (R-46, open)." };
    } else if (reasons.includes("FEED_STALE")) {
      next = engineer
        ? { label: "Check the lead feeds", href: "/audit", primary: true, note: "A stale or failing feed hides new evidence; the next check certifies again once it delivers." }
        : { label: "Ask an integration engineer to check the lead feeds", href: null, primary: false, note: "The check could not see recent leads, so it certified nothing." };
    } else {
      next = { label: "Wait for the first scheduled check", href: null, primary: false, note: `Due ${dueText}.` };
    }
  } else {
    next = { label: "No action needed", href: null, primary: false, note: view.nextDueAt ? `Next check ${dueText}.` : "Monitoring has ended for this change." };
  }

  return { release, latest, changed, unchanged, caution, next };
}
