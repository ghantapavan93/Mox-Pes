import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SnapshotDiff } from "@/components/actions/SnapshotDiff";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor } from "@/lib/adapters/registry";
import { ActionError } from "@/lib/actions";
import { withTransaction } from "@/lib/db";
import { quarantineGroupIds, replay } from "@/lib/ingest/replay";
import { resolveIdentities } from "@/lib/identity";
import { budgetSignal } from "@/lib/metrics/decision";
import { ForbiddenError, VIEWERS, type Viewer } from "@/lib/viewer";
import { applyTransitions, syncCases, transitionCase } from "@/lib/workflow/cases";
import { bindWorkflowPorts } from "@/lib/workflow/ports";
import {
  approveProposal,
  assignCaseOwner,
  closeCase,
  createProposal,
  dryRunProposal,
  executeProposal,
  rejectProposal,
} from "@/lib/workflow/proposals";
import { CASE_STATES, TRANSITIONS, assertTransition, canTransition, statesThatReach, type CaseState } from "@/lib/workflow/states";
import { T0, acquisition, call, crm, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * Action Center: case state machine, proposals, dry run, separation of duties, audited
 * idempotent execution with verification — on the two scenario incidents (B20 call-feed
 * drift → replay_quarantine; B09 Local Services → PMax → remap_channel).
 */

const pool: Pool = testPool();
afterAll(async () => pool.end());

/**
 * Route handlers read the viewer from a cookie and the pool from lib/server, which need a
 * Next request. The route tests below swap those for the test pool and a chosen viewer;
 * everything else (zod bodies, permission checks, error mapping) is the real code.
 */
const route = vi.hoisted(() => ({ viewer: null as unknown, pool: null as unknown, now: new Date("2026-10-31T13:00:00Z") }));
vi.mock("@/lib/server", () => ({
  getViewer: async () => route.viewer,
  getPool: () => route.pool,
  businessNow: async () => route.now,
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
route.pool = pool;

const { marketing, engineer, approver, partner, guest } = VIEWERS;
const NOW = new Date("2026-10-31T13:00:00Z");

// ── fixtures ────────────────────────────────────────────────────────────────

const N = 12;

/** A B20 call delivered in the changed shape calls@1.0 cannot read (caller.number). */
function driftedCall(n: number, phone: string, at: Date): RawRecord {
  const a = call(`DRIFT-${n}`, "B20", phone, at);
  const p = a.payload as Record<string, unknown>;
  p.caller = { number: p.customer_phone_number };
  delete p.customer_phone_number;
  return a;
}

/** B20 sells N customers who called in; calls@1.0 quarantined every call. */
async function seedB20(): Promise<number> {
  for (let n = 1; n <= N; n++) {
    const a = acquisition(n, "B20", `+1212555${String(100 + n).padStart(4, "0")}`, new Date(T0.getTime() + n * 3_600_000));
    const p = a.call.payload as Record<string, unknown>;
    p.caller = { number: p.customer_phone_number };
    delete p.customer_phone_number;
    await ingest(pool, "calls", [a.call], { mapper: mapperFor("calls", "1.0") });
    await ingest(pool, "crm", a.crm);
  }
  await runReconcile(pool, NOW);
  return Number((await one<{ id: string }>(pool, "select id from exceptions where kind = 'quarantined_source_records'")).id);
}

const B09 = "B09";
const MIGRATION_DAY = 13;
const OCT = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-31T00:00:00Z") };
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const at = (d: number, hour = 15) => new Date(`${day(d)}T${String(hour).padStart(2, "0")}:00:00Z`);

function spend(campaign: "lsa" | "pmax" | "search", d: number, costDollars: number): RawRecord {
  const base = {
    lsa: { platform: "google_lsa", accountId: `LSA-${B09}`, campaignId: `lsa-${B09}`, campaignName: `${B09} | Local Services`, campaignType: "LOCAL_SERVICES" },
    pmax: { platform: "google_ads", accountId: `LSA-${B09}`, campaignId: `pmax-lsa-${B09}`, campaignName: `${B09} | Local Services (PMax, pay-per-lead)`, campaignType: "PERFORMANCE_MAX", localServicesEnabled: true },
    search: { platform: "google_ads", accountId: "GA-SW", campaignId: `gs-${B09}`, campaignName: `${B09} | Search`, campaignType: "SEARCH" },
  }[campaign];
  const fetchedAt = new Date(new Date(`${day(d)}T00:00:00Z`).getTime() + 30 * 3_600_000);
  return { entity: "spend_day", payload: { ...base, date: day(d), costMicros: String(costDollars * 1_000_000), clicks: 10, conversions: 3, fetchedAt: fetchedAt.toISOString() } };
}

/** The ChangeGuard world: Local Services migrates to PMax on day 13; ads@1.0 files it as Search. */
async function seedB09(): Promise<number> {
  const ads: RawRecord[] = [];
  for (let d = 1; d <= 30; d++) {
    ads.push(spend("search", d, 300));
    ads.push(d < MIGRATION_DAY ? spend("lsa", d, 100) : spend("pmax", d, 100));
  }
  await ingest(pool, "ads", ads, { mapper: mapperFor("ads", "1.0"), now: NOW });
  await pool.query(
    `insert into campaign_branch_map (campaign_id, branch_id, mapped_by, mapped_at)
     select id, $1, 'marketing-ops', $2 from ad_campaigns on conflict do nothing`,
    [B09, NOW],
  );
  const calls: RawRecord[] = [];
  const crmRecords: RawRecord[] = [];
  let n = 0;
  for (let d = 1; d <= 30; d++) {
    calls.push(call(`LSA-ONLY-${d}`, B09, `+1602555${String(1000 + d)}`, at(d, 14), "Google LSA"));
    if (d % 3 === 0 && d <= 25) {
      const a = acquisition(++n, B09, `+1602556${String(1000 + n)}`, at(d), { source: "Google LSA" });
      calls.push(a.call);
      crmRecords.push(...a.crm);
    }
    if (d % 4 === 0 && d <= 25) {
      const a = acquisition(++n, B09, `+1602556${String(1000 + n)}`, at(d), { source: "Google Ads" });
      calls.push(a.call);
      crmRecords.push(...a.crm);
    }
  }
  await ingest(pool, "calls", calls);
  await ingest(pool, "crm", crmRecords);
  await runReconcile(pool, NOW);
  return Number((await one<{ id: string }>(pool, "select id from exceptions where kind = 'channel_coverage_gap'")).id);
}

/** Money and records no fix may create or destroy. */
const ledger = () =>
  one(
    pool,
    `select (select coalesce(sum(cost_cents), 0) from ad_spend_daily) as spend, (select count(*) from crm_customers) as customers,
            (select coalesce(sum(total_cents), 0) from crm_tickets) as invoiced,
            (select coalesce(sum(amount_cents), 0) from crm_payments where status = 'successful') as collected,
            (select count(*) from raw_events) as raw_events`,
  );

/** Every business table a fix could touch — a dry run must leave all of it as it was. */
const businessState = () =>
  one(
    pool,
    `select (select md5(coalesce(string_agg(id || ':' || status || ':' || coalesce(adapter_version, ''), ',' order by id), '')) from raw_events) as raw,
            (select count(*) from leads) as leads,
            (select md5(coalesce(string_agg(id || ':' || status || ':' || coalesce(resolution, ''), ',' order by id), '')) from exceptions) as exceptions,
            (select md5(coalesce(string_agg(campaign_id || ':' || spend_date || ':' || channel_code || ':' || cost_cents, ',' order by campaign_id, spend_date), '')) from ad_spend_daily) as spend,
            (select count(*) from campaign_lineage) as lineage, (select count(*) from replays) as replays,
            (select count(*) from overrides) as overrides, (select count(*) from campaign_branch_map) as mapped,
            (select count(*) from action_executions) as executions,
            (select md5(coalesce(string_agg(id || ':' || state, ',' order by id), '')) from cases) as cases`,
  );

const caseFor = (exceptionId: number) =>
  one<{ id: string; state: CaseState; reopen_count: number; owner: string | null }>(pool, "select * from cases where exception_id = $1", [exceptionId]);

const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(pool, sql, params)).n);

/** propose (marketing) → dry run (engineer) → approve (approver): the happy path up to execution. */
async function approved(exceptionId: number, kind: string, params: Record<string, unknown>, proposer: Viewer = marketing) {
  const p = await createProposal(pool, { exceptionId, kind, params, rationale: "Fix the records behind this incident", source: "human", actor: proposer, now: NOW });
  const dry = await dryRunProposal(pool, { proposalId: p.id, actor: engineer, now: NOW });
  expect(dry.status, dry.dryRun?.error ?? "").toBe("dry_run_ok");
  await approveProposal(pool, { proposalId: p.id, actor: approver, reason: "Dry run verified; ledger conserved", now: NOW });
  return p.id;
}

beforeEach(async () => {
  await freshDb(pool);
  bindWorkflowPorts({ identity: null, connectors: null });
});

// ── state machine ──────────────────────────────────────────────────────────

describe("case state machine", () => {
  it("defines every state and refuses moves outside the table", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...CASE_STATES].sort());
    for (const [from, to] of [
      ["detected", "applied"],
      ["detected", "verified"],
      ["proposed", "applied"],
      ["applied", "resolved"],
      ["applied", "failed"],
      ["resolved", "proposed"],
      ["cancelled", "detected"],
      ["closed_unresolvable", "detected"],
    ] as Array<[CaseState, CaseState]>) {
      expect(canTransition(from, to)).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(ActionError);
      expect(() => assertTransition(from, to)).toThrow(`Illegal case transition ${from} → ${to}`);
    }
    // The happy path is legal end to end.
    const path: CaseState[] = ["detected", "investigating", "proposed", "dry_run_verified", "awaiting_approval", "applied", "verified", "resolved", "detected"];
    for (let i = 1; i < path.length; i++) expect(() => assertTransition(path[i - 1], path[i])).not.toThrow();
    expect(statesThatReach("applied")).toEqual(["awaiting_approval"]);
  });

  it("an illegal transition against the database throws and writes nothing", async () => {
    const exceptionId = await seedB20();
    const kase = await caseFor(exceptionId);
    const events = await count("select count(*) n from case_events");
    const audit = await count("select count(*) n from audit_log");
    await expect(
      withTransaction(pool, (tx) => transitionCase(tx, { caseId: Number(kase.id), from: "detected", to: "applied", reason: "skip ahead" }, "test", NOW)),
    ).rejects.toThrow(/Illegal case transition detected → applied/);
    // A stale "from" (someone else moved the case) is refused too.
    await expect(
      withTransaction(pool, (tx) => applyTransitions(tx, [{ caseId: Number(kase.id), from: "investigating", to: "proposed", reason: "stale view" }], "test", NOW)),
    ).rejects.toThrow(/changed while this request was running/);
    expect((await caseFor(exceptionId)).state).toBe("detected");
    expect(await count("select count(*) n from case_events")).toBe(events);
    expect(await count("select count(*) n from audit_log")).toBe(audit);
  });
});

