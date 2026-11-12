/**
 * VP acceptance runner (docs/agent-work/vp-acceptance/SCHEMA.md, SCORING.md).
 *
 *   npx tsx scripts/eval-acceptance.ts <scenarios.json> <out.json> [--only VP-01,VP-03] [--twice]
 *
 * The output opens with a manifest that names everything a re-run must hold fixed: the
 * scenario file's hash and each scenario's canonical hash, the code commit (and whether the
 * tree was dirty), the active mapper versions, Node and Postgres. `--twice` runs every scenario
 * a second time in a fresh database and compares outcome fingerprints: a difference is a
 * determinism failure, reported per scenario.
 *
 * One fresh database per scenario (EVAL_DATABASE_URL, default revenue_signal_eval), with no
 * currency rule. The world is delivered through the real intake pipeline (the deployed mappers);
 * every step calls the real services as the named demo viewer. The runner re-implements no
 * product rule: it builds inputs, records what the system reports, measures the ChangeGuard
 * financial invariants around each change, and scores against the designer's frozen labels.
 * Where the product enforces a permission only in its HTTP route, the runner applies that same
 * check and says so (marked ROUTE CHECK).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Pool } from "pg";
import { z, ZodError } from "zod";
import type { RawRecord, SourceName } from "@/lib/adapters/contract";
import { ACTIVE_VERSION } from "@/lib/adapters/registry";
import { ActionError, mapCampaignToBranch, overrideLeadBranch } from "@/lib/actions";
import { runInvestigation } from "@/lib/ai/investigate";
import { claimNumbers } from "@/lib/ai/numbers";
import { NewChangeSchema } from "@/lib/changeguard/model";
import { createChange, decideChange, DecisionSchema, monitorChange, releaseChange, rerunPreflight, type ChangeRow } from "@/lib/changeguard/service";
import { accountsAwaitingCurrency, authorizeCurrencyRule, listCurrencyRules, proposeCurrencyRule, revokeCurrencyRule } from "@/lib/currency/rules";
import { createPool } from "@/lib/db";
import { verifiedReadinessSnapshot } from "@/lib/decision/verified";
import { resolveIdentities } from "@/lib/identity";
import { replay } from "@/lib/ingest/replay";
import { getInquiry, openCacInquiry } from "@/lib/inquiry/store";
import { rollupBrand, traceCash } from "@/lib/lineage/cash";
import { traceBranchMetric } from "@/lib/lineage/trace";
import { branchRows, paidCac, totals, type BranchRow } from "@/lib/metrics/scorecard";
import { PERIODS, type PeriodKey } from "@/lib/period";
import { instantToWallTime } from "@/lib/primitives";
import { BRANCH_BY_ID, BRANCHES, BRANDS } from "@/lib/reference";
import { ForbiddenError, requirePermission, resolveScope, VIEWERS, type Viewer } from "@/lib/viewer";
import { call, crm, freshDb, ingest, runReconcile } from "../tests/helpers";

// ── Format (SCHEMA.md) ───────────────────────────────────────────────────────

type Severity = "critical" | "high" | "medium" | "low";
interface Spend { fromDay: number; toDay: number; dollarsPerDay: number; month?: number }
interface CampaignSpec { key: string; platform: string; name: string; account?: string; spend?: Spend[]; mappedTo?: string | null; currencyCode?: string | null }
interface LeadSpec { key?: string; via: "call" | "web"; campaign: string | null; branch: string; count?: number; day?: number; fromDay?: number; toDay?: number; month?: number; direction?: string; spam?: boolean; leadStatus?: string; agentNote?: string; phoneKey?: string }
interface CustomerSpec { key: string; campaign: string | null; branch: string; day: number; month?: number; invoiceAmount?: string; paidAmount?: string; amount?: string; phoneKey?: string; completed?: boolean; crmNote?: string }
interface UnreadableSpec { source: "calls" | "ads" | "crm"; count: number; day: number; month?: number; defect: "missing_id" | "bad_date" | "unknown_shape" }
interface MetricExpect { scope: string; period: PeriodKey; metric: string; value: number | null }
type Step = Record<string, unknown> & { do: string; as?: string; ref?: string; day?: number; month?: number; label?: string; expect?: Record<string, unknown> };
interface Scenario {
  id: string;
  title: string;
  centre: string;
  rationale: string;
  severityIfWrong: Severity;
  knownAmbiguity?: string;
  world?: {
    campaigns?: CampaignSpec[];
    leads?: LeadSpec[];
    customers?: CustomerSpec[];
    refunds?: Array<{ customer: string; amount: string; day: number; month?: number }>;
    feeds?: Array<{ stream: string; lastSuccessDay: number; lastRunFailed?: boolean }>;
    leadCorrections?: Array<{ campaign: string; fromBranch: string; toBranch: string; count: number }>;
    unreadable?: UnreadableSpec[];
  };
  steps: Step[];
  reference?: Record<string, unknown>;
}

/** A step the runner cannot express: a runner or scenario problem, never a product failure. */
class InvalidScenario extends Error {}

// ── Time and actors ──────────────────────────────────────────────────────────

