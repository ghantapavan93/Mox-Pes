/**
 * Held-out ChangeGuard evaluation runner (docs/agent-work/changeguard-heldout/SCORING.md).
 *
 *   npx tsx scripts/eval-changeguard.ts <scenarios.json> <out.json> [--only HO-07,HO-12]
 *
 * Every scenario gets its own fresh database (EVAL_DATABASE_URL, default revenue_signal_eval).
 * The world is built through the real intake pipeline and actions; every step calls what the
 * HTTP route calls (request schema, then the ChangeGuard service), as the named demo viewer.
 * Nothing here re-implements a ChangeGuard rule: the runner only builds inputs, records what
 * the system did, measures the financial invariants around each step, and scores the result
 * against the scenario author's frozen labels.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Pool } from "pg";
import { z, ZodError } from "zod";
import type { RawRecord } from "@/lib/adapters/contract";
import { ActionError, mapCampaignToBranch, overrideLeadBranch } from "@/lib/actions";
import { NewChangeSchema } from "@/lib/changeguard/model";
import { createChange, decideChange, DecisionSchema, monitorChange, releaseChange, rerunPreflight, type ChangeRow } from "@/lib/changeguard/service";
import { createPool } from "@/lib/db";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { instantToWallTime } from "@/lib/primitives";
import { BRANCH_BY_ID } from "@/lib/reference";
import { ForbiddenError, VIEWERS, type Viewer } from "@/lib/viewer";
import { acquisition, call, crm, freshDb, ingest, runReconcile } from "../tests/helpers";

// ── Scenario format (SCHEMA.md) ──────────────────────────────────────────────

type Klass = "ALLOW" | "BLOCK" | "NEEDS_REVIEW" | "UNSUPPORTED";
type Outcome = "accepted" | "refused";
interface StepExpect { outcome?: Outcome | "either"; class?: Klass; status?: string }
type Step = Record<string, unknown> & { do: string; as?: string; ref?: string; day?: number; label?: string; expect?: StepExpect; steps?: Step[] };
interface Scenario {
  id: string;
  category: string;
  title: string;
  rationale: string;
  severityIfWrong: "critical" | "high" | "medium" | "low";
  world?: {
    campaigns?: Array<{ key: string; platform: string; name: string; spend?: Array<{ fromDay: number; toDay: number; dollarsPerDay: number }>; mappedTo?: string | null }>;
    leads?: LeadSpec[];
    customers?: CustomerSpec[];
    lineage?: Array<{ predecessor: string; successor: string; day?: number }>;
    leadCorrections?: CorrectionSpec[];
  };
  steps: Step[];
  expectFinal?: { mapping?: Record<string, string | null>; statuses?: Record<string, string>; invariants?: string[]; exactlyOneOf?: string[][]; notes?: string };
}
interface LeadSpec { via: "call" | "web"; campaign: string | null; branch: string; count?: number; day?: number; fromDay?: number; toDay?: number }
interface CustomerSpec { key: string; campaign: string | null; branch: string; day: number; amount?: string }
interface CorrectionSpec { campaign: string; fromBranch: string; toBranch: string; count: number }

class InvalidScenario extends Error {}

// ── Time ─────────────────────────────────────────────────────────────────────

const at = (day: number, minute = 0) => new Date(Date.UTC(2026, 9, day, 16, minute, 0));
const dateOf = (day: number) => `2026-10-${String(day).padStart(2, "0")}`;
const HISTORY_NOW = at(24, 30);
const DEFAULT_STEP_DAY = 25;

// ── Actors ───────────────────────────────────────────────────────────────────

const ACTORS: Record<string, Viewer> = {
  ...VIEWERS,
  marketing2: { ...VIEWERS.marketing, subject: "demo:marketing-2", label: "Second marketing analyst · all branches" },
  approver2: { ...VIEWERS.approver, subject: "demo:approver-2", label: "Second revenue ops approver · all branches" },
};
function actor(name: string | undefined): Viewer {
  const v = ACTORS[name ?? ""];
  if (!v) throw new InvalidScenario(`unknown actor "${name}"`);
  return v;
}

// The route's own request schema (app/api/changes/route.ts).
const ProposeBody = z.intersection(NewChangeSchema, z.object({ supersedes: z.number().int().positive().nullable().optional() }));

// ── World construction, through the real intake ──────────────────────────────

interface Ctx {
  pool: Pool;
  scenario: Scenario;
  campaignIds: Map<string, number>;
  externalIds: Map<string, string>;
  platforms: Map<string, string>;
  customers: Map<string, { customerId: number; ticketId: number; paymentId: number; branch: string; phone: string; soldAt: Date; amount: string }>;
  changes: Map<string, number>;
  counter: number;
}

const ext = (ctx: Ctx, key: string) => ctx.externalIds.get(key) ?? `${ctx.scenario.id}-${key}`;
function campaignId(ctx: Ctx, key: string): number {
  if (key === "unknown") return 999_999;
  const id = ctx.campaignIds.get(key);
  if (id === undefined) throw new InvalidScenario(`campaign key "${key}" is not defined in world.campaigns`);
  return id;
}
function changeId(ctx: Ctx, ref: string | undefined): number {
  const id = ctx.changes.get(ref ?? "");
  if (id === undefined) throw new InvalidScenario(`change ref "${ref}" was never created`);
  return id;
}

const CALL_SOURCE: Record<string, string> = { google_ads: "Google Ads", google_lsa: "Google LSA", meta: "Facebook", microsoft_ads: "Bing" };
const UTM_SOURCE: Record<string, string> = { google_ads: "google", google_lsa: "google", meta: "facebook", microsoft_ads: "bing" };

function nextPhone(ctx: Ctx): string {
  ctx.counter += 1;
  return `+1480${5_550_000 + ctx.counter}`;
}

function spendRecord(ctx: Ctx, key: string, day: number, dollars: number, fetchedAt: Date): RawRecord {
  const platform = ctx.platforms.get(key)!;
  const campaign = ctx.scenario.world!.campaigns!.find((c) => c.key === key)!;
  return {
    entity: "spend_day",
    payload: {
      platform,
      accountId: `ACC-${ctx.scenario.id}`,
      campaignId: ext(ctx, key),
      campaignName: campaign.name,
      date: dateOf(day),
      costMicros: String(Math.round(dollars * 100) * 10_000),
      clicks: 10,
      conversions: 1,
      fetchedAt: fetchedAt.toISOString(),
      ...(platform === "google_ads" ? { campaignType: "SEARCH" } : platform === "google_lsa" ? { campaignType: "LOCAL_SERVICES" } : {}),
    },
  };
}

async function addSpend(ctx: Ctx, key: string, fromDay: number, toDay: number, dollarsPerDay: number, now: Date) {
  if (!ctx.platforms.has(key)) throw new InvalidScenario(`campaign key "${key}" is not defined in world.campaigns`);
  const records: RawRecord[] = [];
  // Each day is fetched the next morning (06:00 UTC), as the platforms' daily reports are.
  for (let d = fromDay; d <= toDay; d++) records.push(spendRecord(ctx, key, d, dollarsPerDay, new Date(at(d + 1).getTime() - 10 * 3_600_000)));
  await ingest(ctx.pool, "ads", records, { now });
}

function spreadDays(spec: { count?: number; day?: number; fromDay?: number; toDay?: number }): number[] {
  const count = spec.count ?? 1;
  const from = spec.fromDay ?? spec.day;
  const to = spec.toDay ?? spec.day ?? from;
  if (from === undefined || to === undefined) throw new InvalidScenario("a lead needs day or fromDay/toDay");
  const span = to - from + 1;
  return Array.from({ length: count }, (_, i) => from + Math.floor((i * span) / count));
}

async function addLeads(ctx: Ctx, spec: LeadSpec, now: Date) {
  if (!BRANCH_BY_ID.has(spec.branch)) throw new InvalidScenario(`lead branch "${spec.branch}" does not exist`);
  const platform = spec.campaign ? ctx.platforms.get(spec.campaign) : undefined;
  const campaignExt = spec.campaign ? ext(ctx, spec.campaign) : null;
  const days = spreadDays(spec);
  const records: RawRecord[] = days.map((d, i) => {
    ctx.counter += 1;
    const time = new Date(at(d).getTime() + i * 60_000);
    if (spec.via === "web") {
      return {
        entity: "lead",
        payload: {
          messageId: `${ctx.scenario.id}-web-${ctx.counter}`,
          timestamp: time.toISOString(),
          properties: { form: "quote", branch_id: spec.branch, zip: "85001", phone: nextPhone(ctx), email: null, utm_source: UTM_SOURCE[platform ?? "google_ads"] ?? "google", utm_medium: "cpc", utm_campaign: campaignExt, gclid: null, message: null },
        },
      };
    }
    return call(`${ctx.scenario.id}-call-${ctx.counter}`, spec.branch, nextPhone(ctx), time, CALL_SOURCE[platform ?? "google_ads"] ?? "Google Ads", { campaign: campaignExt });
  });
  if (spec.via !== "call" && spec.via !== "web") throw new InvalidScenario(`lead via "${spec.via}"`);
  await ingest(ctx.pool, spec.via === "web" ? "web" : "calls", records, { now });
}

async function addCustomer(ctx: Ctx, spec: CustomerSpec, now: Date) {
  if (!BRANCH_BY_ID.has(spec.branch)) throw new InvalidScenario(`customer branch "${spec.branch}" does not exist`);
  ctx.counter += 1;
  const n = ctx.counter;
  const phone = nextPhone(ctx);
  const platform = spec.campaign ? ctx.platforms.get(spec.campaign) : undefined;
  const soldAt = at(spec.day);
  const won = acquisition(n, spec.branch, phone, soldAt, { source: CALL_SOURCE[platform ?? "google_ads"] ?? "Google Ads", amount: spec.amount });
  (won.call.payload as Record<string, unknown>).campaign = spec.campaign ? ext(ctx, spec.campaign) : null;
  await ingest(ctx.pool, "calls", [won.call], { now });
  await ingest(ctx.pool, "crm", won.crm, { now });
  ctx.customers.set(spec.key, { customerId: won.customerId, ticketId: won.ticketId, paymentId: 5000 + n, branch: spec.branch, phone, soldAt, amount: spec.amount ?? "149.00" });
}

async function correctLeads(ctx: Ctx, spec: CorrectionSpec, now: Date) {
  const { rows } = await ctx.pool.query<{ id: string }>(
    "select id from leads where campaign_external_id = $1 and branch_id = $2 order by id limit $3",
    [ext(ctx, spec.campaign), spec.fromBranch, spec.count],
  );
  for (const r of rows) await overrideLeadBranch(ctx.pool, { leadId: Number(r.id), branchId: spec.toBranch, actor: "ops", reason: "lead arrived at the wrong branch (scenario correction)", now });
}

async function buildWorld(ctx: Ctx) {
  const w = ctx.scenario.world ?? {};
  for (const c of w.campaigns ?? []) {
    ctx.platforms.set(c.key, c.platform);
    ctx.externalIds.set(c.key, `${ctx.scenario.id}-${c.key}`);
  }
  // A campaign exists in the warehouse once the ad platform has delivered a day for it.
  for (const c of w.campaigns ?? []) {
    const spend = c.spend?.length ? c.spend : [];
    for (const s of spend) await addSpend(ctx, c.key, s.fromDay, s.toDay, s.dollarsPerDay, HISTORY_NOW);
    if (spend.length === 0) await ingest(ctx.pool, "ads", [spendRecord(ctx, c.key, 1, 0, at(2))], { now: HISTORY_NOW });
    const { rows } = await ctx.pool.query<{ id: string }>("select id from ad_campaigns where external_campaign_id = $1", [ext(ctx, c.key)]);
    if (rows.length === 0) throw new Error(`campaign ${c.key} was not created by intake`);
    ctx.campaignIds.set(c.key, Number(rows[0].id));
  }
  for (const c of w.campaigns ?? []) {
    if (c.mappedTo) await mapCampaignToBranch(ctx.pool, { campaignId: campaignId(ctx, c.key), branchId: c.mappedTo, actor: "setup", reason: "mapping as it exists before the scenario", now: at(1) });
  }
  for (const l of w.leads ?? []) await addLeads(ctx, l, HISTORY_NOW);
  for (const k of w.customers ?? []) await addCustomer(ctx, k, HISTORY_NOW);
  for (const l of w.lineage ?? []) {
    await ctx.pool.query(
      "insert into campaign_lineage (predecessor_campaign_id, successor_campaign_id, effective_date, evidence, recorded_by, recorded_at) values ($1, $2, $3, $4, 'scenario', $5)",
      [campaignId(ctx, l.predecessor), campaignId(ctx, l.successor), dateOf(l.day ?? 12), { note: "recorded by the scenario" }, HISTORY_NOW],
    );
  }
  for (const c of w.leadCorrections ?? []) await correctLeads(ctx, c, HISTORY_NOW);
  await runReconcile(ctx.pool, HISTORY_NOW);
}

// ── Measurement ──────────────────────────────────────────────────────────────

interface Snapshot {
  spendCents: number;
  maps: string;
  mapByCampaign: Map<number, string>;
  rows: Map<string, string>;
  paidSpend: Map<string, number>;
  raw: number;
  collectedCents: number;
  acquired: number;
}

async function snap(pool: Pool): Promise<Snapshot> {
  const spend = await pool.query<{ c: string | null }>("select sum(cost_cents) as c from ad_spend_daily");
  const maps = await pool.query<{ campaign_id: string; branch_id: string }>("select campaign_id, branch_id from campaign_branch_map order by campaign_id");
  const raw = await pool.query<{ n: string }>("select count(*) as n from raw_events");
  const rows = await branchRows(pool, { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: null });
  return {
    spendCents: Number(spend.rows[0].c ?? 0),
    maps: JSON.stringify(maps.rows),
    mapByCampaign: new Map(maps.rows.map((m) => [Number(m.campaign_id), m.branch_id])),
    rows: new Map(rows.map((r) => [r.branchId, JSON.stringify(r)])),
    paidSpend: new Map(rows.map((r) => [r.branchId, r.paidSpendCents])),
    raw: Number(raw.rows[0].n),
    collectedCents: rows.reduce((t, r) => t + r.collectedCents, 0),
    acquired: rows.reduce((t, r) => t + r.acquired, 0),
  };
}

const changedBranches = (a: Snapshot, b: Snapshot) => [...a.rows.keys()].filter((k) => a.rows.get(k) !== b.rows.get(k));

// ── Steps ────────────────────────────────────────────────────────────────────

const WORLD_STEPS = new Set(["add_leads", "add_customers", "add_spend", "restate_spend", "correct_leads", "refund", "crm_move_customer", "remap_outside", "reconcile"]);
const PREVIEW_STEPS = new Set(["propose", "propose_kind", "resubmit", "propose_source_contract", "rerun_preflight"]);

interface StepResult {
  index: string;
  do: string;
  as?: string;
  ref?: string;
  label?: string;
  outcome: Outcome | "world";
  unhandled?: boolean;
  error?: string;
  actualClass?: Klass;
  status?: string;
  verdict?: string;
  evidence?: Array<{ id: string; status: string; code?: string; detail: string }>;
  verification?: unknown;
  invariantFailures: string[];
  expect?: StepExpect;
}

function classify(change: ChangeRow): Klass {
  const verdict = change.preflight?.verdict;
  return verdict === "fail" ? "BLOCK" : verdict === "warn" ? "NEEDS_REVIEW" : "ALLOW";
}

const reasonOf = (s: Step, fallback: string) => (typeof s.reason === "string" && s.reason.trim().length >= 10 ? s.reason : fallback);

async function hashesOf(pool: Pool, id: number) {
  const { rows } = await pool.query<{ config_hash: string; preflight_hash: string | null }>("select config_hash, preflight_hash from config_changes where id = $1", [id]);
  return { configHash: rows[0].config_hash, preflightHash: rows[0].preflight_hash ?? "0".repeat(64) };
}

/** Performs one step through the real service. Returns the change touched, if any. */
async function perform(ctx: Ctx, s: Step, now: Date): Promise<ChangeRow | null> {
  const viewer = () => actor(s.as);
  const str = (k: string) => {
    const v = s[k];
    if (typeof v !== "string") throw new InvalidScenario(`step ${s.do} needs "${k}"`);
    return v;
  };
  switch (s.do) {
    case "propose":
    case "resubmit": {
      const extra = (s.payloadExtra ?? {}) as Record<string, unknown>;
      const body: Record<string, unknown> = {
        kind: "campaign_mapping",
        payload: { campaignId: campaignId(ctx, str("campaign")), branchId: str("branch"), ...extra },
        reason: reasonOf(s, `Scenario ${ctx.scenario.id}: map ${str("campaign")} to ${str("branch")}`),
      };
      if (s.do === "resubmit") body.supersedes = changeId(ctx, str("supersedes"));
      const v = viewer();
      const input = ProposeBody.parse(body);
      const change = await createChange(ctx.pool, v, input, now);
      if (s.ref) ctx.changes.set(s.ref, change.id);
      return change;
    }
    case "propose_kind": {
      const v = viewer();
      const input = ProposeBody.parse({ kind: s.kind, payload: s.payload, reason: reasonOf(s, `Scenario ${ctx.scenario.id}: a ${String(s.kind)} change`) });
      const change = await createChange(ctx.pool, v, input, now);
      if (s.ref) ctx.changes.set(s.ref, change.id);
      return change;
    }
    case "propose_source_contract": {
      const v = viewer();
      const input = ProposeBody.parse({ kind: "source_contract", payload: { source: s.source, entity: s.entity, samples: s.samples }, reason: reasonOf(s, `Scenario ${ctx.scenario.id}: a changed ${String(s.source)} shape`) });
      const change = await createChange(ctx.pool, v, input, now);
      if (s.ref) ctx.changes.set(s.ref, change.id);
      return change;
    }
    case "rerun_preflight":
      return rerunPreflight(ctx.pool, viewer(), changeId(ctx, s.ref), now);
    case "approve":
    case "reject": {
      const id = changeId(ctx, s.ref);
      const v = viewer();
      const hashes = await hashesOf(ctx.pool, typeof s.hashesFrom === "string" ? changeId(ctx, s.hashesFrom) : id);
      const input = DecisionSchema.parse({ decision: s.do, reason: reasonOf(s, `Scenario ${ctx.scenario.id}: reviewed and decided`), ...hashes });
      return decideChange(ctx.pool, v, id, input, now);
    }
    case "release":
      return releaseChange(ctx.pool, viewer(), changeId(ctx, s.ref), now);
    case "monitor":
      return monitorChange(ctx.pool, viewer(), changeId(ctx, s.ref), now);
    // ── world changes ──
    case "add_leads":
      await addLeads(ctx, s as unknown as LeadSpec, now);
      return null;
    case "add_customers":
      await addCustomer(ctx, s as unknown as CustomerSpec, now);
      return null;
    case "add_spend":
      await addSpend(ctx, str("campaign"), Number(s.fromDay), Number(s.toDay), Number(s.dollarsPerDay), now);
      return null;
    case "restate_spend": {
      const key = str("campaign");
      if (!ctx.platforms.has(key)) throw new InvalidScenario(`campaign key "${key}" is not defined`);
      await ingest(ctx.pool, "ads", [spendRecord(ctx, key, Number(s.day), Number(s.dollars), now)], { now });
      return null;
    }
    case "correct_leads":
      await correctLeads(ctx, s as unknown as CorrectionSpec, now);
      return null;
    case "refund": {
      const k = ctx.customers.get(str("customer"));
      if (!k) throw new InvalidScenario(`customer "${String(s.customer)}" is not defined`);
      ctx.counter += 1;
      const when = s.day ? at(Number(s.day)) : now;
      await ingest(ctx.pool, "crm", [crm.payment(9000 + ctx.counter, k.customerId, k.ticketId, k.branch, `-${String(s.amount)}`, when, "1", String(k.paymentId))], { now });
      return null;
    }
    case "crm_move_customer": {
      const k = ctx.customers.get(str("customer"));
      if (!k) throw new InvalidScenario(`customer "${String(s.customer)}" is not defined`);
      const to = str("toBranch");
      if (!BRANCH_BY_ID.has(to)) throw new InvalidScenario(`branch "${to}" does not exist`);
      const when = s.day ? at(Number(s.day)) : now;
      const tz = BRANCH_BY_ID.get(to)!.timezone;
      await ingest(ctx.pool, "crm", [crm.customer(k.customerId, to, k.phone, when, { dateAdded: instantToWallTime(k.soldAt, tz) })], { now });
      return null;
    }
    case "remap_outside":
      await mapCampaignToBranch(ctx.pool, { campaignId: campaignId(ctx, str("campaign")), branchId: str("branch"), actor: s.as ?? "engineer", reason: "changed outside ChangeGuard (scenario)", now });
      return null;
    case "reconcile":
      await runReconcile(ctx.pool, now);
      return null;
    default:
      throw new InvalidScenario(`unknown step "${s.do}"`);
  }
}