// ── syncCases ───────────────────────────────────────────────────────────────

describe("syncCases", () => {
  it("creates one case per exception, resolves it with the exception, and re-opens it when the exception returns", async () => {
    const exceptionId = await seedB20();
    expect(await count("select count(*) n from cases")).toBe(await count("select count(*) n from exceptions"));
    const created = await caseFor(exceptionId);
    expect(created).toMatchObject({ state: "detected", reopen_count: 0 });

    // Idempotent: another run creates nothing new.
    const before = await count("select count(*) n from case_events");
    await runReconcile(pool, NOW);
    expect(await count("select count(*) n from case_events")).toBe(before);

    // The legacy direct replay (not the Action Center) fixes it: the case follows the exception.
    const ids = await quarantineGroupIds(pool, { source: "calls", errorCode: "MISSING_FIELD", branchId: "B20" });
    await replay(pool, {
      source: "calls", rawEventIds: ids, mapperVersion: "1.1", actor: "engineer", idempotencyKey: "legacy-replay-1", dryRun: false, now: NOW,
      exceptionId, scope: { ...OCT, branchIds: ["B20"] },
    });
    const resolved = await caseFor(exceptionId);
    expect(resolved.state).toBe("resolved");
    expect((await one(pool, "select closed_at from cases where id = $1", [resolved.id])).closed_at).not.toBeNull();

    // The feed drifts again: the same exception re-opens, and so does its case.
    await ingest(pool, "calls", [driftedCall(99, "+12125559999", new Date(T0.getTime() + 99 * 3_600_000))], { mapper: mapperFor("calls", "1.0") });
    await runReconcile(pool, NOW);
    const reopened = await caseFor(exceptionId);
    expect(reopened).toMatchObject({ state: "detected", reopen_count: 1 });
    expect((await one(pool, "select closed_at from cases where id = $1", [reopened.id])).closed_at).toBeNull();
    const moves = await pool.query("select from_state, to_state from case_events where case_id = $1 and event = 'transition' order by id", [reopened.id]);
    expect(moves.rows).toEqual([
      { from_state: null, to_state: "detected" },
      { from_state: "detected", to_state: "resolved" },
      { from_state: "resolved", to_state: "detected" },
    ]);
  });

  it("a case whose exception clears on its own resolves and its live proposal is superseded", async () => {
    const a = acquisition(1, "B01", "+12125550101", T0);
    const ticket = a.crm.find((r) => r.entity === "ticket")!;
    await ingest(pool, "crm", a.crm.filter((r) => r !== ticket));
    await runReconcile(pool, NOW);
    const exceptionId = Number((await one<{ id: string }>(pool, "select id from exceptions where kind = 'payment_without_ticket'")).id);
    bindWorkflowPorts({ connectors: fakeConnectors() });
    const p = await createProposal(pool, { exceptionId, kind: "trigger_sync", params: { connectorId: 1, officeId: 1, entity: "ticket" }, rationale: "Ask the CRM for the missing invoice", source: "human", actor: engineer, now: NOW });
    await ingest(pool, "crm", [ticket]);
    await runReconcile(pool, NOW);
    expect((await caseFor(exceptionId)).state).toBe("resolved");
    expect((await one(pool, "select status from action_proposals where id = $1", [p.id])).status).toBe("superseded");
  });

  it("owner assignment starts the investigation; a person can close a case with a reason", async () => {
    const exceptionId = await seedB20();
    const kase = await caseFor(exceptionId);
    await expect(assignCaseOwner(pool, { caseId: Number(kase.id), owner: "engineer", actor: guest, now: NOW })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignCaseOwner(pool, { caseId: Number(kase.id), owner: "partner", actor: marketing, now: NOW })).rejects.toThrow(/cannot own a case/);
    const owned = await assignCaseOwner(pool, { caseId: Number(kase.id), owner: "engineer", actor: marketing, now: NOW });
    expect(owned).toMatchObject({ owner: "engineer", state: "investigating" });
    await expect(closeCase(pool, { caseId: Number(kase.id), outcome: "closed_insufficient_evidence", reason: "short", actor: marketing, now: NOW })).rejects.toThrow(/at least 10/);
    await closeCase(pool, { caseId: Number(kase.id), outcome: "closed_insufficient_evidence", reason: "Need the call vendor's change log first", actor: marketing, now: NOW });
    expect((await caseFor(exceptionId)).state).toBe("closed_insufficient_evidence");
    await expect(
      createProposal(pool, { exceptionId, kind: "replay_quarantine", params: { mapperVersion: "1.1" }, rationale: "Replay through calls@1.1", source: "human", actor: marketing, now: NOW }),
    ).rejects.toThrow(/cannot take a new proposal/);
  });
});