const NOW = new Date("2026-10-31T13:00:00Z");
const at = (day: number, month = 10, minute = 0) => new Date(Date.UTC(2026, month - 1, day, 16, minute));
const ymd = (day: number, month = 10) => `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const hours = (h: number) => h * 3_600_000;
const STREAMS: Array<[string, string]> = [["ads", "ads"], ["calls", "calls"], ["web", "web"], ["d2d", "d2d"], ["crm.customer", "crm"], ["crm.subscription", "crm"], ["crm.appointment", "crm"], ["crm.ticket", "crm"], ["crm.payment", "crm"]];
const CALL_SOURCE: Record<string, string> = { google_ads: "Google Ads", google_lsa: "Google LSA", meta: "Facebook", microsoft_ads: "Bing" };
const UTM: Record<string, string> = { google_ads: "google", google_lsa: "google", meta: "facebook", microsoft_ads: "bing" };
const sourceFor = (platform: string | undefined) => (platform ? CALL_SOURCE[platform] ?? "Google Ads" : "Direct");

const ACTORS: Record<string, Viewer> = {
  ...VIEWERS,
  marketing2: { ...VIEWERS.marketing, subject: "demo:marketing-2", label: "Second marketing analyst · all branches" },
  approver2: { ...VIEWERS.approver, subject: "demo:approver-2", label: "Second revenue ops approver · all branches" },
};
function actor(name: unknown): Viewer {
  const v = ACTORS[String(name ?? "")];
  if (!v) throw new InvalidScenario(`unknown actor "${String(name)}"`);
  return v;
}
const branchOk = (b: unknown) => {
  if (typeof b !== "string" || !BRANCH_BY_ID.has(b)) throw new InvalidScenario(`branch ${String(b)} does not exist`);
  return b;
};

// The ChangeGuard route's request schema (app/api/changes/route.ts).
const ProposeBody = z.intersection(NewChangeSchema, z.object({ supersedes: z.number().int().positive().nullable().optional() }));

// ── Context ──────────────────────────────────────────────────────────────────

interface CallRef { id: string; branch: string; phone: string; time: Date; extra: Record<string, unknown>; source: string }
interface CustomerRef { id: number; ticketId: number; paymentId: number | null; branch: string; phone: string; soldAt: Date; note: string | null }
interface Ctx {
  pool: Pool;
  sc: Scenario;
  campaigns: Map<string, CampaignSpec>;
  phones: Map<string, string>;
  calls: Map<string, CallRef>;
  customers: Map<string, CustomerRef>;
  changes: Map<string, number>;
  rules: Map<string, number>;
  batches: Array<{ source: SourceName; records: RawRecord[] }>;
  n: number;
}

const ext = (ctx: Ctx, key: string) => `${ctx.sc.id}-${key}`;
function campaign(ctx: Ctx, key: unknown): CampaignSpec {
  const c = ctx.campaigns.get(String(key));
  if (!c) throw new InvalidScenario(`campaign key "${String(key)}" is not defined in world.campaigns`);
  return c;
}
const accountOf = (ctx: Ctx, c: CampaignSpec) => c.account ?? `ACC-${ctx.sc.id}-${c.platform}`;
function phoneFor(ctx: Ctx, key?: string): string {
  if (key && ctx.phones.has(key)) return ctx.phones.get(key)!;
  ctx.n += 1;
  const phone = `+1480${5_570_000 + ctx.n}`;
  if (key) ctx.phones.set(key, phone);
  return phone;
}

/** Every delivery goes through here, so a `redeliver` can send the same records again. */
async function deliver(ctx: Ctx, source: SourceName, records: RawRecord[], now: Date) {
  if (records.length === 0) return;
  ctx.batches.push({ source, records });
  await ingest(ctx.pool, source, records, { now });
}

// ── Deliveries ───────────────────────────────────────────────────────────────

function spendRecord(ctx: Ctx, c: CampaignSpec, day: number, month: number, dollars: number, fetchedAt: Date): RawRecord {
  return {
    entity: "spend_day",
    payload: {
      platform: c.platform, accountId: accountOf(ctx, c), campaignId: ext(ctx, c.key), campaignName: c.name, date: ymd(day, month),
      costMicros: String(Math.round(dollars * 100) * 10_000), clicks: 5, conversions: 1, fetchedAt: fetchedAt.toISOString(),
      ...(c.platform === "google_ads" ? { campaignType: "SEARCH" } : c.platform === "google_lsa" ? { campaignType: "LOCAL_SERVICES" } : {}),
      // Default "USD"; null in the scenario = the feed states no currency.
      ...(c.currencyCode === null ? {} : { currencyCode: c.currencyCode ?? "USD" }),
    },
  };
}

async function addSpend(ctx: Ctx, key: unknown, spends: Spend[], now: Date) {
  const c = campaign(ctx, key);
  const records: RawRecord[] = [];
  for (const s of spends) {
    const m = s.month ?? 10;
    for (let d = s.fromDay; d <= s.toDay; d++) records.push(spendRecord(ctx, c, d, m, s.dollarsPerDay, new Date(at(d, m).getTime() + hours(14))));
  }
  await deliver(ctx, "ads", records, now);
}

async function addLeads(ctx: Ctx, l: LeadSpec, now: Date) {
  const from = l.fromDay ?? l.day;
  const to = l.toDay ?? l.day ?? from;
  if (from === undefined || to === undefined) throw new InvalidScenario("a lead needs day or fromDay/toDay");
  const count = l.count ?? 1;
  if (l.key && count !== 1) throw new InvalidScenario(`lead ${l.key} has a key, so it must have count 1`);
  const platform = l.campaign ? campaign(ctx, l.campaign).platform : undefined;
  const records: RawRecord[] = [];
  for (let i = 0; i < count; i++) {
    ctx.n += 1;
    const day = from + Math.floor((i * (to - from + 1)) / count);
    const time = at(day, l.month ?? 10, i % 50);
    const phone = phoneFor(ctx, l.phoneKey);
    if (l.via === "web") {
      records.push({ entity: "lead", payload: { messageId: `${ctx.sc.id}-w${ctx.n}`, timestamp: time.toISOString(), properties: { form: "quote", branch_id: branchOk(l.branch), zip: "85001", phone, email: null, utm_source: platform ? UTM[platform] ?? "google" : null, utm_medium: platform ? "cpc" : null, utm_campaign: l.campaign ? ext(ctx, l.campaign) : null, gclid: null, message: l.agentNote ?? null } } });
      continue;
    }
    const id = `${ctx.sc.id}-c${ctx.n}`;
    const extra = {
      campaign: l.campaign ? ext(ctx, l.campaign) : null,
      agent_note: l.agentNote ?? null,
      ...(l.direction ? { direction: l.direction } : {}),
      ...(l.spam !== undefined ? { spam: l.spam } : {}),
      ...(l.leadStatus ? { lead_status: l.leadStatus } : {}),
    };
    const source = sourceFor(platform);
    records.push(call(id, branchOk(l.branch), phone, time, source, extra));
    if (l.key) ctx.calls.set(l.key, { id, branch: l.branch, phone, time, extra, source });
  }
  await deliver(ctx, l.via === "web" ? "web" : "calls", records, now);
}

async function addCustomer(ctx: Ctx, k: CustomerSpec, now: Date) {
  ctx.n += 1;
  const n = ctx.n;
  const b = branchOk(k.branch);
  const sold = at(k.day, k.month ?? 10);
  const done = new Date(sold.getTime() + hours(1));
  const phone = phoneFor(ctx, k.phoneKey);
  const platform = k.campaign ? campaign(ctx, k.campaign).platform : undefined;
  const ids = { customer: 1000 + n, sub: 2000 + n, appt: 3000 + n, ticket: 4000 + n };
  const invoice = k.invoiceAmount ?? k.amount ?? "149.00";
  const paid = k.paidAmount ?? invoice;
  const completed = k.completed !== false;
  // SCHEMA.md: the customer's call is made the day before.
  await deliver(ctx, "calls", [call(`${ctx.sc.id}-k${n}`, b, phone, new Date(sold.getTime() - hours(24)), sourceFor(platform), { campaign: k.campaign ? ext(ctx, k.campaign) : null })], now);
  const records: RawRecord[] = [
    crm.customer(ids.customer, b, phone, sold, k.crmNote ? { notes: k.crmNote } : {}),
    crm.subscription(ids.sub, ids.customer, b, sold),
    crm.appointment(ids.appt, ids.sub, ids.customer, b, "0", done, sold),
    ...(completed ? [crm.appointment(ids.appt, ids.sub, ids.customer, b, "1", done, done)] : []),
  ];
  let paymentId: number | null = null;
  if (completed) {
    records.push(crm.ticket(ids.ticket, ids.customer, ids.appt, b, invoice, new Date(done.getTime() + hours(1))));
    if (Number(paid) > 0) {
      paymentId = 5000 + n;
      records.push(crm.payment(paymentId, ids.customer, ids.ticket, b, paid, new Date(done.getTime() + hours(2))));
    }
  }
  await deliver(ctx, "crm", records, now);
  ctx.customers.set(k.key, { id: ids.customer, ticketId: ids.ticket, paymentId, branch: b, phone, soldAt: sold, note: k.crmNote ?? null });
}

async function refund(ctx: Ctx, r: { customer: unknown; amount: unknown; day?: unknown; month?: unknown }, now: Date) {
  const k = ctx.customers.get(String(r.customer));
  if (!k) throw new InvalidScenario(`refund for unknown customer ${String(r.customer)}`);
  if (k.paymentId === null) throw new InvalidScenario(`customer ${String(r.customer)} has no payment to refund`);
  ctx.n += 1;
  const when = r.day ? at(Number(r.day), Number(r.month ?? 10)) : now;
  await deliver(ctx, "crm", [crm.payment(9000 + ctx.n, k.id, k.ticketId, k.branch, `-${String(r.amount)}`, when, "1", String(k.paymentId))], now);
}

async function unreadable(ctx: Ctx, u: UnreadableSpec, now: Date) {
  const records: RawRecord[] = [];
  for (let i = 0; i < u.count; i++) {
    ctx.n += 1;
    const time = at(u.day, u.month ?? 10, i % 50);
    if (u.source === "calls") {
      const base = call(`${ctx.sc.id}-u${ctx.n}`, "B01", phoneFor(ctx), time).payload as Record<string, unknown>;
      if (u.defect === "missing_id") delete base.id;
      if (u.defect === "bad_date") base.start_time = "31/31/2026 25:61";
      records.push(u.defect === "unknown_shape" ? { entity: "call", payload: { caller: "+14805550100", when: "yesterday", note: "unrecognised export" } } : { entity: "call", payload: base });
    } else if (u.source === "ads") {
      const first = [...ctx.campaigns.values()][0];
      const base = first ? (spendRecord(ctx, first, u.day, u.month ?? 10, 1, time).payload as Record<string, unknown>) : { platform: "google_ads", accountId: `ACC-${ctx.sc.id}`, campaignId: `${ctx.sc.id}-u`, date: ymd(u.day, u.month ?? 10), costMicros: "1000000", fetchedAt: time.toISOString(), currencyCode: "USD" };
      if (u.defect === "missing_id") delete base.campaignId;
      if (u.defect === "bad_date") base.date = "2026-13-45";
      records.push(u.defect === "unknown_shape" ? { entity: "spend_day", payload: { spend: "lots", day: "Tuesday" } } : { entity: "spend_day", payload: base });
    } else {
      const base = crm.customer(80_000 + ctx.n, "B01", phoneFor(ctx), time).payload as Record<string, unknown>;
      if (u.defect === "missing_id") delete base.customerID;
      if (u.defect === "bad_date") base.dateAdded = "not a date";
      records.push(u.defect === "unknown_shape" ? { entity: "customer", payload: { fullName: "Unknown shape", tel: "n/a" } } : { entity: "customer", payload: base });
    }
  }
  await deliver(ctx, u.source, records, now);
}

async function setFeed(ctx: Ctx, f: { stream: string; lastSuccessDay: number; lastRunFailed?: boolean }) {
  const pair = STREAMS.find(([s]) => s === f.stream);
  if (!pair) throw new InvalidScenario(`unknown stream ${f.stream}`);
  const ok = at(f.lastSuccessDay);
  // The latest run decides freshness: drop the stream's earlier runs written by this runner.
  await ctx.pool.query("delete from ingestion_runs where stream = $1 and adapter_version = 'acceptance'", [f.stream]);
  await ctx.pool.query("insert into ingestion_runs (source, stream, adapter_version, started_at, finished_at, status) values ($1, $2, 'acceptance', $3, $3, 'succeeded')", [pair[1], f.stream, new Date(ok.getTime() - hours(8))]);
  if (f.lastRunFailed) {
    await ctx.pool.query("insert into ingestion_runs (source, stream, adapter_version, started_at, finished_at, status, error) values ($1, $2, 'acceptance', $3, $3, 'failed', 'HTTP 503 from source')", [pair[1], f.stream, new Date(NOW.getTime() - hours(5))]);
  }
}

async function correctLeads(ctx: Ctx, c: { campaign: unknown; fromBranch: unknown; toBranch: unknown; count: unknown }, now: Date) {
  const { rows } = await ctx.pool.query<{ id: string }>("select id from leads where campaign_external_id = $1 and branch_id = $2 order by id limit $3", [ext(ctx, String(c.campaign)), branchOk(c.fromBranch), Number(c.count)]);
  if (rows.length < Number(c.count)) throw new InvalidScenario(`only ${rows.length} leads of ${String(c.campaign)} at ${String(c.fromBranch)} to correct, not ${String(c.count)}`);
  for (const r of rows) await overrideLeadBranch(ctx.pool, { leadId: Number(r.id), branchId: branchOk(c.toBranch), actor: "ops", reason: "scenario correction", now });
}

async function buildWorld(ctx: Ctx) {
  const w = ctx.sc.world ?? {};
  for (const c of w.campaigns ?? []) ctx.campaigns.set(c.key, c);
  for (const c of w.campaigns ?? []) await addSpend(ctx, c.key, c.spend?.length ? c.spend : [], NOW);
  for (const c of w.campaigns ?? []) {
    if (!c.mappedTo) continue;
    const { rows } = await ctx.pool.query<{ id: string }>("select id from ad_campaigns where external_campaign_id = $1", [ext(ctx, c.key)]);
    // A campaign whose spend was all held has no campaign row yet, so nothing to map before the scenario.
    if (rows[0]) await mapCampaignToBranch(ctx.pool, { campaignId: Number(rows[0].id), branchId: branchOk(c.mappedTo), actor: "setup", reason: "mapping before the scenario", now: at(1, 9) });
  }
  for (const l of w.leads ?? []) await addLeads(ctx, l, NOW);
  for (const k of w.customers ?? []) await addCustomer(ctx, k, NOW);
  for (const r of w.refunds ?? []) await refund(ctx, r, NOW);
  for (const u of w.unreadable ?? []) await unreadable(ctx, u, NOW);
  for (const c of w.leadCorrections ?? []) await correctLeads(ctx, c, NOW);
  const feeds = new Map((w.feeds ?? []).map((f) => [f.stream, f]));
  for (const [stream] of STREAMS) await setFeed(ctx, feeds.get(stream) ?? { stream, lastSuccessDay: 30 });
  await runReconcile(ctx.pool, NOW);
  await resolveIdentities(ctx.pool, NOW);
}

// ── What the system reports ──────────────────────────────────────────────────

async function rowsFor(pool: Pool, period: PeriodKey, branchIds: string[] | null): Promise<BranchRow[]> {
  const p = PERIODS[period];
  if (!p) throw new InvalidScenario(`unknown period ${period}`);
  return branchRows(pool, { from: p.from, to: p.to, branchIds });
}

const cents = (v: number) => v / 100;

/** The system's figure for a scope, period and metric, in the schema's units. */
async function figure(pool: Pool, m: MetricExpect): Promise<number | null> {
  const p = PERIODS[m.period];
  if (!p) throw new InvalidScenario(`unknown period ${m.period}`);
  let sum: Pick<BranchRow, "paidSpendCents" | "paidAcquired" | "acquired" | "unknownAcquired" | "collectedCents" | "refundsCents">;
  let unallocated = 0;
  if (m.scope === "company" || m.scope === "unallocated") {
    const t = await totals(pool, { from: p.from, to: p.to, branchIds: null });
    sum = t;
    unallocated = t.unallocatedSpendCents;
    if (m.scope === "unallocated") {
      if (m.metric !== "paid_spend") throw new InvalidScenario("unallocated has paid_spend only");
      return cents(unallocated);
    }
  } else {
    const brand = BRANDS.find((b) => b.id === m.scope);
    const ids = brand ? BRANCHES.filter((b) => b.brandId === brand.id).map((b) => b.id) : [branchOk(m.scope)];
    const rows = await rowsFor(pool, m.period, ids);
    const add = (k: keyof typeof sum) => rows.reduce((t, r) => t + (r[k] as number), 0);
    sum = { paidSpendCents: add("paidSpendCents"), paidAcquired: add("paidAcquired"), acquired: add("acquired"), unknownAcquired: add("unknownAcquired"), collectedCents: add("collectedCents"), refundsCents: add("refundsCents") };
  }
  switch (m.metric) {
    // SCHEMA.md: company paid_spend is all media spend counted (branches plus unallocated).
    case "paid_spend": return cents(sum.paidSpendCents + (m.scope === "company" ? unallocated : 0));
    case "paid_customers": return sum.paidAcquired;
    case "paid_cac": {
      const c = paidCac(sum.paidSpendCents, sum.paidAcquired);
      return c === null ? null : cents(c);
    }
    case "new_customers": return sum.acquired;
    case "unknown_share": return sum.acquired > 0 ? (sum.unknownAcquired / sum.acquired) * 100 : null;
    case "collected": return cents(sum.collectedCents);
    case "refunds": return cents(sum.refundsCents);
    default: throw new InvalidScenario(`unknown metric ${m.metric}`);
  }
}

const sameFigure = (metric: string, expected: number | null, actual: number | null) => {
  if (expected === null || actual === null) return expected === actual;
  if (metric === "unknown_share") return Math.abs(expected - actual) <= 0.1 + 1e-9;
  return Math.abs(expected - actual) < 0.005;
};

// ── Steps ────────────────────────────────────────────────────────────────────

interface Finding { severity: Severity | "info"; step: string; type: string; detail: string }
interface StepResult { index: string; do: string; as?: string; label?: string; outcome: string; error?: string; observed?: unknown; findings: Finding[] }

const PREVIEW = new Set(["propose", "rerun_preflight"]);
const classify = (c: ChangeRow) => (c.preflight?.verdict === "fail" ? "BLOCK" : c.preflight?.verdict === "warn" ? "NEEDS_REVIEW" : "ALLOW");
const reasonOf = (s: Step, fallback: string) => (typeof s.reason === "string" && s.reason.trim().length >= 10 ? s.reason : fallback);
const isRefusal = (e: unknown) => e instanceof ForbiddenError || e instanceof ActionError || e instanceof ZodError;
const need = (s: Step, k: string) => {
  if (s[k] === undefined || s[k] === null || s[k] === "") throw new InvalidScenario(`step ${s.do} needs "${k}"`);
  return s[k];
};
function changeId(ctx: Ctx, ref: unknown): number {
  const id = ctx.changes.get(String(ref));
  if (id === undefined) throw new InvalidScenario(`change ref "${String(ref)}" was never created`);
  return id;
}
async function campaignRowId(ctx: Ctx, key: unknown): Promise<number> {
  campaign(ctx, key);
  const { rows } = await ctx.pool.query<{ id: string }>("select id from ad_campaigns where external_campaign_id = $1", [ext(ctx, String(key))]);
  if (!rows[0]) throw new InvalidScenario(`campaign ${String(key)} has no stored record (all its spend was held?)`);
  return Number(rows[0].id);
}

interface Snap { spendCents: number; maps: string; raw: number; rows: Map<string, string>; collected: number; acquired: number }
async function snap(pool: Pool): Promise<Snap> {
  const spend = await pool.query<{ c: string | null }>("select sum(cost_cents) as c from ad_spend_daily");
  const maps = await pool.query("select campaign_id, branch_id from campaign_branch_map order by campaign_id");
  const raw = await pool.query<{ n: string }>("select count(*) as n from raw_events");
  const rows = await branchRows(pool, { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: null });
  return { spendCents: Number(spend.rows[0].c ?? 0), maps: JSON.stringify(maps.rows), raw: Number(raw.rows[0].n), rows: new Map(rows.map((r) => [r.branchId, JSON.stringify(r)])), collected: rows.reduce((t, r) => t + r.collectedCents, 0), acquired: rows.reduce((t, r) => t + r.acquired, 0) };
}

async function perform(ctx: Ctx, s: Step, now: Date): Promise<{ observed?: unknown; change?: ChangeRow }> {
  switch (s.do) {
    // ── deliveries ──
    case "add_spend":
      await addSpend(ctx, need(s, "campaign"), [{ fromDay: Number(need(s, "fromDay")), toDay: Number(need(s, "toDay")), dollarsPerDay: Number(need(s, "dollarsPerDay")), month: s.month === undefined ? undefined : Number(s.month) }], now);
      return {};
    case "restate_spend": {
      const c = campaign(ctx, need(s, "campaign"));
      const month = Number(s.month ?? 10);
      const fetched = new Date(at(Number(need(s, "fetchedDay")), Number(s.fetchedMonth ?? 10)).getTime() + hours(14));
      await deliver(ctx, "ads", [spendRecord(ctx, c, Number(need(s, "day")), month, Number(need(s, "dollars")), fetched)], now);
      return {};
    }
    case "add_leads":
      await addLeads(ctx, s as unknown as LeadSpec, now);
      return {};
    case "add_customers":
      await addCustomer(ctx, s as unknown as CustomerSpec, now);
      return {};
    case "revise_call": {
      const c = ctx.calls.get(String(need(s, "lead")));
      if (!c) throw new InvalidScenario(`lead key "${String(s.lead)}" is not a keyed call`);
      const to = String(need(s, "to"));
      const change: Record<string, unknown> =
        to === "spam" ? { spam: true } : to === "not_a_lead" ? { lead_status: "not_a_lead" } : to === "outbound" ? { direction: "outbound" } : to === "lead" ? { spam: false, lead_status: "good_lead", direction: "inbound" } : (() => { throw new InvalidScenario(`revise_call to "${to}"`); })();
      c.extra = { ...c.extra, ...change };
      await deliver(ctx, "calls", [call(c.id, c.branch, c.phone, c.time, c.source, c.extra)], now);
      return {};
    }
    case "revise_customer": {
      const k = ctx.customers.get(String(need(s, "customer")));
      if (!k) throw new InvalidScenario(`customer "${String(s.customer)}" is not defined`);
      const to = s.toBranch === undefined ? k.branch : branchOk(s.toBranch);
      const updated = at(Number(need(s, "updatedDay")), Number(s.updatedMonth ?? 10));
      const tz = BRANCH_BY_ID.get(to)!.timezone;
      const note = s.crmNote === undefined ? k.note : String(s.crmNote);
      await deliver(ctx, "crm", [crm.customer(k.id, to, k.phone, updated, { dateAdded: instantToWallTime(k.soldAt, tz), ...(note ? { notes: note } : {}) })], now);
      return {};
    }
    case "refund":
      await refund(ctx, { customer: need(s, "customer"), amount: need(s, "amount"), day: s.day, month: s.month }, now);
      return {};
    case "redeliver": {
      const what = String(need(s, "what"));
      const batches = what === "last_batch" ? ctx.batches.slice(-1) : what === "world" ? [...ctx.batches] : (() => { throw new InvalidScenario(`redeliver "${what}"`); })();
      for (const b of batches) await ingest(ctx.pool, b.source, b.records, { now });
      return {};
    }
    case "unreadable":
      await unreadable(ctx, s as unknown as UnreadableSpec, now);
      return {};
    case "feed":
      await setFeed(ctx, { stream: String(need(s, "stream")), lastSuccessDay: Number(need(s, "lastSuccessDay")), lastRunFailed: s.lastRunFailed === true });
      return {};
    case "replay": {
      const v = actor(s.as);
      requirePermission(v, "replay", "replay held records");
      const source = String(need(s, "source")) as SourceName;
      const { rows } = await ctx.pool.query<{ id: string }>("select id from raw_events where source = $1 and status = 'quarantined' order by id", [source]);
      if (rows.length === 0) return { observed: { replayed: 0 } };
      const r = await replay(ctx.pool, { source, rawEventIds: rows.map((x) => Number(x.id)), mapperVersion: ACTIVE_VERSION[source], actor: v.subject, idempotencyKey: `${ctx.sc.id}-${s.label ?? ctx.n++}`, dryRun: false, now, scope: { ...PERIODS.all, branchIds: null } });
      return { observed: { claimed: r.claimed, projected: r.projected, stillQuarantined: r.stillQuarantined } };
    }
    case "correct_leads":
      await correctLeads(ctx, s as unknown as { campaign: unknown; fromBranch: unknown; toBranch: unknown; count: unknown }, now);
      return {};
    case "reconcile":
      await runReconcile(ctx.pool, now);
      await resolveIdentities(ctx.pool, now);
      return {};
    // ── changes ──
    case "propose": {
      const input = ProposeBody.parse({ kind: "campaign_mapping", payload: { campaignId: await campaignRowId(ctx, need(s, "campaign")), branchId: String(need(s, "branch")) }, reason: reasonOf(s, `Scenario ${ctx.sc.id}: map ${String(s.campaign)} to ${String(s.branch)}`) });
      const change = await createChange(ctx.pool, actor(s.as), input, now);
      if (s.ref) ctx.changes.set(s.ref, change.id);
      return { change };
    }
    case "rerun_preflight":
      return { change: await rerunPreflight(ctx.pool, actor(s.as), changeId(ctx, s.ref), now) };
    case "approve":
    case "reject": {
      const id = changeId(ctx, s.ref);
      const { rows } = await ctx.pool.query<{ config_hash: string; preflight_hash: string | null }>("select config_hash, preflight_hash from config_changes where id = $1", [id]);
      const input = DecisionSchema.parse({ decision: s.do, reason: reasonOf(s, `Scenario ${ctx.sc.id}: reviewed and decided`), configHash: rows[0].config_hash, preflightHash: rows[0].preflight_hash ?? "0".repeat(64) });
      return { change: await decideChange(ctx.pool, actor(s.as), id, input, now) };
    }
    case "release":
      return { change: await releaseChange(ctx.pool, actor(s.as), changeId(ctx, s.ref), now) };
    case "monitor":
      return { change: await monitorChange(ctx.pool, actor(s.as), changeId(ctx, s.ref), now) };
    case "propose_currency_rule": {
      const r = await proposeCurrencyRule(ctx.pool, actor(s.as), { platform: String(need(s, "platform")), adAccountId: String(need(s, "account")), reason: String(s.reason ?? `Scenario ${ctx.sc.id}: the account reports in USD`), now });
      if (s.ref) ctx.rules.set(s.ref, r.ruleId);
      return { observed: r };
    }
    case "authorize_currency_rule":
    case "revoke_currency_rule": {
      const id = ctx.rules.get(String(s.ref));
      if (id === undefined) throw new InvalidScenario(`currency rule ref "${String(s.ref)}" was never proposed`);
      const r = s.do === "authorize_currency_rule"
        ? await authorizeCurrencyRule(ctx.pool, actor(s.as), { ruleId: id, now })
        : await revokeCurrencyRule(ctx.pool, actor(s.as), { ruleId: id, reason: String(s.reason ?? `Scenario ${ctx.sc.id}: the rule no longer holds`), now });
      return { observed: r };
    }
    default:
      throw new InvalidScenario(`unknown step "${s.do}"`);
  }
}

async function askStep(ctx: Ctx, s: Step, r: StepResult) {
  const e = (s.expect ?? {}) as { outcome?: string; mustState?: Array<{ name: string; kind: string; value: number }>; forbidden?: Array<{ pattern: string; why?: string }>; mustNotMention?: string[] };
  let outcome = "ANSWER";
  let result: Awaited<ReturnType<typeof runInvestigation>>["result"] | null = null;
  try {
    const out = await runInvestigation(ctx.pool, { question: String(need(s, "question")), branchId: (s.branch as string | null | undefined) ?? null, viewer: actor(s.as), mode: "deterministic", now: NOW });
    result = out.result;
    const supported = (result.claims ?? []).filter((c) => c.status === "SUPPORTED");
    outcome = result.refusal ? "REFUSE" : supported.length > 0 ? "ANSWER" : "ABSTAIN";
  } catch (error) {
    if (!(error instanceof ForbiddenError) && !(error instanceof ActionError)) throw error;
    outcome = "REFUSE";
    r.error = error.message;
  }
  const supported = (result?.claims ?? []).filter((c) => c.status === "SUPPORTED");
  r.outcome = outcome;
  r.observed = { supported: supported.map((c) => c.text.slice(0, 240)), others: (result?.claims ?? []).filter((c) => c.status !== "SUPPORTED").map((c) => `${c.status}: ${c.text.slice(0, 160)}`).slice(0, 12), summary: result?.summary?.slice(0, 400) };
  const severity = ctx.sc.severityIfWrong;
  if (e.outcome && e.outcome !== outcome) {
    const leak = e.outcome === "REFUSE";
    r.findings.push({ severity: leak ? "critical" : outcome === "ANSWER" ? severity : "medium", step: r.index, type: leak ? "answered_instead_of_refusing" : `expected_${e.outcome.toLowerCase()}`, detail: `expected ${e.outcome}, got ${outcome}` });
  }
  const whole = JSON.stringify(result ?? {});
  for (const m of e.mustNotMention ?? []) if (whole.includes(m)) r.findings.push({ severity: "critical", step: r.index, type: "must_not_mention", detail: `the answer mentions "${m}"` });
  for (const f of e.forbidden ?? []) {
    const hit = supported.find((c) => new RegExp(f.pattern, "i").test(c.text));
    if (hit) r.findings.push({ severity: "critical", step: r.index, type: "forbidden_supported", detail: `SUPPORTED "${hit.text.slice(0, 160)}" matches /${f.pattern}/ (${f.why ?? ""})` });
  }
  for (const f of e.mustState ?? []) {
    const stated = supported.some((c) => claimNumbers(c.text).some((n) => n.kind === f.kind && Math.abs(Math.abs(n.value * n.scale) - Math.abs(f.value)) <= 0.5 * 10 ** -n.decimals * n.scale + 1e-9));
    if (!stated) r.findings.push({ severity: "medium", step: r.index, type: "missing_figure", detail: `${f.name} (${f.kind} ${f.value}) is in no SUPPORTED statement` });
  }
}

async function runStep(ctx: Ctx, s: Step, index: string, now: Date): Promise<StepResult> {
  const r: StepResult = { index, do: s.do, as: s.as, label: s.label, outcome: "done", findings: [] };
  const e = (s.expect ?? {}) as Record<string, unknown>;
  const severity = ctx.sc.severityIfWrong;
  const fail = (sev: Severity | "info", type: string, detail: string) => r.findings.push({ severity: sev, step: index, type, detail });

  if (s.do === "check") {
    const observed: Record<string, unknown> = {};
    for (const m of (e.metrics as MetricExpect[] | undefined) ?? []) {
      const actual = await figure(ctx.pool, m);
      observed[`${m.scope}/${m.period}/${m.metric}`] = actual;
      if (!sameFigure(m.metric, m.value, actual)) fail("critical", "wrong_figure", `${m.scope} ${m.period} ${m.metric}: expected ${m.value}, system ${actual}`);
    }
    if (e.heldCurrency !== undefined) {
      const actual = (await accountsAwaitingCurrency(ctx.pool)).map((a) => ({ platform: a.platform, account: a.adAccountId, campaignDays: a.campaignDays, dollars: cents(a.amountCents) }));
      observed.heldCurrency = actual;
      const want = e.heldCurrency as Array<{ platform: string; account: string; campaignDays: number; dollars: number }>;
      const key = (x: { platform: string; account: string; campaignDays: number; dollars: number }) => `${x.platform}|${x.account}|${x.campaignDays}|${x.dollars.toFixed(2)}`;
      const a = new Set(actual.map(key));
      const w = new Set(want.map(key));
      if (a.size !== w.size || [...w].some((k) => !a.has(k))) fail("critical", "wrong_held_currency", `expected ${[...w].join("; ") || "none"}, system ${[...a].join("; ") || "none"}`);
    }
    if (e.openExceptions !== undefined) {
      const { rows } = await ctx.pool.query<{ kind: string; n: string }>("select kind, count(*) as n from exceptions where status = 'open' group by kind order by kind");
      const actual = new Map(rows.map((x) => [x.kind, Number(x.n)]));
      observed.openExceptions = Object.fromEntries(actual);
      const want = new Map((e.openExceptions as Array<{ kind: string; count: number }>).map((x) => [x.kind, x.count]));
      const same = actual.size === want.size && [...want].every(([k, v]) => actual.get(k) === v);
      if (!same) fail(severity, "wrong_exceptions", `expected ${JSON.stringify(Object.fromEntries(want))}, system ${JSON.stringify(Object.fromEntries(actual))}`);
    }
    r.observed = observed;
    return r;
  }
  if (s.do === "ask") {
    await askStep(ctx, s, r);
    return r;
  }
  if (s.do === "workspace") {
    try {
      const id = await openCacInquiry(ctx.pool, actor(s.as), { branchId: branchOk(need(s, "branch")), now: NOW });
      const w = (await getInquiry(ctx.pool, actor(s.as), id))!;
      r.outcome = "accepted";
      r.observed = { premise: w.result.premise.holds, detail: w.result.premise.detail, hypotheses: Object.fromEntries(w.result.hypotheses.map((h) => [h.code, h.status])), summaries: Object.fromEntries(w.result.hypotheses.map((h) => [h.code, h.summary.slice(0, 200)])), conclusion: w.result.conclusion.status };
      if (e.outcome === "refused") fail("critical", "workspace_not_refused", "a workspace was opened that should have been refused");
      if ("premiseHolds" in e && e.premiseHolds !== w.result.premise.holds) fail(severity, "wrong_premise", `expected premise ${String(e.premiseHolds)}, system ${String(w.result.premise.holds)} (${w.result.premise.detail})`);
      for (const [code, status] of Object.entries((e.hypotheses as Record<string, string> | undefined) ?? {})) {
        const got = w.result.hypotheses.find((h) => h.code === code)?.status;
        if (got !== status) fail(severity, "wrong_hypothesis", `${code}: expected ${status}, system ${got}`);
      }
    } catch (error) {
      if (!isRefusal(error)) throw error;
      r.outcome = "refused";
      r.error = (error as Error).message;
      if (e.outcome !== "refused") fail("medium", "workspace_refused", r.error);
    }
    return r;
  }
  if (s.do === "readiness") {
    try {
      const v = await verifiedReadinessSnapshot(ctx.pool, actor(s.as), { branchId: branchOk(need(s, "branch")), period: PERIODS[String(s.period ?? "oct") as PeriodKey] });
      const c = v.channels.find((x) => x.channelCode === String(need(s, "channel")));
      r.outcome = "accepted";
      r.observed = c ? { state: c.state, because: c.because } : { channels: v.channels.map((x) => x.channelCode) };
      if (e.outcome === "refused") fail("critical", "readiness_not_refused", "readiness was shown for a branch the viewer may not see");
      if (e.state && e.state !== c?.state) fail(severity === "critical" ? "high" : severity, "wrong_readiness", `expected ${String(e.state)}, system ${c?.state ?? "no such channel"}${c ? ` (${c.because[0] ?? ""})` : ""}`);
    } catch (error) {
      if (!isRefusal(error)) throw error;
      r.outcome = "refused";
      r.error = (error as Error).message;
      if (e.outcome !== "refused") fail("medium", "readiness_refused", r.error);
    }
    return r;
  }
  if (s.do === "read") {
    const v = actor(s.as);
    const period = PERIODS[String(s.period ?? "oct") as PeriodKey];
    try {
      const what = String(need(s, "what"));
      if (what === "branch_metrics") {
        resolveScope(v, branchOk(need(s, "branch")));
        await branchRows(ctx.pool, { from: period.from, to: period.to, branchIds: [String(s.branch)] });
      } else if (what === "metric_trace") await traceBranchMetric(ctx.pool, v, { branchId: branchOk(need(s, "branch")), period, metric: "paid_cac" });
      else if (what === "cash_trace") await traceCash(ctx.pool, v, { branchId: branchOk(need(s, "branch")), period });
      else if (what === "brand_rollup") await rollupBrand(ctx.pool, v, { brandId: String(need(s, "brand")) as never, period });
      else if (what === "currency_rules") {
        // ROUTE CHECK: GET /api/currency-rules refuses viewers without sync or approve.
        if (!v.can.sync && !v.can.approve) throw new ForbiddenError(`${v.label} cannot view currency rules`);
        await listCurrencyRules(ctx.pool);
      } else throw new InvalidScenario(`read "${what}"`);
      r.outcome = "accepted";
    } catch (error) {
      if (error instanceof InvalidScenario || !isRefusal(error)) throw error;
      r.outcome = "refused";
      r.error = (error as Error).message;
    }
    if (e.outcome && e.outcome !== r.outcome) fail(e.outcome === "refused" ? "critical" : "medium", e.outcome === "refused" ? "scope_leak" : "read_refused", `expected ${String(e.outcome)}, got ${r.outcome}${r.error ? ` (${r.error})` : ""}`);
    return r;
  }

  // Deliveries, changes and rules.
  const changeStep = ["propose", "rerun_preflight", "approve", "reject", "release", "monitor"].includes(s.do);
  const before = changeStep ? await snap(ctx.pool) : null;
  let change: ChangeRow | undefined;
  try {
    const out = await perform(ctx, s, now);
    change = out.change;
    r.observed = out.observed;
    r.outcome = "accepted";
  } catch (error) {
    if (error instanceof InvalidScenario) throw error;
    r.outcome = "refused";
    r.error = error instanceof Error ? `${error.constructor.name}: ${error.message}`.slice(0, 400) : String(error);
    if (!isRefusal(error)) fail("high", "unhandled_error", r.error);
  }
  if (change) {
    r.observed = { ...(r.observed as object), status: change.status, ...(PREVIEW.has(s.do) ? { class: classify(change), checks: (change.preflight?.checks ?? []).filter((c) => c.status !== "pass").map((c) => `${c.status} ${c.id}: ${c.detail.slice(0, 160)}`) } : {}) };
  }
  if (e.outcome && e.outcome !== r.outcome) {
    const wronglyAccepted = e.outcome === "refused";
    fail(wronglyAccepted && /approve|release|authorize/.test(s.do) ? "critical" : wronglyAccepted ? severity : "medium", wronglyAccepted ? "accepted_should_refuse" : "refused_should_accept", `expected ${String(e.outcome)}, got ${r.outcome}${r.error ? ` (${r.error})` : ""}`);
  }
  if (e.class && PREVIEW.has(s.do)) {
    const got = change ? classify(change) : r.outcome === "refused" ? "BLOCK" : "none";
    if (got !== e.class) {
      const unsafe = e.class === "BLOCK" && got === "ALLOW";
      fail(unsafe ? "critical" : e.class === "NEEDS_REVIEW" && got === "ALLOW" ? "high" : "medium", "wrong_class", `expected ${String(e.class)}, system ${got}`);
    }
  }
  if (e.status && change && change.status !== e.status) fail(severity === "critical" ? "high" : severity, "wrong_status", `expected ${String(e.status)}, system ${change.status}`);
  if (before) {
    const after = await snap(ctx.pool);
    if (before.spendCents !== after.spendCents) fail("critical", "FI-1", `company spend ${before.spendCents} → ${after.spendCents}`);
    if (before.collected !== after.collected || before.acquired !== after.acquired) fail("critical", "FI-6", `collected ${before.collected} → ${after.collected}, acquired ${before.acquired} → ${after.acquired}`);
    const noChange = r.outcome === "refused" || PREVIEW.has(s.do) || s.do === "approve" || s.do === "reject" || s.do === "monitor";
    if (noChange && (before.maps !== after.maps || before.raw !== after.raw || [...before.rows].some(([k, v]) => after.rows.get(k) !== v))) fail("critical", "FI-4", `${s.do} (${r.outcome}) changed the mapping, a branch's figures or the raw events`);
  }
  return r;
}

