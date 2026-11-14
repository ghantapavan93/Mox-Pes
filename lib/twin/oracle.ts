import type { Queryable } from "@/lib/db";
import type { Period } from "@/lib/period";

/**
 * The twin's INDEPENDENT reference: what the stored source records mean when the branches in
 * `onNewVersion` read calls with calls@1.2 and every other branch with calls@1.1.
 *
 * It shares no code with the code under test. It does not call a mapper, a projection, a view
 * or a metric query. It reads the stored call payloads (raw_events) and applies the call-tracking
 * contract itself (docs/agent-work/VENDOR-CONTRACTS.md C-3, C-4a): a call's latest observed
 * version decides; under calls@1.2 an outbound call, a call marked spam, or one marked "not a
 * lead" is not a lead. It then credits each new customer with a first touch by the written rule
 * (docs/metric-definitions.md; migration 0024's comment), in TypeScript, from the CRM tables, and
 * counts per branch what the scorecard counts.
 *
 * Inputs it takes from the product as given, because a calls-only change does not write them:
 * the CRM projections (customers, subscriptions, appointments), web and door-to-door leads, lead
 * branch overrides, identity-review decisions, channel taxonomy and the campaign mapping. Lead
 * ids are the product's surrogate keys, read only to name leads the same way.
 *
 * A raw event stored as quarantined never took effect (it waits for an explicit replay), so it
 * is not an observation here either.
 */

const DAY = 86_400_000;
const LOOKBACK_MS = 60 * DAY;
const AFTER_SALE_MS = 2 * 3_600_000;

export interface OracleLead {
  id: number | null;
  source: string;
  sourceLeadId: string;
  branchId: string;
  channelCode: string;
  evidence: string;
  campaign: string | null;
  /** The ad platforms the lead's own record names (namedPlatforms). */
  platforms: string[];
  phone: string | null;
  email: string | null;
  occurredAt: number;
}

export interface OracleBranch {
  prospects: number;
  acquired: number;
  paidAcquired: number;
  unknownAcquired: number;
}

export interface OracleResult {
  onNewVersion: string[];
  /** Calls the reference counts as leads, by call id. */
  countedCalls: Set<string>;
  /** Calls the reference says are not leads under calls@1.2, with the reason. */
  excludedCalls: Map<string, string>;
  /** Each new customer's credited lead id (null: no lead). */
  credit: Map<number, number | null>;
  /** Each new customer: their branch, the credited channel and lead branch, and whether they count in the period. */
  acquisitions: Map<number, { branchId: string | null; channelCode: string; leadBranchId: string | null; paid: boolean; inPeriod: boolean }>;
  /** Per branch, for the period. */
  branches: Map<string, OracleBranch>;
  /** Readings the reference could not make: a payload it cannot read, a lead id it cannot name. */
  notes: string[];
}

type Json = Record<string, unknown>;

const PHONE_TOKEN = "h:phone:";
function phoneToken(value: unknown): string | null {
  return typeof value === "string" && value.startsWith(PHONE_TOKEN) ? value.slice(PHONE_TOKEN.length) : null;
}

/** calls@1.2's three exclusions, read straight from the payload. */
export function notALeadReason(p: Json): string | null {
  if (p.direction === "outbound") return "NOT_INBOUND";
  if (p.spam === true) return "SPAM_CALL";
  if (p.lead_status === "not_a_lead") return "NOT_A_LEAD";
  return null;
}

/** The call-tracking source → channel and evidence (VENDOR-CONTRACTS C-1). */
function callChannel(source: unknown, gclid: unknown): { channelCode: string; evidence: string } {
  switch (source) {
    case "Google Ads":
      return { channelCode: "google_search", evidence: typeof gclid === "string" && gclid ? "click_id" : "tracking_number" };
    case "Google LSA":
      return { channelCode: "google_lsa", evidence: "lsa_lead" };
    case "Google My Business":
      return { channelCode: "organic_gbp", evidence: "tracking_number" };
    case "Facebook":
      return { channelCode: "meta", evidence: "tracking_number" };
    case "Bing":
      return { channelCode: "microsoft", evidence: "tracking_number" };
    default:
      return { channelCode: "unknown", evidence: "none" };
  }
}

