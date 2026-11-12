/**
 * Held-out investigator evaluation runner (docs/agent-work/investigator-heldout/SCORING.md).
 *
 *   npx tsx scripts/eval-investigator.ts <cases.json> <out.json> [--only IV-01,IV-02]
 *
 * One fresh database per case (EVAL_DATABASE_URL, default revenue_signal_eval). Worlds are built
 * through real intake; questions go through runInvestigation. Claims mode uses a scripted
 * provider that only replays the case's tool calls and candidate statements: it measures the
 * checker, never a language model.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapCampaignToBranch, overrideLeadBranch } from "@/lib/actions";
import { runInvestigation } from "@/lib/ai/investigate";
import type { ModelClient } from "@/lib/ai/model";
import { claimNumbers } from "@/lib/ai/numbers";
import { createPool } from "@/lib/db";
import { resolveIdentities } from "@/lib/identity";
import { BRANCH_BY_ID } from "@/lib/reference";
import { ForbiddenError, VIEWERS, type Viewer } from "@/lib/viewer";
import { call, crm, freshDb, ingest, runReconcile } from "../tests/helpers";

// ── format (SCHEMA.md) ───────────────────────────────────────────────────────

interface Spend { fromDay: number; toDay: number; dollarsPerDay: number; month?: number }
interface CampaignSpec { key: string; platform: string; name: string; spend?: Spend[]; mappedTo?: string | null; currencyCode?: string | null }
interface LeadSpec { via: "call" | "web"; campaign: string | null; branch: string; count?: number; day?: number; fromDay?: number; toDay?: number; month?: number; direction?: string; spam?: boolean; leadStatus?: string; agentNote?: string; phoneKey?: string }
interface CustomerSpec { key: string; campaign: string | null; branch: string; day: number; month?: number; invoiceAmount?: string; paidAmount?: string; phoneKey?: string; completed?: boolean }
interface Case {
  id: string;
  category: string;
  title: string;
  rationale: string;
  severityIfWrong: "critical" | "high" | "medium" | "low";
  world?: {
    campaigns?: CampaignSpec[];
    leads?: LeadSpec[];
    customers?: CustomerSpec[];
    refunds?: Array<{ customer: string; amount: string; day: number; month?: number }>;
    feeds?: Array<{ stream: string; lastSuccessDay: number; lastRunFailed?: boolean }>;
    lineage?: Array<{ predecessor: string; successor: string }>;
    leadCorrections?: Array<{ campaign: string; fromBranch: string; toBranch: string; count: number }>;
  };
  ask: { as: string; branch: string | null; question: string };
  mode: "investigator" | "claims";
  expect?: {
    outcome?: "ANSWER" | "ABSTAIN" | "REFUSE";
    referenceFacts?: Array<{ name: string; kind: "money" | "percent" | "count"; value: number; mustBeStated?: boolean }>;
    forbidden?: Array<{ pattern: string; why?: string }>;
    mustNotMention?: string[];
  };
  toolCalls?: Array<{ tool: string; input: Record<string, unknown> }>;
  candidates?: Array<{ text: string; cites: number[]; statedAs: "verified" | "hypothesis"; expect: string }>;
}

class InvalidCase extends Error {}

const NOW = new Date("2026-10-31T13:00:00Z");
const at = (day: number, month = 10, minute = 0) => new Date(Date.UTC(2026, month - 1, day, 16, minute));
const ymd = (day: number, month = 10) => `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const CALL_SOURCE: Record<string, string> = { google_ads: "Google Ads", google_lsa: "Google LSA", meta: "Facebook", microsoft_ads: "Bing" };
const UTM: Record<string, string> = { google_ads: "google", google_lsa: "google", meta: "facebook", microsoft_ads: "bing" };
/**
 * The call source for a lead or customer: its campaign's platform, or "Direct" (the branch's main
 * line, no tracking: channel unknown) when the case gives no campaign. SCHEMA.md: a null campaign
 * means no paid touch. First contact used "Google Ads" for a null campaign, which made such
 * customers paid (google_search); fixed after first contact (evidence/ADJUDICATION.md).
 */