const isRefusal = (e: unknown) => e instanceof ForbiddenError || e instanceof ActionError || e instanceof ZodError;

async function runStep(ctx: Ctx, s: Step, index: string, now: Date, measure = true): Promise<StepResult> {
  const result: StepResult = { index, do: s.do, as: s.as, ref: s.ref, label: s.label, outcome: "accepted", invariantFailures: [], expect: s.expect };
  const world = WORLD_STEPS.has(s.do);
  const before = measure && !world ? await snap(ctx.pool) : null;
  let change: ChangeRow | null = null;
  try {
    change = await perform(ctx, s, now);
  } catch (error) {
    if (error instanceof InvalidScenario) throw error;
    result.outcome = "refused";
    result.error = error instanceof Error ? `${error.constructor.name}: ${error.message}`.slice(0, 400) : String(error);
    if (!isRefusal(error)) result.unhandled = true;
    if (error instanceof ZodError && PREVIEW_STEPS.has(s.do)) result.actualClass = "UNSUPPORTED";
    else if (PREVIEW_STEPS.has(s.do) && s.do !== "rerun_preflight") result.actualClass = "BLOCK";
  }
  if (world) {
    result.outcome = "world";
    return result;
  }
  if (change) {
    result.status = change.status;
    if (PREVIEW_STEPS.has(s.do)) {
      result.actualClass = classify(change);
      result.verdict = change.preflight?.verdict;
      result.evidence = (change.preflight?.checks ?? []).filter((c) => c.status === "fail" || c.status === "warn").map((c) => ({ id: c.id, status: c.status, code: c.code, detail: c.detail }));
    }
    if (s.do === "release" || s.do === "monitor") result.verification = change.verification;
  }
  if (before) {
    const after = await snap(ctx.pool);
    if (before.spendCents !== after.spendCents) result.invariantFailures.push(`FI-1: company spend ${before.spendCents} → ${after.spendCents}`);
    if (before.collectedCents !== after.collectedCents || before.acquired !== after.acquired) result.invariantFailures.push(`FI-6: collected ${before.collectedCents} → ${after.collectedCents}, acquired ${before.acquired} → ${after.acquired}`);
    const noChangeExpected = result.outcome === "refused" || PREVIEW_STEPS.has(s.do) || s.do === "approve" || s.do === "reject" || s.do === "monitor";
    if (noChangeExpected) {
      const moved = changedBranches(before, after);
      if (before.maps !== after.maps || moved.length > 0 || before.raw !== after.raw) {
        result.invariantFailures.push(`FI-4: ${s.do} (${result.outcome}) changed ${before.maps !== after.maps ? "the mapping table, " : ""}${moved.length ? `branches ${moved.join(",")}, ` : ""}${before.raw !== after.raw ? "raw events" : ""}`);
      }
    }
    if (s.do === "release" && result.outcome === "accepted" && change && change.kind === "campaign_mapping") {
      const payload = change.payload as { campaignId: number; branchId: string };
      const previous = before.mapByCampaign.get(payload.campaignId) ?? null;
      const media = await ctx.pool.query<{ c: string | null }>(
        `select sum(s.cost_cents) as c from ad_spend_daily s join channels ch on ch.code = s.channel_code
          where s.campaign_id = $1 and ch.cost_basis = 'media' and s.spend_date >= $2::date and s.spend_date < $3::date`,
        [payload.campaignId, "2026-09-01", "2026-10-31"],
      );
      const moved = Number(media.rows[0].c ?? 0);
      const delta = (b: string | null) => (b ? (after.paidSpend.get(b) ?? 0) - (before.paidSpend.get(b) ?? 0) : 0);
      if (delta(payload.branchId) !== moved || (previous !== null && delta(previous) !== -moved)) {
        result.invariantFailures.push(`FI-2: expected ${payload.branchId} +${moved}${previous ? ` and ${previous} −${moved}` : ""}; got ${delta(payload.branchId)}${previous ? ` and ${delta(previous)}` : ""}`);
      }
      const extId = await ctx.pool.query<{ external_campaign_id: string }>("select external_campaign_id from ad_campaigns where id = $1", [payload.campaignId]);
      const leadBranches = await ctx.pool.query<{ b: string }>("select distinct effective_branch_id as b from v_leads where campaign_external_id = $1", [extId.rows[0].external_campaign_id]);
      const allowed = new Set([payload.branchId, ...(previous ? [previous] : []), ...leadBranches.rows.map((r) => r.b)]);
      const outside = changedBranches(before, after).filter((b) => !allowed.has(b));
      if (outside.length > 0) result.invariantFailures.push(`FI-3: branches outside the change moved: ${outside.join(", ")}`);
    }
  }
  return result;
}