const CALL_LABEL_PLATFORM: Record<string, string> = { "Google Ads": "google_ads", "Google LSA": "google_lsa", Facebook: "meta", Bing: "microsoft_ads" };
const UTM_SOURCE_PLATFORM: Record<string, string> = { google: "google_ads", facebook: "meta", meta: "meta", instagram: "meta", bing: "microsoft_ads" };
const PAID_UTM_MEDIUM = new Set(["cpc", "paid", "ppc", "paid_social"]);

/**
 * The ad platforms a lead's own record names (R-46): for a call, the call-tracking source label
 * and a Google click id; for a web form, a Google click id and a paid utm_source. Written out
 * here from the source contracts, not read from the product's view. A campaign id is matched only
 * when exactly one platform is named: a bare id names no campaign.
 */
export function namedPlatforms(source: string, p: Json): string[] {
  const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const named = new Set<string>();
  if (source === "calls") {
    const label = text(p.source);
    if (label !== null && CALL_LABEL_PLATFORM[label]) named.add(CALL_LABEL_PLATFORM[label]);
    if (text(p.gclid) !== null) named.add("google_ads");
  } else if (source === "web") {
    const q = (p.properties ?? {}) as Json;
    if (text(q.gclid) !== null) named.add("google_ads");
    const utm = text(q.utm_source)?.toLowerCase();
    if (utm && UTM_SOURCE_PLATFORM[utm] && PAID_UTM_MEDIUM.has(text(q.utm_medium)?.toLowerCase() ?? "")) named.add(UTM_SOURCE_PLATFORM[utm]);
  }
  return [...named].sort();
}

