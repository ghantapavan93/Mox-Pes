import type { Queryable } from "@/lib/db";
import { toCase, type CaseRow } from "./cases";
import type { ProposalKind } from "./kinds";
import { toExecution, toProposal, type ExecutionRecord, type ProposalRow, type ProposalStatus } from "./proposals";
import { ACTIVE_STATES, CLOSED_STATES, type CaseState } from "./states";

/**
 * Read models for the Action Center and the Audit page. Branch scope is applied in SQL
 * (exceptions.branch_id), as everywhere else: a scoped viewer never receives another
 * branch's rows, and company-wide exceptions (branch null) are visible to all-branch roles only.
 */

export type StateFilter = CaseState | "active" | "closed" | "all";

export interface QueueFilters {
  branchIds: string[] | null;
  state: StateFilter;
  severity?: string;
  kind?: string;
  /** a role, or "unassigned" */
  owner?: string;
  limit?: number;
  /** rows to skip, for paging (the order is total, so pages never overlap) */
  offset?: number;
}

export interface QueueRow {
  caseId: number;
  state: CaseState;
  owner: string | null;
  reopenCount: number;
  updatedAt: Date;
  exceptionId: number;
  kind: string;
  severity: "high" | "medium" | "low";
  branchId: string | null;
  summary: string;
  amountCents: number;
  exceptionStatus: string;
  firstDetectedAt: Date;
  proposal: { id: number; kind: ProposalKind; status: ProposalStatus; source: string; proposedRole: string } | null;
}

function statesFor(filter: StateFilter): readonly string[] | null {
  if (filter === "all") return null;
  if (filter === "active") return ACTIVE_STATES;
  if (filter === "closed") return CLOSED_STATES;
  return [filter];
}

/** Queue filter over cases c joined to exceptions e; $1–$5 are queueParams(f). */
const QUEUE_WHERE = `($1::text[] is null or e.branch_id = any($1::text[]))
       and ($2::text[] is null or c.state = any($2::text[]))
       and ($3::text is null or e.severity = $3)
       and ($4::text is null or e.kind = $4)
       and ($5::text is null or ($5 = 'unassigned' and c.owner is null) or c.owner = $5)`;

function queueParams(f: QueueFilters): unknown[] {
  return [f.branchIds, statesFor(f.state), f.severity ?? null, f.kind ?? null, f.owner ?? null];
}