// ── Scoring (SCORING.md) ─────────────────────────────────────────────────────

interface Finding { type: string; severity: "critical" | "high" | "medium" | "low" | "info"; step?: string; detail: string }

function scoreStep(sc: Scenario, r: StepResult): Finding[] {
  const out: Finding[] = [];
  const e = r.expect;
  if (r.unhandled) out.push({ type: "unhandled_error", severity: "high", step: r.index, detail: r.error ?? "" });
  for (const f of r.invariantFailures) out.push({ type: "invariant_violation", severity: "critical", step: r.index, detail: f });
  if (!e) return out;
  // Amendment A1 (SCORING.md): a proposal the author expects to be refused for who made it is
  // scored on the refusal; its class label describes the mapping, not the system's answer.
  const classScored = !(e.outcome === "refused" && r.outcome === "refused");
  if (e.class && r.actualClass && classScored) {
    const want = e.class;
    const got = r.actualClass;
    if (want !== got) {
      const criticalScope = sc.severityIfWrong === "critical" || sc.category === "unsafe_mapping" || sc.category === "cross_brand_or_branch_conflict";
      const type =
        want === "BLOCK" && got === "ALLOW" ? "false_approval"
        : want === "BLOCK" && got === "NEEDS_REVIEW" ? "under_block"
        : want === "NEEDS_REVIEW" && got === "ALLOW" ? "missed_review"
        : (want === "ALLOW" || want === "NEEDS_REVIEW") && got === "BLOCK" ? "false_block"
        : want === "ALLOW" && got === "NEEDS_REVIEW" ? "over_review"
        : "unsupported_mismatch";
      const severity: Finding["severity"] =
        type === "false_approval" ? (criticalScope ? "critical" : "high")
        : type === "under_block" || type === "missed_review" ? "high"
        : type === "false_block" ? (sc.severityIfWrong === "critical" || sc.severityIfWrong === "high" ? "high" : "medium")
        : type === "over_review" ? "low"
        : "medium";
      out.push({ type, severity, step: r.index, detail: `expected ${want}, system ${got}${r.evidence?.length ? ` (${r.evidence.map((x) => x.code ?? x.id).join(", ")})` : ""}${r.error ? ` — ${r.error}` : ""}` });
    } else if (want === "NEEDS_REVIEW") {
      out.push({ type: "correct_human_review", severity: "info", step: r.index, detail: (r.evidence ?? []).map((x) => x.code ?? x.id).join(", ") });
    }
  } else if (e.class && !r.actualClass && classScored) {
    out.push({ type: "unsupported_mismatch", severity: "medium", step: r.index, detail: `expected class ${e.class}, but the step produced no change (${r.error ?? "no error"})` });
  }
  if (e.outcome && e.outcome !== "either" && r.outcome !== "world" && e.outcome !== r.outcome) {
    if (e.outcome === "refused") {
      const critical = ["approve", "release", "monitor", "reject"].includes(r.do) || (r.as !== undefined && ["guest", "partner", "brand"].includes(r.as));
      out.push({ type: "accepted_but_must_refuse", severity: critical ? "critical" : "high", step: r.index, detail: `${r.do} as ${r.as} was accepted (status ${r.status ?? "?"})` });
    } else {
      out.push({ type: "false_refusal", severity: "medium", step: r.index, detail: `${r.do} as ${r.as} was refused: ${r.error ?? ""}` });
    }
  }
  if (e.status && r.status && e.status !== r.status) out.push({ type: "status_mismatch", severity: "medium", step: r.index, detail: `expected ${e.status}, got ${r.status}` });
  // Evidence: every BLOCK / NEEDS_REVIEW must carry a reason; every refusal a message.
  if ((r.actualClass === "BLOCK" || r.actualClass === "NEEDS_REVIEW") && r.outcome === "accepted" && !(r.evidence ?? []).some((x) => x.detail.trim().length > 0)) {
    out.push({ type: "unexplained_decision", severity: "medium", step: r.index, detail: `${r.actualClass} without a failing or warning check` });
  }
  if (r.outcome === "refused" && !(r.error && r.error.length > 0)) out.push({ type: "unexplained_decision", severity: "medium", step: r.index, detail: "refusal without a message" });
  return out;
}