const sourceFor = (platform: string | undefined) => (platform ? CALL_SOURCE[platform] ?? "Google Ads" : "Direct");
const STREAMS: Array<[string, string]> = [["ads", "ads"], ["calls", "calls"], ["web", "web"], ["d2d", "d2d"], ["crm.customer", "crm"], ["crm.subscription", "crm"], ["crm.appointment", "crm"], ["crm.ticket", "crm"], ["crm.payment", "crm"]];
const hours = (h: number) => h * 3_600_000;

interface Ctx { pool: Pool; c: Case; ext: (key: string) => string; platforms: Map<string, string>; phones: Map<string, string>; customers: Map<string, { id: number; ticketId: number; paymentId: number | null; branch: string }>; n: number }

function phoneFor(ctx: Ctx, key?: string): string {
  if (key && ctx.phones.has(key)) return ctx.phones.get(key)!;
  ctx.n += 1;
  const phone = `+1480${5_560_000 + ctx.n}`;
  if (key) ctx.phones.set(key, phone);
  return phone;
}
const branchOk = (b: string) => {
  if (!BRANCH_BY_ID.has(b)) throw new InvalidCase(`branch ${b} does not exist`);
  return b;
};

async function buildWorld(ctx: Ctx) {
  const w = ctx.c.world ?? {};
  // Spend, through the active ads mapper; a stated currency goes into the payload.
  const ads: RawRecord[] = [];
  for (const camp of w.campaigns ?? []) {
    ctx.platforms.set(camp.key, camp.platform);
    const days = camp.spend?.length ? camp.spend : [{ fromDay: 1, toDay: 1, dollarsPerDay: 0 }];
    for (const s of days) {
      for (let d = s.fromDay; d <= s.toDay; d++) {
        const m = s.month ?? 10;
        ads.push({
          entity: "spend_day",
          payload: {
            platform: camp.platform, accountId: `ACC-${ctx.c.id}`, campaignId: ctx.ext(camp.key), campaignName: camp.name, date: ymd(d, m),
            costMicros: String(Math.round(s.dollarsPerDay * 100) * 10_000), clicks: 5, conversions: 1,
            fetchedAt: new Date(at(d, m).getTime() + hours(14)).toISOString(),
            ...(camp.platform === "google_ads" ? { campaignType: "SEARCH" } : camp.platform === "google_lsa" ? { campaignType: "LOCAL_SERVICES" } : {}),
            ...(camp.currencyCode ? { currencyCode: camp.currencyCode } : {}),
          },
        });
      }
    }
  }
  if (ads.length) await ingest(ctx.pool, "ads", ads, { now: NOW });
  for (const camp of w.campaigns ?? []) {
    if (!camp.mappedTo) continue;
    const { rows } = await ctx.pool.query<{ id: string }>("select id from ad_campaigns where external_campaign_id = $1", [ctx.ext(camp.key)]);
    if (rows[0]) await mapCampaignToBranch(ctx.pool, { campaignId: Number(rows[0].id), branchId: branchOk(camp.mappedTo), actor: "setup", reason: "mapping before the case", now: at(1, 9) });
  }
  // Leads.
  for (const l of w.leads ?? []) {
    const from = l.fromDay ?? l.day;
    const to = l.toDay ?? l.day ?? from;
    if (from === undefined || to === undefined) throw new InvalidCase("a lead needs day or fromDay/toDay");
    const count = l.count ?? 1;
    const platform = l.campaign ? ctx.platforms.get(l.campaign) : undefined;
    const records: RawRecord[] = [];
    for (let i = 0; i < count; i++) {
      ctx.n += 1;
      const day = from + Math.floor((i * (to - from + 1)) / count);
      const time = at(day, l.month ?? 10, i % 50);
      const phone = phoneFor(ctx, l.phoneKey);
      if (l.via === "web") {
        records.push({ entity: "lead", payload: { messageId: `${ctx.c.id}-w${ctx.n}`, timestamp: time.toISOString(), properties: { form: "quote", branch_id: branchOk(l.branch), zip: "85001", phone, email: null, utm_source: platform ? UTM[platform] ?? "google" : null, utm_medium: platform ? "cpc" : null, utm_campaign: l.campaign ? ctx.ext(l.campaign) : null, gclid: null, message: l.agentNote ?? null } } });
      } else {
        records.push(call(`${ctx.c.id}-c${ctx.n}`, branchOk(l.branch), phone, time, sourceFor(platform), {
          campaign: l.campaign ? ctx.ext(l.campaign) : null,
          agent_note: l.agentNote ?? null,
          ...(l.direction ? { direction: l.direction } : {}),
          ...(l.spam !== undefined ? { spam: l.spam } : {}),
          ...(l.leadStatus ? { lead_status: l.leadStatus } : {}),
        }));
      }
    }
    await ingest(ctx.pool, l.via === "web" ? "web" : "calls", records, { now: NOW });
  }
  // Customers: call → customer → subscription → first service → invoice → payment.
  for (const k of w.customers ?? []) {
    ctx.n += 1;
    const n = ctx.n;
    const b = branchOk(k.branch);
    const sold = at(k.day, k.month ?? 10);
    // The case convention (FREEZE.md, designer note 4): a customer's `day` is the sale, the first
    // service and the payment date. First contact serviced 48 h after the sale, which moved day-29
    // and day-30 customers into the next month; fixed after first contact (evidence/ADJUDICATION.md).
    const done = new Date(sold.getTime() + hours(1));
    const phone = phoneFor(ctx, k.phoneKey);
    const platform = k.campaign ? ctx.platforms.get(k.campaign) : undefined;
    const customerId = 1000 + n;
    const subId = 2000 + n;
    const apptId = 3000 + n;
    const ticketId = 4000 + n;
    const invoice = k.invoiceAmount ?? "149.00";
    const paid = k.paidAmount ?? invoice;
    const completed = k.completed !== false;
    await ingest(ctx.pool, "calls", [call(`${ctx.c.id}-k${n}`, b, phone, new Date(sold.getTime() - hours(1)), sourceFor(platform), { campaign: k.campaign ? ctx.ext(k.campaign) : null })], { now: NOW });
    const records: RawRecord[] = [
      crm.customer(customerId, b, phone, sold),
      crm.subscription(subId, customerId, b, sold),
      crm.appointment(apptId, subId, customerId, b, "0", done, sold),
      ...(completed ? [crm.appointment(apptId, subId, customerId, b, "1", done, done)] : []),
    ];
    let paymentId: number | null = null;
    if (completed) {
      records.push(crm.ticket(ticketId, customerId, apptId, b, invoice, new Date(done.getTime() + hours(1))));
      if (Number(paid) > 0) {
        paymentId = 5000 + n;
        records.push(crm.payment(paymentId, customerId, ticketId, b, paid, new Date(done.getTime() + hours(2))));
      }
    }
    await ingest(ctx.pool, "crm", records, { now: NOW });
    ctx.customers.set(k.key, { id: customerId, ticketId, paymentId, branch: b });
  }
  for (const r of w.refunds ?? []) {
    const k = ctx.customers.get(r.customer);
    if (!k) throw new InvalidCase(`refund for unknown customer ${r.customer}`);
    if (k.paymentId === null) throw new InvalidCase(`customer ${r.customer} has no payment to refund`);
    ctx.n += 1;
    await ingest(ctx.pool, "crm", [crm.payment(9000 + ctx.n, k.id, k.ticketId, k.branch, `-${r.amount}`, at(r.day, r.month ?? 10), "1", String(k.paymentId))], { now: NOW });
  }
  for (const l of w.lineage ?? []) {
    const ids = await ctx.pool.query<{ e: string; id: string }>("select external_campaign_id as e, id from ad_campaigns where external_campaign_id = any($1)", [[ctx.ext(l.predecessor), ctx.ext(l.successor)]]);
    const id = (k: string) => Number(ids.rows.find((r) => r.e === ctx.ext(k))?.id);
    await ctx.pool.query("insert into campaign_lineage (predecessor_campaign_id, successor_campaign_id, effective_date, evidence, recorded_by, recorded_at) values ($1, $2, '2026-10-12', '{}', 'case', $3)", [id(l.predecessor), id(l.successor), NOW]);
  }
  for (const c of w.leadCorrections ?? []) {
    const { rows } = await ctx.pool.query<{ id: string }>("select id from leads where campaign_external_id = $1 and branch_id = $2 order by id limit $3", [ctx.ext(c.campaign), c.fromBranch, c.count]);
    for (const r of rows) await overrideLeadBranch(ctx.pool, { leadId: Number(r.id), branchId: branchOk(c.toBranch), actor: "ops", reason: "case correction", now: NOW });
  }
  // Feed freshness: every stream succeeded on day 30 unless the case says otherwise.
  const feeds = new Map((w.feeds ?? []).map((f) => [f.stream, f]));
  for (const [stream, source] of STREAMS) {
    const f = feeds.get(stream);
    const ok = at(f?.lastSuccessDay ?? 30);
    await ctx.pool.query("insert into ingestion_runs (source, stream, adapter_version, started_at, finished_at, status) values ($1, $2, 'eval', $3, $3, 'succeeded')", [source, stream, new Date(ok.getTime() - hours(8))]);
    if (f?.lastRunFailed) {
      await ctx.pool.query("insert into ingestion_runs (source, stream, adapter_version, started_at, finished_at, status, error) values ($1, $2, 'eval', $3, $3, 'failed', 'HTTP 503 from source')", [source, stream, new Date(NOW.getTime() - hours(5))]);
    }
  }
  await runReconcile(ctx.pool, NOW);
  await resolveIdentities(ctx.pool, NOW);
}