/** Cases matching the queue filters, ignoring limit and offset: the total behind a paged queue. */
export async function countQueue(db: Queryable, f: QueueFilters): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*) as n from cases c join exceptions e on e.id = c.exception_id where ${QUEUE_WHERE}`,
    queueParams(f),
  );
  return Number(rows[0].n);
}

export async function listQueue(db: Queryable, f: QueueFilters): Promise<QueueRow[]> {
  const { rows } = await db.query(
    `select c.id as case_id, c.state, c.owner, c.reopen_count, c.updated_at,
            e.id as exception_id, e.kind, e.severity, e.branch_id, e.summary, e.amount_cents, e.status as exception_status,
            e.first_detected_at,
            p.id as proposal_id, p.kind as proposal_kind, p.status as proposal_status, p.source as proposal_source,
            p.proposed_role
     from cases c
     join exceptions e on e.id = c.exception_id
     left join lateral (
       select * from action_proposals ap where ap.case_id = c.id order by ap.id desc limit 1) p on true
     where ${QUEUE_WHERE}
     order by ${QUEUE_ORDER}
     limit $6 offset $7`,
    [...queueParams(f), f.limit ?? 200, Math.max(f.offset ?? 0, 0)],
  );
  return rows.map(toQueueRow);
}

/** One row of the queue's select list (listQueue, listQueueGroups). */
function toQueueRow(r: Record<string, unknown>): QueueRow {
  return {
    caseId: Number(r.case_id),
    state: r.state as CaseState,
    owner: (r.owner as string | null) ?? null,
    reopenCount: Number(r.reopen_count),
    updatedAt: r.updated_at as Date,
    exceptionId: Number(r.exception_id),
    kind: r.kind as string,
    severity: r.severity as QueueRow["severity"],
    branchId: (r.branch_id as string | null) ?? null,
    summary: r.summary as string,
    amountCents: Number(r.amount_cents),
    exceptionStatus: r.exception_status as string,
    firstDetectedAt: r.first_detected_at as Date,
    proposal: r.proposal_id
      ? { id: Number(r.proposal_id), kind: r.proposal_kind as ProposalKind, status: r.proposal_status as ProposalStatus, source: r.proposal_source as string, proposedRole: r.proposed_role as string }
      : null,
  };
}

/** The queue's order, most urgent first: needs someone, then severity, then the amount at stake. */
const QUEUE_ORDER = `case c.state when 'awaiting_approval' then 0 when 'failed' then 1 when 'proposed' then 2 when 'verified' then 3
                           when 'investigating' then 4 when 'detected' then 5 else 6 end,
              case e.severity when 'high' then 0 when 'medium' then 1 else 2 end, e.amount_cents desc, c.id`;

/** One incident type in the grouped queue: every matching case counted, its most urgent cases listed. */
export interface QueueGroup {
  kind: string;
  /** Cases of this type that match the filters. */
  cases: number;
  /** Σ of those cases' own amounts: one type's amounts are of one kind (spend or revenue). */
  amountCents: number;
  /** The highest severity among them. */
  severity: "high" | "medium" | "low";
  /** How many branches they are at (company-level cases count as none). */
  branches: number;
  /** The one branch they are all at, when there is exactly one and no company-level case. */
  branchId: string | null;
  /** Whether any of them is company-level (no branch). */
  company: boolean;
  /** Its most urgent cases, in queue order (at most `perGroup`). */
  rows: QueueRow[];
}

/**
 * The queue grouped by incident type (docs/design-system.md, "Incidents"): for the same filters
 * as listQueue, each type's count, amount and highest severity, and its first `perGroup` cases in
 * queue order. Groups come in the order of their most urgent case, so the type that needs someone
 * first is first. Two reads; the case rows are the ones listQueue would return.
 */
export async function listQueueGroups(db: Queryable, f: QueueFilters, perGroup = 5): Promise<QueueGroup[]> {
  const [totals, top] = await Promise.all([
    db.query<{ kind: string; n: string; amount: string; severity: "high" | "medium" | "low"; branches: string; branch: string | null; company: boolean }>(
      `select e.kind, count(*) as n, coalesce(sum(e.amount_cents), 0) as amount,
              (array_agg(e.severity order by case e.severity when 'high' then 0 when 'medium' then 1 else 2 end))[1] as severity,
              count(distinct e.branch_id) as branches, min(e.branch_id) as branch, bool_or(e.branch_id is null) as company
       from cases c join exceptions e on e.id = c.exception_id
       where ${QUEUE_WHERE}
       group by e.kind`,
      queueParams(f),
    ),
    db.query(
      `select * from (
         select c.id as case_id, c.state, c.owner, c.reopen_count, c.updated_at,
                e.id as exception_id, e.kind, e.severity, e.branch_id, e.summary, e.amount_cents, e.status as exception_status,
                e.first_detected_at,
                p.id as proposal_id, p.kind as proposal_kind, p.status as proposal_status, p.source as proposal_source,
                p.proposed_role,
                row_number() over (partition by e.kind order by ${QUEUE_ORDER}) as rank_in_kind,
                row_number() over (order by ${QUEUE_ORDER}) as rank_overall
         from cases c
         join exceptions e on e.id = c.exception_id
         left join lateral (
           select * from action_proposals ap where ap.case_id = c.id order by ap.id desc limit 1) p on true
         where ${QUEUE_WHERE}) ranked
       where rank_in_kind <= $6
       order by rank_overall`,
      [...queueParams(f), perGroup],
    ),
  ]);
  const byKind = new Map(totals.rows.map((r) => [r.kind, r]));
  const groups = new Map<string, QueueGroup>();
  for (const r of top.rows) {
    let g = groups.get(r.kind);
    if (!g) {
      const t = byKind.get(r.kind);
      const branches = Number(t?.branches ?? 0);
      g = {
        kind: r.kind,
        cases: Number(t?.n ?? 0),
        amountCents: Number(t?.amount ?? 0),
        severity: t?.severity ?? r.severity,
        branches,
        branchId: branches === 1 && !t?.company ? (t?.branch ?? null) : null,
        company: Boolean(t?.company),
        rows: [],
      };
      groups.set(r.kind, g);
    }
    g.rows.push(toQueueRow(r));
  }
  return [...groups.values()];
}

/** Cases per state in scope (every state, zero included, so the counts strip is complete). */
export async function caseStateCounts(db: Queryable, branchIds: string[] | null): Promise<Record<CaseState, number>> {
  const { rows } = await db.query<{ state: CaseState; n: string }>(
    `select c.state, count(*) as n from cases c join exceptions e on e.id = c.exception_id
     where ($1::text[] is null or e.branch_id = any($1::text[])) group by c.state`,
    [branchIds],
  );
  const counts = {} as Record<CaseState, number>;
  for (const r of rows) counts[r.state] = Number(r.n);
  return counts;
}

/** Exceptions in scope that have no case yet (raised at ingest, before the next reconcile). */
export async function exceptionsWithoutCase(db: Queryable, branchIds: string[] | null): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*) as n from exceptions e
     where ($1::text[] is null or e.branch_id = any($1::text[])) and not exists (select 1 from cases c where c.exception_id = e.id)`,
    [branchIds],
  );
  return Number(rows[0].n);
}