// ── One scenario ─────────────────────────────────────────────────────────────

async function runScenario(pool: Pool, sc: Scenario) {
  const ctx: Ctx = { pool, scenario: sc, campaignIds: new Map(), externalIds: new Map(), platforms: new Map(), customers: new Map(), changes: new Map(), counter: 0 };
  const started = Date.now();
  await freshDb(pool);
  await buildWorld(ctx);
  const results: StepResult[] = [];
  // One monotonic clock. On a world step `day` is a data date (the lead's day, the restated
  // spend date, the refund date), so it moves the clock forward only for change steps; a world
  // step never runs "earlier" than the step before it (a restatement must be a later delivery).
  let clock = at(DEFAULT_STEP_DAY, 0).getTime();
  for (const [i, s] of sc.steps.entries()) {
    const asked = s.day !== undefined && !WORLD_STEPS.has(s.do) ? at(s.day, 0).getTime() : clock;
    clock = Math.max(asked, clock) + 60_000;
    const now = new Date(clock);
    if (s.do === "concurrently") {
      const before = await snap(pool);
      const settled = await Promise.all((s.steps ?? []).map((sub, j) => runStep(ctx, sub, `${i + 1}.${j + 1}`, now, false)));
      const after = await snap(pool);
      const group: StepResult = { index: `${i + 1}`, do: "concurrently", outcome: "accepted", invariantFailures: [] };
      if (before.spendCents !== after.spendCents) group.invariantFailures.push(`FI-1: company spend ${before.spendCents} → ${after.spendCents}`);
      if (before.collectedCents !== after.collectedCents || before.acquired !== after.acquired) group.invariantFailures.push("FI-6: collected or acquired moved during the concurrent steps");
      results.push(group, ...settled);
    } else {
      results.push(await runStep(ctx, s, `${i + 1}`, now));
    }
  }
  // Final state.
  const finalMapping: Record<string, string | null> = {};
  for (const key of Object.keys(sc.expectFinal?.mapping ?? {})) {
    const { rows } = await pool.query<{ branch_id: string }>("select branch_id from campaign_branch_map where campaign_id = $1", [campaignId(ctx, key)]);
    finalMapping[key] = rows[0]?.branch_id ?? null;
  }
  const finalStatuses: Record<string, string | null> = {};
  for (const ref of Object.keys(sc.expectFinal?.statuses ?? {})) {
    const id = ctx.changes.get(ref);
    const { rows } = id === undefined ? { rows: [] } : await pool.query<{ status: string }>("select status from config_changes where id = $1", [id]);
    finalStatuses[ref] = rows[0]?.status ?? null;
  }
  const findings: Finding[] = results.flatMap((r) => scoreStep(sc, r));
  for (const [key, want] of Object.entries(sc.expectFinal?.mapping ?? {})) {
    const got = finalMapping[key];
    if (got !== want) out(findings, got !== null ? "critical" : "high", "wrong_live_mapping", `${key}: expected ${want ?? "unmapped"}, live ${got ?? "unmapped"}`);
  }
  for (const [ref, want] of Object.entries(sc.expectFinal?.statuses ?? {})) {
    if (finalStatuses[ref] !== want) out(findings, "medium", "status_mismatch", `${ref}: expected ${want}, final ${finalStatuses[ref] ?? "not created"}`);
  }
  for (const group of sc.expectFinal?.exactlyOneOf ?? []) {
    const accepted = results.filter((r) => r.label && group.includes(r.label) && r.outcome === "accepted").length;
    if (accepted !== 1) out(findings, "critical", "exactly_one_violated", `${group.join(" / ")}: ${accepted} accepted`);
  }
  return { id: sc.id, category: sc.category, title: sc.title, severityIfWrong: sc.severityIfWrong, millis: Date.now() - started, steps: results, finalMapping, finalStatuses, findings, pass: !findings.some((f) => f.severity !== "info") };
}