// ── proposals ───────────────────────────────────────────────────────────────

describe("proposals", () => {
  it("validate the kind against the exception and the params against the kind", async () => {
    const exceptionId = await seedB20();
    const base = { exceptionId, rationale: "Replay the held calls", source: "human" as const, actor: marketing, now: NOW };
    await expect(createProposal(pool, { ...base, kind: "remap_channel", params: { mapperVersion: "1.1" } })).rejects.toThrow(/does not apply to a quarantined_source_records/);
    await expect(createProposal(pool, { ...base, kind: "replay_quarantine", params: { mapperVersion: "9.9" } })).rejects.toThrow(/No mapper calls@9.9/);
    await expect(createProposal(pool, { ...base, kind: "replay_quarantine", params: { mapperVersion: "1.1", extra: true } })).rejects.toThrow();
    await expect(createProposal(pool, { ...base, kind: "drop_table", params: {} })).rejects.toThrow(/Unknown proposal kind/);
    await expect(createProposal(pool, { ...base, kind: "replay_quarantine", params: { mapperVersion: "1.1" }, actor: approver })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createProposal(pool, { ...base, kind: "replay_quarantine", params: { mapperVersion: "1.1" }, actor: partner })).rejects.toBeInstanceOf(ForbiddenError);
    const p = await createProposal(pool, { ...base, kind: "replay_quarantine", params: { mapperVersion: "1.1" } });
    expect(p).toMatchObject({ status: "draft", proposedRole: "marketing", source: "human" });
    expect((await caseFor(exceptionId)).state).toBe("proposed");

    // A newer proposal supersedes the live one.
    const q = await createProposal(pool, { ...base, kind: "replay_quarantine", params: { mapperVersion: "1.1" }, actor: engineer });
    expect((await one(pool, "select status from action_proposals where id = $1", [p.id])).status).toBe("superseded");
    expect(q.status).toBe("draft");
  });

  it("separation of duties: dry run before approval, never approved by the proposer's role", async () => {
    const exceptionId = await seedB20();
    const p = await createProposal(pool, { exceptionId, kind: "replay_quarantine", params: { mapperVersion: "1.1" }, rationale: "Replay through calls@1.1", source: "human", actor: engineer, now: NOW });
    await expect(approveProposal(pool, { proposalId: p.id, actor: approver, reason: "looks fine", now: NOW })).rejects.toThrow(/successful dry run/);
    await expect(dryRunProposal(pool, { proposalId: p.id, actor: marketing, now: NOW })).rejects.toBeInstanceOf(ForbiddenError);
    await dryRunProposal(pool, { proposalId: p.id, actor: engineer, now: NOW });
    // A role holding both permissions still cannot approve its own role's proposal.
    const engineerWhoCouldApprove: Viewer = { ...engineer, can: { ...engineer.can, approve: true } };
    await expect(approveProposal(pool, { proposalId: p.id, actor: engineerWhoCouldApprove, reason: "my own work", now: NOW })).rejects.toThrow(/Separation of duties/);
    await expect(approveProposal(pool, { proposalId: p.id, actor: marketing, reason: "not mine to approve", now: NOW })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(executeProposal(pool, { proposalId: p.id, actor: approver, now: NOW })).rejects.toThrow(/Only an approved proposal/);
    await approveProposal(pool, { proposalId: p.id, actor: approver, reason: "Dry run verified", now: NOW });
    expect((await one(pool, "select role, decision from action_approvals where proposal_id = $1", [p.id]))).toEqual({ role: "approver", decision: "approved" });
  });

  it("an AI-sourced proposal is stored the same way and skips nothing", async () => {
    const exceptionId = await seedB20();
    const p = await createProposal(pool, { exceptionId, kind: "replay_quarantine", params: { mapperVersion: "1.1" }, rationale: "Investigator: calls@1.1 reads caller.number", source: "ai", actor: engineer, now: NOW });
    expect(p.source).toBe("ai");
    await expect(approveProposal(pool, { proposalId: p.id, actor: approver, reason: "trust the model", now: NOW })).rejects.toThrow(/successful dry run/);
    await expect(executeProposal(pool, { proposalId: p.id, actor: approver, now: NOW })).rejects.toThrow(/Only an approved proposal/);
  });

  it("a rejected proposal sends the case back to investigating", async () => {
    const exceptionId = await seedB20();
    const p = await createProposal(pool, { exceptionId, kind: "replay_quarantine", params: { mapperVersion: "1.1" }, rationale: "Replay through calls@1.1", source: "human", actor: marketing, now: NOW });
    await dryRunProposal(pool, { proposalId: p.id, actor: engineer, now: NOW });
    await rejectProposal(pool, { proposalId: p.id, actor: approver, reason: "Wait for the vendor fix", now: NOW });
    expect((await caseFor(exceptionId)).state).toBe("investigating");
    await expect(executeProposal(pool, { proposalId: p.id, actor: approver, now: NOW })).rejects.toThrow(/rejected/);
  });

  it("branch scope: a partner cannot see or act on another branch's proposal", async () => {
    const exceptionId = await seedB09();
    const p = await createProposal(pool, { exceptionId, kind: "remap_channel", params: { mapperVersion: "1.1" }, rationale: "Re-map the PMax spend", source: "human", actor: marketing, now: NOW });
    const partnerWhoCouldDryRun: Viewer = { ...partner, can: { ...partner.can, dryRun: true } };
    await expect(dryRunProposal(pool, { proposalId: p.id, actor: partnerWhoCouldDryRun, now: NOW })).rejects.toThrow(/Proposal not found/);
  });
});

// ── dry run ─────────────────────────────────────────────────────────────────

describe("dry run", () => {
  it("runs the executor, reports before/after and verification, and mutates nothing", async () => {
    const exceptionId = await seedB20();
    const p = await createProposal(pool, { exceptionId, kind: "replay_quarantine", params: { mapperVersion: "1.1" }, rationale: "Replay through calls@1.1", source: "human", actor: marketing, now: NOW });
    const state = await businessState();
    const dry = await dryRunProposal(pool, { proposalId: p.id, actor: engineer, now: NOW });
    expect(dry.status).toBe("dry_run_ok");
    expect(dry.dryRun!.result).toMatchObject({ claimed: N, projected: N, stillQuarantined: 0 });
    expect(dry.dryRun!.before!.branch!.paidAcquired).toBe(0);
    expect(dry.dryRun!.after!.branch!.paidAcquired).toBe(N);
    expect(dry.dryRun!.after!.exception.status).toBe("resolved");
    expect(dry.dryRun!.verification!.ok).toBe(true);
    expect(dry.preconditionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await businessState()).toEqual({ ...state, cases: (await businessState()).cases });
    expect(await count("select count(*) n from raw_events where status = 'quarantined'")).toBe(N);
    expect(await count("select count(*) n from replays")).toBe(0);
    expect(await count("select count(*) n from audit_log where action = 'replay'")).toBe(0);
    expect((await caseFor(exceptionId)).state).toBe("awaiting_approval");
  });

  it("records a failing dry run without moving the case forward", async () => {
    const exceptionId = await seedB20();
    // calls@1.0 cannot read the drifted calls: the records stay quarantined, so it cannot verify.
    const p = await createProposal(pool, { exceptionId, kind: "replay_quarantine", params: { mapperVersion: "1.0" }, rationale: "Retry with the deployed mapper", source: "human", actor: marketing, now: NOW });
    const dry = await dryRunProposal(pool, { proposalId: p.id, actor: engineer, now: NOW });
    expect(dry.status).toBe("dry_run_failed");
    expect(dry.dryRun!.verification!.problems.join(" ")).toMatch(/expected resolved/);
    expect(dry.preconditionFingerprint).toBeNull();
    expect((await caseFor(exceptionId)).state).toBe("proposed");
  });
});

// ── execution ───────────────────────────────────────────────────────────────

describe("execution", () => {
  afterEach(async () => {
    await pool.query("drop trigger if exists fail_lead_insert on leads");
    await pool.query("drop function if exists fail_lead_insert()");
  });

  it("B20 replay_quarantine end to end: proposal → dry run → approval → execution → verified and resolved", async () => {
    const exceptionId = await seedB20();
    const invariants = await ledger();
    const proposalId = await approved(exceptionId, "replay_quarantine", { mapperVersion: "1.1" });
    const { alreadyProcessed, execution } = await executeProposal(pool, { proposalId, actor: approver, now: NOW });

    expect(alreadyProcessed).toBe(false);
    expect(execution).toMatchObject({ status: "succeeded", actor: "revenue-signal-app on behalf of approver", error: null });
    expect(execution.idempotencyKey).toMatch(new RegExp(`^proposal-${proposalId}-[0-9a-f]{32}$`));
    expect(execution.verification!.ok).toBe(true);
    expect(execution.before!.branch!.unknownAcquired).toBe(N);
    expect(execution.after!.branch).toMatchObject({ paidAcquired: N, unknownAcquired: 0 });
    expect(await ledger()).toEqual(invariants);
    expect(await count("select count(*) n from leads")).toBe(N);
    expect((await one(pool, "select status from exceptions where id = $1", [exceptionId])).status).toBe("resolved");
    expect((await caseFor(exceptionId)).state).toBe("resolved");
    expect((await one(pool, "select status from action_proposals where id = $1", [proposalId])).status).toBe("executed");
    // The replay ran through the existing path, under the execution's idempotency key and actor.
    expect(await one(pool, "select idempotency_key, actor from replays")).toEqual({ idempotency_key: execution.idempotencyKey, actor: execution.actor });

    const moves = await pool.query("select to_state from case_events where event = 'transition' and case_id = (select case_id from action_proposals where id = $1) order by id", [proposalId]);
    expect(moves.rows.map((r) => r.to_state)).toEqual(["detected", "proposed", "dry_run_verified", "awaiting_approval", "applied", "verified", "resolved"]);
  });

  it("is idempotent: executing twice runs once", async () => {
    const exceptionId = await seedB20();
    const proposalId = await approved(exceptionId, "replay_quarantine", { mapperVersion: "1.1" });
    const first = await executeProposal(pool, { proposalId, actor: approver, now: NOW });
    const leads = await count("select count(*) n from leads");
    const second = await executeProposal(pool, { proposalId, actor: approver, now: NOW });
    expect(second.alreadyProcessed).toBe(true);
    expect(second.execution.id).toBe(first.execution.id);
    expect(await count("select count(*) n from leads")).toBe(leads);
    expect(await count("select count(*) n from action_executions")).toBe(1);
    expect(await count("select count(*) n from replays")).toBe(1);
  });

  it("two concurrent executions run once", async () => {
    const exceptionId = await seedB20();
    const proposalId = await approved(exceptionId, "replay_quarantine", { mapperVersion: "1.1" });
    const results = await Promise.all([1, 2, 3].map(() => executeProposal(pool, { proposalId, actor: approver, now: NOW })));
    expect(results.filter((r) => !r.alreadyProcessed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.execution.id)).size).toBe(1);
    expect(await count("select count(*) n from action_executions")).toBe(1);
    expect(await count("select count(*) n from replays")).toBe(1);
    expect(await count("select count(*) n from leads")).toBe(N);
  });

  it("refuses a stale dry run: records changed after approval → nothing runs, a new dry run is required", async () => {
    const exceptionId = await seedB20();
    const proposalId = await approved(exceptionId, "replay_quarantine", { mapperVersion: "1.1" });
    // Another held call arrives between approval and execution.
    await ingest(pool, "calls", [driftedCall(77, "+12125557777", new Date(T0.getTime() + 77 * 3_600_000))], { mapper: mapperFor("calls", "1.0") });
    const state = await businessState();

    await expect(executeProposal(pool, { proposalId, actor: approver, now: NOW })).rejects.toThrow(/changed since the approved dry run/);
    expect(await businessState()).toEqual({ ...state, cases: (await businessState()).cases });
    expect((await one(pool, "select status from action_proposals where id = $1", [proposalId])).status).toBe("stale");
    expect((await caseFor(exceptionId)).state).toBe("proposed");
    expect(await count("select count(*) n from audit_log where action = 'proposal_execute_refused'")).toBe(1);
    await expect(executeProposal(pool, { proposalId, actor: approver, now: NOW })).rejects.toThrow(/stale/);

    // A new dry run and a new approval cover the new record.
    await dryRunProposal(pool, { proposalId, actor: engineer, now: NOW });
    await approveProposal(pool, { proposalId, actor: approver, reason: "Re-verified with the new record", now: NOW });
    const { execution } = await executeProposal(pool, { proposalId, actor: approver, now: NOW });
    expect(execution.result).toMatchObject({ claimed: N + 1, projected: N + 1 });
    expect(await count("select count(*) n from action_approvals where proposal_id = $1", [proposalId])).toBe(2);
  });

  it("a failure mid-execution rolls everything back, marks the case failed, and is not retried by a repeat request", async () => {
    const exceptionId = await seedB20();
    const proposalId = await approved(exceptionId, "replay_quarantine", { mapperVersion: "1.1" });
    const invariants = await ledger();
    const state = await businessState();
    await pool.query(`create function fail_lead_insert() returns trigger language plpgsql as $$
      begin raise exception 'injected failure'; end $$`);
    await pool.query("create trigger fail_lead_insert before insert on leads for each row execute function fail_lead_insert()");

    const { execution } = await executeProposal(pool, { proposalId, actor: approver, now: NOW });
    expect(execution.status).toBe("failed");
    expect(execution.error).toMatch(/injected failure/);
    expect(await ledger()).toEqual(invariants);
    const after = await businessState();
    expect({ ...after, executions: state.executions, cases: state.cases }).toEqual(state);
    expect(await count("select count(*) n from raw_events where status = 'quarantined'")).toBe(N);
    expect(await count("select count(*) n from raw_events where status = 'replaying'")).toBe(0);
    expect(await count("select count(*) n from replays")).toBe(0);
    expect((await one(pool, "select status from exceptions where id = $1", [exceptionId])).status).toBe("open");
    expect((await caseFor(exceptionId)).state).toBe("failed");
    expect((await one(pool, "select status from action_proposals where id = $1", [proposalId])).status).toBe("failed");
    // Nothing from inside the rolled-back execution survived (no "applied" move, no replay audit).
    expect(await count("select count(*) n from case_events where to_state in ('applied', 'verified')")).toBe(0);
    expect(await count("select count(*) n from audit_log where action = 'replay'")).toBe(0);

    await pool.query("drop trigger fail_lead_insert on leads");
    const again = await executeProposal(pool, { proposalId, actor: approver, now: NOW });
    expect(again).toMatchObject({ alreadyProcessed: true, execution: { status: "failed" } });

    // A failed case takes a new proposal, which can then succeed.
    const retry = await approved(exceptionId, "replay_quarantine", { mapperVersion: "1.1" }, engineer);
    const ok = await executeProposal(pool, { proposalId: retry, actor: approver, now: NOW });
    expect(ok.execution.status).toBe("succeeded");
    expect((await caseFor(exceptionId)).state).toBe("resolved");
  });

  it("B09 remap_channel end to end: spend, customers and payments conserved, gap resolved, budget signal trustworthy", async () => {
    const exceptionId = await seedB09();
    const invariants = await ledger();
    const signalBefore = await budgetSignal(pool, B09, OCT);
    expect(signalBefore.trustworthy).toBe(false);
    const lsaBefore = Number((await one(pool, "select coalesce(sum(cost_cents), 0) c from ad_spend_daily where channel_code = 'google_lsa'")).c);

    const proposalId = await approved(exceptionId, "remap_channel", { mapperVersion: "1.1" });
    const dry = await one<{ dry_run: { after: { branch: { budgetSignal: { trustworthy: boolean } } } } }>(pool, "select dry_run from action_proposals where id = $1", [proposalId]);
    expect(dry.dry_run.after.branch.budgetSignal.trustworthy).toBe(true);
    expect((await budgetSignal(pool, B09, OCT)).trustworthy).toBe(false); // the dry run changed nothing

    const { execution } = await executeProposal(pool, { proposalId, actor: approver, now: NOW });
    const misfiled = (30 - MIGRATION_DAY + 1) * 100 * 100;
    expect(execution.status).toBe("succeeded");
    expect(execution.result).toMatchObject({ mode: "reproject", claimed: 30 - MIGRATION_DAY + 1, projected: 30 - MIGRATION_DAY + 1 });
    expect(execution.verification!.conservation.every((c) => c.ok)).toBe(true);
    expect(await ledger()).toEqual(invariants);
    expect(Number((await one(pool, "select coalesce(sum(cost_cents), 0) c from ad_spend_daily where channel_code = 'google_lsa'")).c)).toBe(lsaBefore + misfiled);
    expect((await one(pool, "select status from exceptions where id = $1", [exceptionId])).status).toBe("resolved");
    expect((await budgetSignal(pool, B09, OCT)).trustworthy).toBe(true);
    expect(execution.after!.branch!.budgetSignal.trustworthy).toBe(true);
    expect(await count("select count(*) n from campaign_lineage")).toBe(1);
    expect((await caseFor(exceptionId)).state).toBe("resolved");

    // What the approver sees: the stored snapshots rendered, ledger marked conserved, the moved channels listed.
    const html = renderToStaticMarkup(createElement(SnapshotDiff, { before: execution.before!, after: execution.after, verification: execution.verification }));
    expect(html.match(/>conserved</g)).toHaveLength(5);
    expect(html).toContain("google_lsa spend");
    expect(html).toContain("google_search cost per customer");
    expect(html).not.toContain(">changed<");
  });

  it("deferred effects (a queued sync) verify the action, and reconciliation resolves the case later", async () => {
    const a = acquisition(1, "B01", "+12125550101", T0);
    const ticket = a.crm.find((r) => r.entity === "ticket")!;
    await ingest(pool, "crm", a.crm.filter((r) => r !== ticket));
    await runReconcile(pool, NOW);
    const exceptionId = Number((await one<{ id: string }>(pool, "select id from exceptions where kind = 'payment_without_ticket'")).id);
    const params = { connectorId: 1, officeId: 1, entity: "ticket" };

    // Not connected: the proposal can be made, but its dry run fails and says why.
    const p = await createProposal(pool, { exceptionId, kind: "trigger_sync", params, rationale: "Ask the CRM for the missing invoice", source: "human", actor: engineer, now: NOW });
    const dry = await dryRunProposal(pool, { proposalId: p.id, actor: engineer, now: NOW });
    expect(dry.status).toBe("dry_run_failed");
    expect(dry.dryRun!.error).toMatch(/Connectors module is not connected/);

    bindWorkflowPorts({ connectors: fakeConnectors() });
    const proposalId = await approved(exceptionId, "trigger_sync", params, engineer);
    expect(await count("select count(*) n from audit_log where action = 'fake_enqueue_sync'")).toBe(0); // dry run rolled back
    const { execution } = await executeProposal(pool, { proposalId, actor: approver, now: NOW });
    expect(execution.status).toBe("succeeded");
    expect(execution.result).toMatchObject({ jobId: 1, entity: "ticket" });
    expect(await count("select count(*) n from audit_log where action = 'fake_enqueue_sync'")).toBe(1);
    expect((await caseFor(exceptionId)).state).toBe("verified");

    await ingest(pool, "crm", [ticket]); // the sync delivered it
    await runReconcile(pool, NOW);
    expect((await caseFor(exceptionId)).state).toBe("resolved");
  });

  it("trigger_sync queues one real job through the Connectors module, inside the execution transaction", async () => {
    bindWorkflowPorts({ connectors: undefined }); // the module's own adapter
    const a = acquisition(1, "B01", "+12125550101", T0);
    const ticket = a.crm.find((r) => r.entity === "ticket")!;
    await ingest(pool, "crm", a.crm.filter((r) => r !== ticket));
    await runReconcile(pool, NOW);
    const exceptionId = Number((await one<{ id: string }>(pool, "select id from exceptions where kind = 'payment_without_ticket'")).id);
    const connectorId = Number((await one<{ id: string }>(pool, "select id from connectors order by id limit 1")).id);
    const office = Number((await one<{ crm_office_id: number }>(pool, "select crm_office_id from branches where id = 'B01'")).crm_office_id);

    const proposalId = await approved(exceptionId, "trigger_sync", { connectorId, officeId: office, entity: "ticket" }, engineer);
    expect(await count("select count(*) n from sync_jobs")).toBe(0); // the dry run's job was rolled back
    const { execution } = await executeProposal(pool, { proposalId, actor: approver, now: NOW });
    expect(execution.status, execution.error ?? "").toBe("succeeded");
    const job = await one(pool, "select id, office_id, entity, state, requested_by, request_key from sync_jobs");
    expect(job).toMatchObject({ office_id: office, entity: "ticket", state: "queued", requested_by: "revenue-signal-app on behalf of approver", request_key: execution.idempotencyKey });
    expect(execution.result).toMatchObject({ jobId: Number(job.id), created: true });
    await executeProposal(pool, { proposalId, actor: approver, now: NOW });
    expect(await count("select count(*) n from sync_jobs")).toBe(1);
    expect((await caseFor(exceptionId)).state).toBe("verified");
  });

  it("resolve_identity_conflict decides a real identity conflict through the Identity module", async () => {
    bindWorkflowPorts({ identity: undefined });
    // A lead captured for B06 whose phone belongs to two B07 CRM customers: a branch mismatch
    // for the customer it was credited to, and an ambiguous identity for the resolver.
    const phone = "+12125550188";
    const a = acquisition(1, "B07", phone, T0);
    await ingest(pool, "calls", [call("CAL-SHARED", "B06", phone, new Date(T0.getTime() - 3_600_000))]);
    await ingest(pool, "crm", [...a.crm, crm.customer(1002, "B07", phone, T0)]);
    await runReconcile(pool, NOW);
    await resolveIdentities(pool, NOW);
    const exceptionId = Number((await one<{ id: string }>(pool, "select id from exceptions where kind = 'branch_mismatch'")).id);
    const conflict = await one<{ id: string }>(pool, "select id from identity_conflicts where crm_customer_id = 1002 and status = 'pending'");
    const conflictId = Number(conflict.id);

    const proposalId = await approved(exceptionId, "resolve_identity_conflict", { conflictId, decision: "rejected" }, engineer);
    expect((await one(pool, "select status from identity_conflicts where id = $1", [conflictId])).status).toBe("pending"); // dry run rolled back
    const { execution } = await executeProposal(pool, { proposalId, actor: approver, now: NOW });
    expect(execution.status, execution.error ?? "").toBe("succeeded");
    expect(await one(pool, "select status, decided_by from identity_conflicts where id = $1", [conflictId])).toEqual({
      status: "rejected",
      decided_by: "revenue-signal-app on behalf of approver",
    });
    expect(execution.verification!.conservation.every((c) => c.ok)).toBe(true);
    expect((await caseFor(exceptionId)).state).toBe("verified");
  });

  it("acknowledge_exception closes a payload conflict through the existing decision core", async () => {
    const customer = crm.customer(1001, "B01", "+12125550101", T0);
    await ingest(pool, "crm", [customer]);
    await ingest(pool, "crm", [{ ...customer, payload: { ...(customer.payload as Record<string, unknown>), zip: "99999" } }]);
    await runReconcile(pool, NOW);
    const conflict = await one<{ id: string }>(pool, "select id from exceptions where kind = 'payload_conflict'");
    const exceptionId = Number(conflict.id);
    const proposalId = await approved(exceptionId, "acknowledge_exception", {}, engineer);
    const { execution } = await executeProposal(pool, { proposalId, actor: approver, now: NOW });
    expect(execution.status).toBe("succeeded");
    expect((await one(pool, "select status, resolution from exceptions where id = $1", [exceptionId]))).toMatchObject({
      status: "resolved",
      resolution: expect.stringContaining("revenue-signal-app on behalf of approver"),
    });
    expect((await caseFor(exceptionId)).state).toBe("resolved");
  });
});