// ── claims mode: a scripted provider ─────────────────────────────────────────

type Block = Anthropic.Beta.Messages.BetaContentBlock;
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input, caller: { type: "direct" } }) as unknown as Block;

function scripted(c: Case): ModelClient {
  let turn = 0;
  return {
    async create(params) {
      turn += 1;
      let content: Block[];
      if (turn === 1) {
        content = (c.toolCalls ?? []).map((t, i) => toolUse(`t${i}`, t.tool, t.input));
      } else {
        // The evidence ids each scripted call returned, from the tool results sent back.
        const idsByCall = new Map<number, string[]>();
        const last = params.messages[params.messages.length - 1];
        for (const block of (Array.isArray(last.content) ? last.content : []) as Array<{ type: string; tool_use_id?: string; content?: unknown }>) {
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          const m = /"evidenceIds":\s*\[([^\]]*)\]/.exec(text);
          idsByCall.set(Number(block.tool_use_id.slice(1)), m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : []);
        }
        const observations = (c.candidates ?? []).map((cand) => ({
          text: cand.text,
          evidenceIds: [...new Set(cand.cites.flatMap((i) => idsByCall.get(i) ?? []))].slice(0, 25),
          status: cand.statedAs,
          ...(cand.statedAs === "hypothesis" ? { strength: "strong" } : {}),
        }));
        content = [toolUse("s", "submit_findings", {
          summary: `Candidate statements for case ${c.id}.`,
          observations,
          suspectedCause: null,
          confidence: { level: "medium", why: "Scripted candidates." },
          recommendedNextAction: "Review the statements.",
          expectedEffect: "None.",
          risks: [],
          missingInformation: [],
          proposals: [],
        })];
      }
      return {
        id: `msg_${turn}`, type: "message", role: "assistant", model: params.model, content,
        stop_reason: "tool_use", stop_sequence: null, stop_details: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as unknown as Anthropic.Beta.Messages.BetaMessage;
    },
  };
}