// ── Scenario ─────────────────────────────────────────────────────────────────

async function runScenario(pool: Pool, sc: Scenario) {
  const ctx: Ctx = { pool, sc, campaigns: new Map(), phones: new Map(), calls: new Map(), customers: new Map(), changes: new Map(), rules: new Map(), batches: [], n: 0 };
  const t0 = Date.now();
  await freshDb(pool, { currencyRule: false });
  await buildWorld(ctx);
  const results: StepResult[] = [];
  let checks = 0;
  for (const [i, s] of sc.steps.entries()) {
    const now = new Date((s.day ? at(Number(s.day), Number(s.month ?? 10)) : at(31)).getTime() + i * 60_000);
    const r = await runStep(ctx, s, `${i + 1}${s.label ? `:${s.label}` : ""}`, now);
    results.push(r);
    const e = (s.expect ?? {}) as Record<string, unknown>;
    checks += (e.metrics as unknown[] | undefined)?.length ?? 0;
    checks += ["heldCurrency", "openExceptions", "outcome", "class", "status", "premiseHolds", "state"].filter((k) => k in e).length;
    checks += Object.keys((e.hypotheses as object | undefined) ?? {}).length + ((e.mustState as unknown[] | undefined)?.length ?? 0) + ((e.forbidden as unknown[] | undefined)?.length ?? 0) + ((e.mustNotMention as unknown[] | undefined)?.length ?? 0);
  }
  const findings = results.flatMap((r) => r.findings);
  return { id: sc.id, title: sc.title, centre: sc.centre, severityIfWrong: sc.severityIfWrong, checks, failed: findings.filter((f) => f.severity !== "info").length, critical: findings.filter((f) => f.severity === "critical").length, millis: Date.now() - t0, findings, steps: results };
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** JSON with keys sorted at every level: its hash names the content, not the file's layout. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * What a scenario's outcome is, without its timing: the findings and the check count. Ids and
 * times inside details come from a fresh database and the frozen business clock, so two runs
 * of the same inputs on the same code must give the same fingerprint.
 */
function outcomeFingerprint(r: Awaited<ReturnType<typeof runScenario>>): string {
  return sha256(canonical({ checks: r.checks, findings: r.findings.map((f) => ({ step: f.step, type: f.type, severity: f.severity, detail: f.detail })) }));
}

async function main() {
  const [file, outFile] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!file || !outFile) throw new Error("usage: eval-acceptance.ts <scenarios.json> <out.json> [--only ID,ID] [--twice]");
  const onlyAt = process.argv.indexOf("--only");
  const only = onlyAt > 0 ? new Set(process.argv[onlyAt + 1].split(",")) : null;
  const twice = process.argv.includes("--twice");
  const raw = readFileSync(file);
  const doc = JSON.parse(raw.toString("utf8")) as { version: string; author: string; scenarios: Scenario[] };
  const pool = createPool(process.env.EVAL_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54333/revenue_signal_eval");
  const out: Array<Record<string, unknown>> = [];
  let manifest: Record<string, unknown> = {};
  try {
    manifest = {
      scenarioFile: { path: file, sha256: sha256(raw), version: doc.version, author: doc.author },
      scenarioHashes: Object.fromEntries(doc.scenarios.map((s) => [s.id, sha256(canonical(s))])),
      code: { commit: git(["rev-parse", "HEAD"]), dirty: (git(["status", "--porcelain", "--untracked-files=no"]) ?? "") !== "" },
      mappers: ACTIVE_VERSION,
      environment: {
        node: process.version,
        platform: process.platform,
        postgres: String((await pool.query("show server_version")).rows[0].server_version),
      },
      randomness: "none drawn: every input is stated in the scenario, each fresh database fixes the business clock (tests/helpers.ts freshDb), and the runner draws no random numbers; --twice tests the claim",
      repeated: twice,
    };
    for (const sc of doc.scenarios) {
      if (only && !only.has(sc.id)) continue;
      try {
        const r = await runScenario(pool, sc);
        const fingerprint = outcomeFingerprint(r);
        let determinism: { repeatFingerprint: string; same: boolean } | undefined;
        if (twice) {
          const again = outcomeFingerprint(await runScenario(pool, sc));
          determinism = { repeatFingerprint: again, same: again === fingerprint };
        }
        out.push({ ...r, scenarioHash: sha256(canonical(sc)), fingerprint, ...(determinism ? { determinism } : {}) });
        const repeat = determinism ? (determinism.same ? " · repeat identical" : " · REPEAT DIFFERS") : "";
        console.log(`${r.critical ? "CRIT" : r.failed ? "FAIL" : "PASS"} ${sc.id.padEnd(6)} ${String(r.checks).padStart(3)} checks, ${r.failed} failed (${r.critical} critical) · ${r.millis} ms${repeat} · ${sc.title.slice(0, 70)}`);
        for (const f of r.findings.filter((x) => x.severity !== "info")) console.log(`       [${f.severity}] step ${f.step} ${f.type}: ${f.detail.slice(0, 260)}`);
      } catch (e) {
        const invalid = e instanceof InvalidScenario;
        out.push({ id: sc.id, title: sc.title, runnerError: true, invalid, error: String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 1500) });
        console.log(`${invalid ? "INVALID" : "RUNNER-ERROR"} ${sc.id} ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
      }
    }
  } finally {
    await pool.end();
  }
  writeFileSync(outFile, `${JSON.stringify({ scenarios: file, version: doc.version, author: doc.author, ranAt: new Date().toISOString(), manifest, results: out }, null, 2)}\n`);
  const differs = out.filter((r) => (r.determinism as { same: boolean } | undefined)?.same === false).map((r) => r.id);
  if (twice) console.log(differs.length ? `determinism: ${differs.length} scenario(s) differ on repeat: ${differs.join(", ")}` : "determinism: every scenario repeated identically");
  console.log(`wrote ${outFile}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