// ── routes ──────────────────────────────────────────────────────────────────

describe("API routes", () => {
  const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

  it("enforce permissions, validate bodies and map errors to 400 / 403 / 409", async () => {
    const proposals = await import("@/app/api/proposals/route");
    const proposal = await import("@/app/api/proposals/[id]/route");
    const cases = await import("@/app/api/cases/[id]/route");
    const exceptionId = await seedB20();
    const create = { exceptionId, kind: "replay_quarantine", params: { mapperVersion: "1.1" }, rationale: "Replay the held calls through calls@1.1" };

    route.viewer = guest;
    expect((await proposals.POST(post("/api/proposals", create))).status).toBe(403);
    route.viewer = marketing;
    expect((await proposals.POST(post("/api/proposals", { ...create, kind: "drop_table" }))).status).toBe(400);
    expect((await proposals.POST(post("/api/proposals", { ...create, kind: "remap_channel" }))).status).toBe(400);
    const created = await proposals.POST(post("/api/proposals", create));
    expect(created.status).toBe(201);
    const { proposal: p } = (await created.json()) as { proposal: { id: number; caseId: number } };

    route.viewer = marketing;
    expect((await proposal.POST(post(`/api/proposals/${p.id}`, { action: "dry_run" }), params(p.id))).status).toBe(403);
    route.viewer = engineer;
    const dry = await proposal.POST(post(`/api/proposals/${p.id}`, { action: "dry_run" }), params(p.id));
    expect(dry.status).toBe(200);
    expect(((await dry.json()) as { proposal: { status: string } }).proposal.status).toBe("dry_run_ok");
    expect((await proposal.POST(post(`/api/proposals/${p.id}`, { action: "approve", reason: "looks right" }), params(p.id))).status).toBe(403);
    route.viewer = approver;
    expect((await proposal.POST(post(`/api/proposals/${p.id}`, { action: "approve" }), params(p.id))).status).toBe(400);
    expect((await proposal.POST(post(`/api/proposals/${p.id}`, { action: "execute" }), params(p.id))).status).toBe(409);
    expect((await proposal.POST(post(`/api/proposals/${p.id}`, { action: "approve", reason: "Dry run verified" }), params(p.id))).status).toBe(200);
    const executed = await proposal.POST(post(`/api/proposals/${p.id}`, { action: "execute" }), params(p.id));
    expect(executed.status).toBe(200);
    expect(await executed.json()).toMatchObject({ alreadyProcessed: false, execution: { status: "succeeded" }, message: "Executed and verified." });
    const again = await proposal.POST(post(`/api/proposals/${p.id}`, { action: "execute" }), params(p.id));
    expect(await again.json()).toMatchObject({ alreadyProcessed: true });
    expect((await proposal.POST(post("/api/proposals/abc", { action: "execute" }), params("abc"))).status).toBe(404);

    route.viewer = partner;
    expect((await proposal.POST(post(`/api/proposals/999999`, { action: "execute" }), params(999999))).status).toBe(403);
    route.viewer = guest;
    expect((await cases.POST(post(`/api/cases/${p.caseId}`, { action: "assign", owner: "engineer" }), params(p.caseId))).status).toBe(403);
    route.viewer = marketing;
    expect((await cases.POST(post(`/api/cases/${p.caseId}`, { action: "close", outcome: "resolved", reason: "not a manual close" }), params(p.caseId))).status).toBe(400);
    expect((await cases.POST(post(`/api/cases/${p.caseId}`, { action: "assign", owner: "engineer" }), params(p.caseId))).status).toBe(200);
  });
});