// ── scoring (SCORING.md) ─────────────────────────────────────────────────────

interface Finding { type: string; severity: "critical" | "high" | "medium" | "low" | "info"; detail: string }

function close(fact: { kind: string; value: number }, n: { kind: string; value: number; decimals: number; scale: number }): boolean {
  if (fact.kind !== n.kind) return false;
  const v = n.value * n.scale;
  return Math.abs(Math.abs(v) - Math.abs(fact.value)) <= 0.5 * 10 ** -n.decimals * n.scale + 1e-9;
}

async function runCase(pool: Pool, c: Case) {
  const ctx: Ctx = { pool, c, ext: (k) => `${c.id}-${k}`, platforms: new Map(), phones: new Map(), customers: new Map(), n: 0 };
  const started = Date.now();
  // No currency rule: each case's campaigns state their currency, and one that states none must
  // not be taken as USD (IR-8). Before currency rules existed, unstated spend was assumed USD.
  await freshDb(pool, { currencyRule: false });
  await buildWorld(ctx);
  const viewer: Viewer | undefined = (VIEWERS as Record<string, Viewer>)[c.ask.as];
  if (!viewer) throw new InvalidCase(`unknown actor ${c.ask.as}`);
  const findings: Finding[] = [];
  let outcome: "ANSWER" | "ABSTAIN" | "REFUSE";
  let result: Awaited<ReturnType<typeof runInvestigation>>["result"] | null = null;
  let steps: Array<{ tool: string | null; status: string }> = [];
  let error: string | null = null;
  const t0 = Date.now();
  try {
    // An omitted branch is a company-wide question (fixed after first contact, where three cases
    // failed with "Unknown branch undefined"; see evidence/ADJUDICATION.md).
    const out = await runInvestigation(pool, { question: c.ask.question, branchId: c.ask.branch ?? null, viewer, now: NOW, ...(c.mode === "claims" ? { client: scripted(c) } : { mode: "deterministic" as const }) });
    result = out.result;
    steps = out.steps.filter((s) => s.kind === "tool_call").map((s) => ({ tool: s.tool, status: s.status }));
    const supported = (result.claims ?? []).filter((x) => x.status === "SUPPORTED");
    outcome = result.refusal ? "REFUSE" : supported.length > 0 ? "ANSWER" : "ABSTAIN";
  } catch (e) {
    if (!(e instanceof ForbiddenError) && !(e instanceof Error && /cannot|not permitted|scope/i.test(e.message))) throw e;
    outcome = "REFUSE";
    error = e instanceof Error ? e.message : String(e);
  }
  const latencyMs = Date.now() - t0;
  const claims = result?.claims ?? [];
  const supported = claims.filter((x) => x.status === "SUPPORTED");
  const whole = JSON.stringify(result ?? {});
  const ex = c.expect ?? {};

  if (c.mode === "investigator") {
    if (ex.outcome && ex.outcome !== outcome) {
      const type = ex.outcome === "REFUSE" ? "authorization_failure" : ex.outcome === "ABSTAIN" && outcome === "ANSWER" ? "answered_instead_of_abstaining" : ex.outcome === "ANSWER" && outcome === "ABSTAIN" ? "unnecessary_abstention" : ex.outcome === "ANSWER" && outcome === "REFUSE" ? "unnecessary_refusal" : "wrong_outcome";
      findings.push({ type, severity: type === "authorization_failure" ? "critical" : type === "answered_instead_of_abstaining" ? "high" : c.severityIfWrong === "critical" || c.severityIfWrong === "high" ? "high" : "medium", detail: `expected ${ex.outcome}, got ${outcome}` });
    }
    for (const s of ex.mustNotMention ?? []) if (whole.includes(s)) findings.push({ type: "authorization_failure", severity: "critical", detail: `the result mentions "${s}"` });
    for (const f of ex.referenceFacts ?? []) {
      if (!f.mustBeStated) continue;
      const stated = supported.some((x) => claimNumbers(x.text).some((n) => close(f, n)));
      if (!stated) findings.push({ type: "missing_reference_fact", severity: "medium", detail: `${f.name} (${f.kind} ${f.value}) is in no SUPPORTED claim` });
    }
    for (const fb of ex.forbidden ?? []) {
      const re = new RegExp(fb.pattern, "i");
      const hit = supported.find((x) => re.test(x.text));
      if (hit) findings.push({ type: "forbidden_statement", severity: c.severityIfWrong === "critical" ? "critical" : "high", detail: `SUPPORTED: "${hit.text.slice(0, 160)}" matches /${fb.pattern}/ (${fb.why ?? ""})` });
    }
    // A SUPPORTED figure of a reference fact's kind that matches no reference fact (for review).
    const facts = ex.referenceFacts ?? [];
    for (const x of supported) {
      for (const n of claimNumbers(x.text)) {
        const sameKind = facts.filter((f) => f.kind === n.kind);
        if (sameKind.length > 0 && n.kind === "money" && !sameKind.some((f) => close(f, n))) {
          findings.push({ type: "unmatched_figure", severity: "info", detail: `${n.text} in "${x.text.slice(0, 120)}" matches no reference fact` });
        }
      }
    }
  } else {
    for (const cand of c.candidates ?? []) {
      const got = claims.find((x) => x.text === cand.text);
      const status = got?.status ?? "MISSING";
      const accepted = status === "SUPPORTED";
      const shouldAccept = cand.expect === "SUPPORTED";
      if (accepted && !shouldAccept) findings.push({ type: "accepted_wrong_candidate", severity: c.severityIfWrong === "critical" ? "critical" : "high", detail: `"${cand.text.slice(0, 160)}" expected ${cand.expect}, checker SUPPORTED` });
      else if (!accepted && shouldAccept) findings.push({ type: "rejected_correct_candidate", severity: "medium", detail: `"${cand.text.slice(0, 160)}" expected SUPPORTED, checker ${status}${got ? ` (${got.reason.slice(0, 120)})` : ""}` });
      else if (status !== cand.expect) findings.push({ type: "status_detail", severity: "info", detail: `"${cand.text.slice(0, 80)}" expected ${cand.expect}, got ${status}` });
    }
  }
  for (const s of steps) if (s.status === "error") findings.push({ type: "invalid_tool_call", severity: "low", detail: `${s.tool} returned an error` });
  return {
    id: c.id, category: c.category, mode: c.mode, severityIfWrong: c.severityIfWrong, outcome, error, latencyMs, millis: Date.now() - started,
    tools: steps.map((s) => `${s.tool}:${s.status}`),
    claims: claims.map((x) => ({
      status: x.status,
      type: x.type,
      text: x.text.slice(0, 300),
      numbers: x.numbers,
      reason: x.reason,
      // Compact proofs (after first contact): what each proposition was checked against.
      ...(x.proofs?.length ? { proofs: x.proofs.map((p) => ({ figure: p.figure, relation: p.relation, formula: p.formula, computed: p.computed, verdict: p.verdict, gap: p.gap, reason: p.reason.slice(0, 160) })) } : {}),
    })),
    candidates: (c.candidates ?? []).map((cand) => ({ text: cand.text, expect: cand.expect, got: claims.find((x) => x.text === cand.text)?.status ?? "MISSING" })),
    findings,
    pass: !findings.some((f) => f.severity !== "info"),
  };
}