export async function caseForException(db: Queryable, exceptionId: number): Promise<CaseRow | null> {
  const { rows } = await db.query("select * from cases where exception_id = $1", [exceptionId]);
  return rows[0] ? toCase(rows[0]) : null;
}

export interface CaseEvent {
  id: number;
  at: Date;
  actor: string;
  event: string;
  fromState: CaseState | null;
  toState: CaseState | null;
  proposalId: number | null;
  detail: Record<string, unknown>;
}

export async function caseTimeline(db: Queryable, caseId: number): Promise<CaseEvent[]> {
  const { rows } = await db.query("select * from case_events where case_id = $1 order by id", [caseId]);
  return rows.map((r) => ({
    id: Number(r.id),
    at: r.at,
    actor: r.actor,
    event: r.event,
    fromState: r.from_state ?? null,
    toState: r.to_state ?? null,
    proposalId: r.proposal_id === null ? null : Number(r.proposal_id),
    detail: r.detail,
  }));
}

export interface ApprovalRecord {
  id: number;
  decision: "approved" | "rejected";
  actor: string;
  role: string;
  reason: string;
  preconditionFingerprint: string | null;
  decidedAt: Date;
}

export interface ProposalDetail extends ProposalRow {
  approvals: ApprovalRecord[];
  execution: ExecutionRecord | null;
}

export async function caseProposals(db: Queryable, caseId: number): Promise<ProposalDetail[]> {
  const proposals = await db.query("select * from action_proposals where case_id = $1 order by id desc", [caseId]);
  if (proposals.rows.length === 0) return [];
  const ids = proposals.rows.map((r) => Number(r.id));
  const [approvals, executions] = [
    await db.query("select * from action_approvals where proposal_id = any($1::bigint[]) order by id", [ids]),
    await db.query("select * from action_executions where proposal_id = any($1::bigint[])", [ids]),
  ];
  return proposals.rows.map((r) => {
    const p = toProposal(r);
    return {
      ...p,
      approvals: approvals.rows
        .filter((a) => Number(a.proposal_id) === p.id)
        .map((a) => ({
          id: Number(a.id),
          decision: a.decision,
          actor: a.actor,
          role: a.role,
          reason: a.reason,
          preconditionFingerprint: a.precondition_fingerprint ?? null,
          decidedAt: a.decided_at,
        })),
      execution: executions.rows.filter((e) => Number(e.proposal_id) === p.id).map(toExecution)[0] ?? null,
    };
  });
}

export interface AuditRow {
  id: number;
  at: Date;
  actor: string;
  action: string;
  subject: string;
  detail: Record<string, unknown>;
}

const toAudit = (r: Record<string, unknown>): AuditRow => ({
  id: Number(r.id),
  at: r.at as Date,
  actor: r.actor as string,
  action: r.action as string,
  subject: r.subject as string,
  detail: r.detail as Record<string, unknown>,
});