// ── audit ───────────────────────────────────────────────────────────────────

describe("audit completeness", () => {
  it("every case event — transitions included — has exactly one audit row naming it", async () => {
    const exceptionId = await seedB20();
    const proposalId = await approved(exceptionId, "replay_quarantine", { mapperVersion: "1.1" });
    await executeProposal(pool, { proposalId, actor: approver, now: NOW });
    await withTransaction(pool, (tx) => syncCases(tx, NOW));

    const events = await count("select count(*) n from case_events");
    expect(events).toBeGreaterThan(5);
    expect(await count("select count(*) n from case_events ce where (select count(*) from audit_log a where (a.detail ->> 'eventId')::bigint = ce.id and a.subject = 'case:' || ce.case_id) <> 1")).toBe(0);
    expect(await count("select count(*) n from audit_log where detail ? 'eventId'")).toBe(events);
    // Transitions are audited as transitions with their from/to states.
    expect(
      await count(
        `select count(*) n from case_events ce join audit_log a on (a.detail ->> 'eventId')::bigint = ce.id
         where ce.event = 'transition' and (a.action <> 'case_transition' or a.detail ->> 'to' <> ce.to_state)`,
      ),
    ).toBe(0);
  });
});

/** A connectors port that records the enqueue through the pool it is given (the execution's transaction). */
function fakeConnectors() {
  return {
    getConnector: async (_db: unknown, id: number) => (id === 1 ? { id: 1, displayName: "FieldRoutes (synthetic)", officeIds: [1, 2, 3] } : null),
    enqueueSync: async (p: Pool, args: { connectorId: number; officeId: number; entity: string; idempotencyKey: string; actor: string; now: Date }) => {
      await p.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'fake_enqueue_sync', $3, $4)", [
        args.now, args.actor, `connector:${args.connectorId}`, { officeId: args.officeId, entity: args.entity, key: args.idempotencyKey },
      ]);
      return { jobId: 1, created: true };
    },
  };
}

beforeAll(() => {
  bindWorkflowPorts({ identity: null, connectors: null });
});