function out(findings: Finding[], severity: Finding["severity"], type: string, detail: string) {
  findings.push({ type, severity, detail });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [file, outFile] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!file || !outFile) throw new Error("usage: eval-changeguard.ts <scenarios.json> <out.json> [--only ID,ID]");
  const onlyAt = process.argv.indexOf("--only");
  const only = onlyAt > 0 ? new Set(process.argv[onlyAt + 1].split(",")) : null;
  const doc = JSON.parse(readFileSync(file, "utf8")) as { version: string; author: string; scenarios: Scenario[] };
  const pool = createPool(process.env.EVAL_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54333/revenue_signal_eval");
  const report: Array<Record<string, unknown>> = [];
  try {
    for (const sc of doc.scenarios) {
      if (only && !only.has(sc.id)) continue;
      try {
        const r = await runScenario(pool, sc);
        report.push(r);
        const bad = r.findings.filter((f) => f.severity !== "info");
        console.log(`${r.pass ? "PASS" : "FAIL"} ${sc.id.padEnd(7)} ${sc.category.padEnd(34)} ${(r.millis / 1000).toFixed(1)}s ${bad.map((f) => `[${f.severity}] ${f.type}: ${f.detail}`).join(" | ").slice(0, 400)}`);
      } catch (error) {
        const invalid = error instanceof InvalidScenario;
        report.push({ id: sc.id, category: sc.category, title: sc.title, severityIfWrong: sc.severityIfWrong, invalid, runnerError: !invalid, error: String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 1200) });
        console.log(`${invalid ? "INVALID" : "RUNNER-ERROR"} ${sc.id} ${String(error instanceof Error ? error.message : error).slice(0, 300)}`);
      }
    }
  } finally {
    await pool.end();
  }
  writeFileSync(outFile, `${JSON.stringify({ scenarios: file, version: doc.version, author: doc.author, ranAt: new Date().toISOString(), results: report }, null, 2)}\n`);
  console.log(`wrote ${outFile}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