/**
 * Audit rows for one case: its own events, decisions recorded against its exception, and the
 * rows its successful executions wrote through the existing write paths — a replay (matched by
 * the execution's idempotency key), a campaign mapping or a lead override (matched by subject
 * and the execution's "on behalf of" actor).
 */
export async function caseAudit(db: Queryable, caseId: number, exceptionId: number, limit = 100): Promise<AuditRow[]> {
  const { rows } = await db.query(
    `with x as (
       select x.idempotency_key, x.actor, x.result from action_executions x
       join action_proposals p on p.id = x.proposal_id
       where p.case_id = $1 and x.status = 'succeeded')
     select a.* from audit_log a
     where a.subject = 'case:' || $1::bigint or a.subject = 'exception:' || $2::bigint
        or exists (select 1 from x where a.detail ->> 'idempotencyKey' = x.idempotency_key
                     or (a.actor = x.actor and a.subject in ('campaign:' || (x.result ->> 'campaignId'), 'lead:' || (x.result ->> 'leadId'))))
     order by a.at desc, a.id desc limit $3`,
    [caseId, exceptionId, limit],
  );
  return rows.map(toAudit);
}

export interface AuditFilters {
  actor?: string;
  action?: string;
  /**
   * A full subject ("case:12", "investigation:7") matches exactly; a bare type ("case" or
   * "case:") matches every subject of that type by prefix.
   */
  subject?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  /** Keyset cursor from AuditPage.next: only rows strictly older than it. */
  before?: string;
}

export interface AuditPage {
  rows: AuditRow[];
  /** Cursor for the next (older) page, or null when this page reaches the end. */
  next: string | null;
}

/** "<at, microsecond UTC>|<id>", e.g. "2026-10-31T09:15:02.123456Z|812". */
const AUDIT_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|(\d{1,18})$/;

/** Parses an audit keyset cursor; anything malformed is null (the feed then starts at the newest row). */
export function parseAuditCursor(value: string | undefined): { at: string; id: string } | null {
  const m = value ? AUDIT_CURSOR.exec(value) : null;
  return m ? { at: m[1], id: m[2] } : null;
}

/**
 * The subject filter as SQL: exact when the value names one subject (a ':' followed by an id),
 * otherwise a literal prefix with LIKE metacharacters escaped, so "case:1" never matches case:10.
 */
export function subjectFilter(subject: string | undefined): { exact: string | null; prefix: string | null } {
  if (!subject) return { exact: null, prefix: null };
  if (/:./.test(subject)) return { exact: subject, prefix: null };
  return { exact: null, prefix: `${subject.replace(/[\\%_]/g, (m) => `\\${m}`)}%` };
}