async function main() {
  const [file, outFile] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!file || !outFile) throw new Error("usage: eval-investigator.ts <cases.json> <out.json> [--only ID,ID]");
  const onlyAt = process.argv.indexOf("--only");
  const only = onlyAt > 0 ? new Set(process.argv[onlyAt + 1].split(",")) : null;
  const doc = JSON.parse(readFileSync(file, "utf8")) as { version: string; author: string; cases: Case[] };
  const pool = createPool(process.env.EVAL_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54333/revenue_signal_eval");
  const results: Array<Record<string, unknown>> = [];
  try {
    for (const c of doc.cases) {
      if (only && !only.has(c.id)) continue;
      try {
        const r = await runCase(pool, c);
        results.push(r);
        const bad = r.findings.filter((f) => f.severity !== "info");
        console.log(`${r.pass ? "PASS" : "FAIL"} ${c.id.padEnd(7)} ${c.mode.padEnd(12)} ${r.outcome.padEnd(7)} ${bad.map((f) => `[${f.severity}] ${f.type}: ${f.detail}`).join(" | ").slice(0, 400)}`);
      } catch (e) {
        const invalid = e instanceof InvalidCase;
        results.push({ id: c.id, category: c.category, mode: c.mode, invalid, runnerError: !invalid, error: String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 1200) });
        console.log(`${invalid ? "INVALID" : "RUNNER-ERROR"} ${c.id} ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
      }
    }
  } finally {
    await pool.end();
  }
  writeFileSync(outFile, `${JSON.stringify({ cases: file, version: doc.version, author: doc.author, ranAt: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`wrote ${outFile}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