function push<K, V>(map: Map<K, V[]>, key: K | null, value: V) {
  if (key === null) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export async function referenceState(db: Queryable, args: { onNewVersion: readonly string[]; period: Pick<Period, "from" | "to"> }): Promise<OracleResult> {
  const on12 = new Set(args.onNewVersion);
  const notes: string[] = [];
  const t0 = args.period.from.getTime();
  const t1 = args.period.to.getTime();

  // Sequential reads: `db` may be one connection.
  const branchRows = await db.query<{ id: string; crm_office_id: number }>("select id, crm_office_id from branches");
  const branchOfOffice = new Map(branchRows.rows.map((b) => [b.crm_office_id, b.id]));
  const knownBranch = new Set(branchRows.rows.map((b) => b.id));
  const channels = new Map((await db.query<{ code: string; is_paid: boolean; cost_basis: string }>("select code, is_paid, cost_basis from channels")).rows.map((c) => [c.code, c]));
  const leadIds = new Map((await db.query<{ id: string; source: string; source_lead_id: string }>("select id, source, source_lead_id from leads")).rows.map((r) => [`${r.source}:${r.source_lead_id}`, Number(r.id)]));
  const overrides = new Map(
    (await db.query<{ subject_id: string; value: string }>("select subject_id, value from overrides where subject_type = 'lead' and field = 'branch_id'")).rows.map((o) => [Number(o.subject_id), o.value]),
  );

  // ── Calls: the latest observed version of each call decides ──
  const versions = await db.query<{ id: string; entity_id: string; payload: Json; last_delivered_at: Date }>(
    "select id, entity_id, payload, last_delivered_at from raw_events where source = 'calls' and entity = 'call' and status <> 'quarantined'",
  );
  const latest = new Map<string, { id: number; at: number; payload: Json }>();
  for (const v of versions.rows) {
    const at = v.last_delivered_at.getTime();
    const prev = latest.get(v.entity_id);
    if (!prev || at > prev.at || (at === prev.at && Number(v.id) > prev.id)) latest.set(v.entity_id, { id: Number(v.id), at, payload: v.payload });
  }
  const leads: OracleLead[] = [];
  const countedCalls = new Set<string>();
  const excludedCalls = new Map<string, string>();
  for (const [callId, v] of latest) {
    const p = v.payload;
    const branch = typeof p.branch_tag === "string" ? p.branch_tag : null;
    const caller = p.customer_phone_number ?? (p.caller as Json | undefined)?.number;
    const phone = phoneToken(caller);
    const start = typeof p.start_time === "string" ? Date.parse(p.start_time) : NaN;
    if (!branch || !knownBranch.has(branch) || !phone || Number.isNaN(start)) {
      notes.push(`call ${callId}: its latest stored version cannot be read as a lead (branch ${String(branch)}, caller ${phone ? "hashed" : "missing"})`);
      continue;
    }
    const reason = on12.has(branch) ? notALeadReason(p) : null;
    if (reason) {
      excludedCalls.set(callId, reason);
      continue;
    }
    countedCalls.add(callId);
    const id = leadIds.get(`calls:${callId}`) ?? null;
    if (id === null) notes.push(`call ${callId}: the reference counts it, but the product has no lead row for it`);
    const { channelCode, evidence } = callChannel(p.source, p.gclid);
    leads.push({
      id, source: "calls", sourceLeadId: callId, branchId: id !== null ? overrides.get(id) ?? branch : branch, channelCode, evidence,
      campaign: typeof p.campaign === "string" ? p.campaign : null, platforms: namedPlatforms("calls", p), phone, email: null, occurredAt: start,
    });
  }
  // Web forms and door-to-door sales: untouched by a calls change, read as projected. The platform
  // their campaign id belongs to is read from their own stored payload (R-46).
  const others = await db.query<{ id: string; source: string; source_lead_id: string; branch_id: string; channel_code: string; attribution_evidence: string; campaign_external_id: string | null; phone_hash: string | null; email_hash: string | null; occurred_at: Date; payload: Json }>(
    `select l.id, l.source, l.source_lead_id, l.branch_id, l.channel_code, l.attribution_evidence, l.campaign_external_id, l.phone_hash, l.email_hash, l.occurred_at, re.payload
     from leads l join raw_events re on re.id = l.raw_event_id where l.source <> 'calls' and l.excluded_code is null`,
  );
  for (const l of others.rows) {
    const id = Number(l.id);
    leads.push({
      id, source: l.source, sourceLeadId: l.source_lead_id, branchId: overrides.get(id) ?? l.branch_id, channelCode: l.channel_code, evidence: l.attribution_evidence,
      campaign: l.campaign_external_id, platforms: namedPlatforms(l.source, l.payload), phone: l.phone_hash, email: l.email_hash, occurredAt: l.occurred_at.getTime(),
    });
  }

  // ── New customers: first subscription, its office's branch, its initial service ──
  const customers = await db.query<{ crm_customer_id: string; phone_hash: string | null; email_hash: string | null }>("select crm_customer_id, phone_hash, email_hash from crm_customers");
  const subs = await db.query<{ crm_subscription_id: string; crm_customer_id: string; office_id: number; sold_at: Date }>("select crm_subscription_id, crm_customer_id, office_id, sold_at from crm_subscriptions");
  const firstSale = new Map<number, { sub: number; soldAt: number; branchId: string | null }>();
  for (const s of subs.rows) {
    const c = Number(s.crm_customer_id);
    const cand = { sub: Number(s.crm_subscription_id), soldAt: s.sold_at.getTime(), branchId: branchOfOffice.get(s.office_id) ?? null };
    const prev = firstSale.get(c);
    if (!prev || cand.soldAt < prev.soldAt || (cand.soldAt === prev.soldAt && cand.sub < prev.sub)) firstSale.set(c, cand);
  }
  const initials = await db.query<{ crm_subscription_id: string; status: string; scheduled_for: Date | null; completed_at: Date | null }>(
    "select crm_subscription_id, status, scheduled_for, completed_at from crm_appointments where kind = 'initial'",
  );
  // A rescheduled initial is superseded by its replacement: the live one, latest scheduled.
  const initial = new Map<number, { status: string; completedAt: number | null; rescheduled: boolean; scheduled: number }>();
  for (const a of initials.rows) {
    const sub = Number(a.crm_subscription_id);
    const cand = { status: a.status, completedAt: a.completed_at?.getTime() ?? null, rescheduled: a.status === "rescheduled", scheduled: a.scheduled_for?.getTime() ?? -Infinity };
    const prev = initial.get(sub);
    if (!prev || (prev.rescheduled && !cand.rescheduled) || (prev.rescheduled === cand.rescheduled && cand.scheduled > prev.scheduled)) initial.set(sub, cand);
  }

  // A reviewer's decision per (lead, customer): the latest one counts (a pair can be re-opened and
  // decided again; identity_conflicts keeps every decided row as history). Read in id order, so a
  // later decision overwrites an earlier one.
  const reviews = new Map<number, Map<number, string>>();
  for (const k of (await db.query<{ lead_id: string; crm_customer_id: string; status: string }>("select lead_id, crm_customer_id, status from identity_conflicts where status in ('accepted', 'rejected') order by id")).rows) {
    const byCustomer = reviews.get(Number(k.lead_id)) ?? new Map<number, string>();
    byCustomer.set(Number(k.crm_customer_id), k.status);
    reviews.set(Number(k.lead_id), byCustomer);
  }
  // Campaigns are keyed by platform and id: two platforms can use one id (R-46).
  const campaignKey = (platform: string, ext: string) => `${platform}:${ext}`;
  const unmapped = new Set(
    (await db.query<{ platform: string; ext: string }>("select platform, external_campaign_id as ext from ad_campaigns c where not exists (select 1 from campaign_branch_map m where m.campaign_id = c.id)")).rows.map((r) => campaignKey(r.platform, r.ext)),
  );
  // A campaign whose every spend day was held at intake: none of its cost is in any figure.
  const held = new Set(
    (await db.query<{ platform: string; ext: string }>(
      `select distinct re.payload ->> 'platform' as platform, re.payload ->> 'campaignId' as ext from raw_events re
       where re.source = 'ads' and re.status in ('excluded', 'quarantined') and re.payload ->> 'campaignId' is not null
         and not exists (select 1 from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id
                         where c.platform = re.payload ->> 'platform' and c.external_campaign_id = re.payload ->> 'campaignId')`,
    )).rows.map((r) => campaignKey(r.platform, r.ext)),
  );

  // ── Credit: the first touch with evidence in the customer's 60-day lookback; a lead credits one customer ──
  const custPhone = new Map<string, number[]>();
  const custEmail = new Map<string, number[]>();
  const cust = new Map<number, { phone: string | null; email: string | null }>();
  for (const c of customers.rows) {
    const id = Number(c.crm_customer_id);
    cust.set(id, { phone: c.phone_hash, email: c.email_hash });
    if (firstSale.has(id)) {
      push(custPhone, c.phone_hash, id);
      push(custEmail, c.email_hash, id);
    }
  }
  const leadPhone = new Map<string, OracleLead[]>();
  const leadEmail = new Map<string, OracleLead[]>();
  for (const l of leads) {
    push(leadPhone, l.phone, l);
    push(leadEmail, l.email, l);
  }
  const inWindow = (l: OracleLead, soldAt: number) => l.occurredAt >= soldAt - LOOKBACK_MS && l.occurredAt <= soldAt + AFTER_SALE_MS;
  const review = (l: OracleLead, customer: number) => (l.id === null ? undefined : reviews.get(l.id)?.get(customer));
  const acceptedElsewhere = (l: OracleLead, customer: number) => {
    if (l.id === null) return false;
    for (const [other, status] of reviews.get(l.id) ?? []) if (other !== customer && status === "accepted") return true;
    return false;
  };
  /** Another customer this lead matches who made a sale it preceded first (phone, then email). */
  const ownedByEarlierSale = (l: OracleLead, customer: number, soldAt: number) => {
    const earlier = (others: number[] | undefined) =>
      (others ?? []).some((o) => {
        if (o === customer) return false;
        const s = firstSale.get(o)!;
        if (!inWindow(l, s.soldAt)) return false;
        if (!(s.soldAt < soldAt || (s.soldAt === soldAt && o < customer))) return false;
        return review(l, o) !== "rejected";
      });
    return (l.phone !== null && earlier(custPhone.get(l.phone))) || (l.email !== null && earlier(custEmail.get(l.email)));
  };

  const credit = new Map<number, number | null>();
  const acquisitions: OracleResult["acquisitions"] = new Map();
  const branches = new Map<string, OracleBranch>();
  const row = (b: string) => {
    let r = branches.get(b);
    if (!r) branches.set(b, (r = { prospects: 0, acquired: 0, paidAcquired: 0, unknownAcquired: 0 }));
    return r;
  };
  for (const [customer, sale] of firstSale) {
    const c = cust.get(customer);
    if (!c) continue;
    const candidates = [...(c.phone ? leadPhone.get(c.phone) ?? [] : []), ...(c.email ? leadEmail.get(c.email) ?? [] : [])].filter((l) => inWindow(l, sale.soldAt));
    let best: OracleLead | null = null;
    for (const l of candidates) {
      const r = review(l, customer);
      if (r === "rejected") continue;
      if (r !== "accepted" && (acceptedElsewhere(l, customer) || ownedByEarlierSale(l, customer, sale.soldAt))) continue;
      const key = (x: OracleLead) => [x.evidence === "none" ? 1 : 0, x.occurredAt, x.id ?? Number.MAX_SAFE_INTEGER] as const;
      if (!best) best = l;
      else {
        const [a, b] = [key(l), key(best)];
        if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) best = l;
      }
    }
    credit.set(customer, best?.id ?? null);
    const first = initial.get(sale.sub);
    const channel = best?.channelCode ?? "unknown";
    const ch = channels.get(channel);
    // The credited lead's campaign: its id on the one platform its record names; none otherwise,
    // and then, as with no campaign id, no campaign's mapping or held spend applies.
    const campaign = best && best.campaign !== null && best.platforms.length === 1 ? campaignKey(best.platforms[0], best.campaign) : null;
    const paid = Boolean(ch?.is_paid && ch.cost_basis === "media" && !(campaign !== null && (unmapped.has(campaign) || held.has(campaign))));
    const inPeriod = Boolean(sale.branchId && first?.status === "completed" && first.completedAt !== null && first.completedAt >= t0 && first.completedAt < t1);
    acquisitions.set(customer, { branchId: sale.branchId, channelCode: channel, leadBranchId: best?.branchId ?? null, paid, inPeriod });
    if (!inPeriod) continue;
    const r = row(sale.branchId!);
    r.acquired += 1;
    if (channel === "unknown") r.unknownAcquired += 1;
    if (paid) r.paidAcquired += 1;
  }

  // Prospects: distinct people (phone, else email) with a counted lead in the period, by the lead's branch.
  const prospectKeys = new Map<string, Set<string>>();
  for (const l of leads) {
    if (l.occurredAt < t0 || l.occurredAt >= t1) continue;
    const key = l.phone ?? l.email;
    if (key === null) continue;
    const set = prospectKeys.get(l.branchId) ?? new Set<string>();
    set.add(key);
    prospectKeys.set(l.branchId, set);
  }
  for (const [b, set] of prospectKeys) row(b).prospects = set.size;

  return { onNewVersion: [...on12].sort(), countedCalls, excludedCalls, credit, acquisitions, branches, notes };
}