/** One page of the audit log, newest first, paged by (at, id) keyset. */
export async function auditFeedPage(db: Queryable, f: AuditFilters): Promise<AuditPage> {
  const limit = f.limit ?? 100;
  const subject = subjectFilter(f.subject);
  const cursor = parseAuditCursor(f.before);
  const { rows } = await db.query(
    `select *, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at from audit_log
     where ($1::text is null or actor = $1) and ($2::text is null or action = $2)
       and ($3::text is null or subject = $3)
       and ($4::text is null or subject like $4 escape '\\')
       and ($5::timestamptz is null or at >= $5) and ($6::timestamptz is null or at < $6)
       and ($7::timestamptz is null or (at, id) < ($7::timestamptz, $8::bigint))
     order by at desc, id desc limit $9`,
    [f.actor ?? null, f.action ?? null, subject.exact, subject.prefix, f.from ?? null, f.to ?? null, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map(toAudit),
    next: rows.length > limit && last ? `${last.cursor_at as string}|${String(last.id)}` : null,
  };
}

export async function auditFeed(db: Queryable, f: AuditFilters): Promise<AuditRow[]> {
  return (await auditFeedPage(db, f)).rows;
}

/** Distinct actors and actions, for the audit filters (from the data, never a fixed list). */
export async function auditFacets(db: Queryable): Promise<{ actors: string[]; actions: string[]; total: number }> {
  const [actors, actions, total] = [
    await db.query<{ actor: string }>("select distinct actor from audit_log order by actor"),
    await db.query<{ action: string }>("select distinct action from audit_log order by action"),
    await db.query<{ n: string }>("select count(*) as n from audit_log"),
  ];
  return { actors: actors.rows.map((r) => r.actor), actions: actions.rows.map((r) => r.action), total: Number(total.rows[0].n) };
}

export interface Throughput {
  casesByState: Array<{ state: CaseState; n: number }>;
  proposalsByStatus: Array<{ status: ProposalStatus; source: string; n: number }>;
  executions: { succeeded: number; failed: number };
  /** Per business day: cases opened and closed, proposals created and executed. */
  daily: Array<{ day: string; casesOpened: number; casesClosed: number; proposals: number; executions: number }>;
  reopened: number;
}

/** Case and proposal throughput over the last `days` business days (app clock). */
export async function throughput(db: Queryable, now: Date, days = 14): Promise<Throughput> {
  const byState = await db.query<{ state: CaseState; n: string }>("select state, count(*) as n from cases group by state order by n desc");
  const byStatus = await db.query<{ status: ProposalStatus; source: string; n: string }>(
    "select status, source, count(*) as n from action_proposals group by status, source order by status, source",
  );
  const exec = await db.query<{ status: string; n: string }>("select status, count(*) as n from action_executions group by status");
  const reopened = await db.query<{ n: string }>("select coalesce(sum(reopen_count), 0) as n from cases");
  const daily = await db.query<{ day: Date; opened: string; closed: string; proposals: string; executions: string }>(
    `with d as (select generate_series((($1::timestamptz at time zone 'UTC')::date - ($2::int - 1)), ($1::timestamptz at time zone 'UTC')::date, interval '1 day')::date as day)
     select d.day,
       (select count(*) from case_events e where e.event = 'transition' and e.from_state is null and (e.at at time zone 'UTC')::date = d.day) as opened,
       (select count(*) from case_events e where e.event = 'transition' and e.to_state = any($3::text[]) and (e.at at time zone 'UTC')::date = d.day) as closed,
       (select count(*) from action_proposals p where (p.created_at at time zone 'UTC')::date = d.day) as proposals,
       (select count(*) from action_executions x where (x.finished_at at time zone 'UTC')::date = d.day) as executions
     from d order by d.day desc`,
    [now, days, CLOSED_STATES],
  );
  const execCount = (s: string) => Number(exec.rows.find((r) => r.status === s)?.n ?? 0);
  return {
    casesByState: byState.rows.map((r) => ({ state: r.state, n: Number(r.n) })),
    proposalsByStatus: byStatus.rows.map((r) => ({ status: r.status, source: r.source, n: Number(r.n) })),
    executions: { succeeded: execCount("succeeded"), failed: execCount("failed") },
    daily: daily.rows.map((r) => ({
      day: new Date(r.day).toISOString().slice(0, 10),
      casesOpened: Number(r.opened),
      casesClosed: Number(r.closed),
      proposals: Number(r.proposals),
      executions: Number(r.executions),
    })),
    reopened: Number(reopened.rows[0].n),
  };
}

/** Ingestion runs per stream: totals, failures, and failures a later run recovered. */
export async function ingestionHealth(db: Queryable) {
  const { rows } = await db.query<{
    stream: string; source: string; runs: string; succeeded: string; failed: string; running: string;
    fetched: string; quarantined: string; last_failure_at: Date | null; last_error: string | null;
  }>(
    `select stream, source, count(*) as runs,
            count(*) filter (where status = 'succeeded') as succeeded,
            count(*) filter (where status = 'failed') as failed,
            count(*) filter (where status = 'running') as running,
            coalesce(sum(fetched), 0) as fetched, coalesce(sum(quarantined), 0) as quarantined,
            max(started_at) filter (where status = 'failed') as last_failure_at,
            (array_agg(error order by started_at desc) filter (where status = 'failed'))[1] as last_error
     from ingestion_runs group by stream, source order by stream`,
  );
  return rows.map((r) => ({
    stream: r.stream,
    source: r.source,
    runs: Number(r.runs),
    succeeded: Number(r.succeeded),
    failed: Number(r.failed),
    running: Number(r.running),
    fetched: Number(r.fetched),
    quarantined: Number(r.quarantined),
    lastFailureAt: r.last_failure_at,
    lastError: r.last_error,
  }));
}
