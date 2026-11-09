import { instantToWallTime } from "@/lib/primitives";
import { BRANCHES, BRANCH_BY_ID, SCENARIO, type Branch, type ChannelCode } from "@/lib/reference";
import { Rng } from "./random";

/**
 * The synthetic business. Generates source-system records (CRM, call tracking, website,
 * D2D app, ad platforms) exactly as each source would expose them, with the time each
 * version becomes visible to its API. Nothing here writes to the database: the seed feeds
 * these records through the real ingestion pipeline.
 *
 * Parameters come from research/07-revenue-metrics.md §2.3 (industry ranges, HYPOTHESIS
 * labels there). They are synthetic and say nothing about any real company.
 */

export const PERIOD_START = new Date("2026-09-01T00:00:00Z");
/** The simulation runs two weeks before the reporting period so September starts with a
 *  realistic pipeline (leads already in flight), not an empty one. */
export const SIM_START = new Date("2026-08-18T00:00:00Z");
export const PERIOD_END = new Date("2026-10-31T00:00:00Z");
/** The frozen "now" of the demo. */
export const DEMO_NOW = new Date("2026-10-31T13:00:00Z");
/** When calls@1.1 (the fix for the call-feed change) was deployed. */
export const CALLS_FIX_DEPLOYED_AT = new Date("2026-10-30T20:00:00Z");
/** ads@1.1 (campaign-type aware) ships after the last scheduled run: all history needs a re-map. */
export const ADS_FIX_DEPLOYED_AT = DEMO_NOW;
/** The CRM ticket API returned 503 for this daily run; the next run must recover it. */
export const TICKET_OUTAGE_RUN = new Date("2026-10-09T08:00:00Z");

const DAY = 86_400_000;
const HOUR = 3_600_000;

export const PARAMS = {
  seed: 20261031,
  dailyProspectsPerBranch: 6.5,
  baseCustomersPerBranch: 140,
  /** prospect → sold, by first channel */
  closeRate: { google_search: 0.42, google_lsa: 0.5, meta: 0.25, microsoft: 0.35, organic_gbp: 0.45, unknown: 0.4, d2d: 1 } as Record<SimulatedChannel, number>,
  /** target cost per lead (cents) by paid channel */
  cplCents: { google_search: 13_000, google_lsa: 7_500, meta: 6_000, microsoft: 11_000 } as Partial<Record<SimulatedChannel, number>>,
  duplicateLeadRate: 0.18,
  existingCustomerProspectRate: 0.05,
  initialCompletedRate: 0.88,
  initialCancelledRate: 0.06,
  paidOnTimeRate: 0.93,
  failedThenPaidRate: 0.05,
  refundRate: 0.02,
  d2dPaidTouchRate: 0.06,
  phoneMismatchRate: 0.03,
} as const;

export interface SourceRecordVersion {
  stream: string;
  entity: string;
  visibleAt: number;
  payload: Record<string, unknown>;
}

export interface CampaignSpec {
  platform: "google_ads" | "google_lsa" | "microsoft_ads" | "meta";
  accountId: string;
  campaignId: string;
  name: string;
  branchId: string;
  channel: SimulatedChannel;
  launchedAt: number;
  /** How the platform types it in reporting (Google Ads only). */
  campaignType?: "SEARCH" | "LOCAL_SERVICES" | "PERFORMANCE_MAX";
  localServicesEnabled?: boolean;
  mapped: boolean;
}

export interface World {
  records: SourceRecordVersion[];
  campaigns: CampaignSpec[];
  territories: Array<{ zip: string; branchId: string }>;
  /** Ground truth the tests assert against. */
  truth: {
    driftedCalls: number;
    realignedZips: string[];
  };
}

interface Person {
  phone: string;
  email: string | null;
  zip: string;
}

const HEARD_ABOUT = [
  "my neighbor uses you guys", "saw your truck in the neighborhood", "google", "found you online", "facebook",
  "got a door hanger", "a friend referred me", "Nextdoor", "don't remember", "I think a postcard", "", "saw a sign",
];

/**
 * Channels the synthetic world generates records for. Organic search and sponsorships are in
 * the channel taxonomy but the world never generated them: adding them here would change every
 * random draw below (rng.pick over these labels) and so every scenario number.
 */
type SimulatedChannel = Exclude<ChannelCode, "organic_search" | "sponsorship">;

const SOURCE_LABEL: Record<SimulatedChannel, string> = {
  google_search: "Google Ads", google_lsa: "Google LSA", meta: "Facebook", microsoft: "Bing",
  organic_gbp: "Google Maps", d2d: "Door to Door", unknown: "Other",
};

export function generateWorld(): World {
  const rng = new Rng(PARAMS.seed);
  const records: SourceRecordVersion[] = [];
  const push = (stream: string, entity: string, visibleAt: number, payload: Record<string, unknown>) =>
    records.push({ stream, entity, visibleAt, payload });

  // ── Identities ──────────────────────────────────────────────────────────────
  // Phones use the NANP fictional range 555-0100…0199; emails use example.com.
  let personSeq = 0;
  const usedPhones = new Set<string>();
  const newPerson = (zip: string, withEmail: boolean): Person => {
    let phone: string;
    do {
      phone = `${rng.int(201, 989)}5550${rng.int(100, 199)}`;
    } while (usedPhones.has(phone));
    usedPhones.add(phone);
    personSeq++;
    return { phone, email: withEmail ? `person${personSeq}@example.com` : null, zip };
  };
  const formatPhone = (digits: string): string => {
    const a = digits.slice(0, 3), b = digits.slice(3, 6), c = digits.slice(6);
    return rng.pick([`(${a}) ${b}-${c}`, `${a}-${b}-${c}`, `+1${digits}`, digits]);
  };

  // ── Territories ─────────────────────────────────────────────────────────────
  const zipsByBranch = new Map<string, string[]>();
  const territories: World["territories"] = [];
  BRANCHES.forEach((b, i) => {
    const zips = Array.from({ length: 24 }, (_, k) => String(10000 + i * 1000 + k * 7).padStart(5, "0"));
    zipsByBranch.set(b.id, zips);
  });
  // A realignment moved six zips from B06 to B07. The CRM services them from B07; the
  // website's zip lookup (and B06's tracking numbers on those pages) still say B06.
  const fromZips = zipsByBranch.get(SCENARIO.realignedFromBranch)!;
  const realigned = fromZips.splice(fromZips.length - 6, 6);
  zipsByBranch.get(SCENARIO.realignedToBranch)!.push(...realigned);
  for (const [branchId, zips] of zipsByBranch) for (const zip of zips) territories.push({ zip, branchId });
  const realignedSet = new Set(realigned);

  // ── Campaigns ───────────────────────────────────────────────────────────────
  const campaigns: CampaignSpec[] = [];
  const campaignFor = new Map<string, CampaignSpec>();
  BRANCHES.forEach((b, i) => {
    const specs: CampaignSpec[] = [
      { platform: "google_ads", accountId: `GA-${b.region.toUpperCase()}`, campaignId: `gs-${b.id}`, name: `${b.id} ${b.name} | Search | Pest`, branchId: b.id, channel: "google_search", launchedAt: 0, campaignType: "SEARCH", mapped: true },
      { platform: "google_lsa", accountId: `LSA-${b.id}`, campaignId: `lsa-${b.id}`, name: `${b.id} ${b.name} | Local Services`, branchId: b.id, channel: "google_lsa", launchedAt: 0, campaignType: "LOCAL_SERVICES", mapped: true },
      { platform: "meta", accountId: "META-1", campaignId: `fb-${b.id}`, name: `${b.id} ${b.name} | Prospecting`, branchId: b.id, channel: "meta", launchedAt: 0, mapped: true },
    ];
    if (i % 2 === 0) specs.push({ platform: "microsoft_ads", accountId: "MS-1", campaignId: `ms-${b.id}`, name: `${b.id} ${b.name} | Bing Search`, branchId: b.id, channel: "microsoft", launchedAt: 0, mapped: true });
    for (const s of specs) {
      campaigns.push(s);
      campaignFor.set(`${b.id}:${s.channel}`, s);
    }
  });
  // A new LSA campaign for an expansion area, launched without a branch mapping.
  const expansion: CampaignSpec = {
    platform: "google_lsa", accountId: `LSA-${SCENARIO.unmappedSpendBranch}-X`, campaignId: `lsa-${SCENARIO.unmappedSpendBranch}-x`,
    name: `${SCENARIO.unmappedSpendBranch} | Local Services | Expansion`, branchId: SCENARIO.unmappedSpendBranch,
    channel: "google_lsa", launchedAt: Date.parse("2026-10-05T00:00:00Z"), mapped: false,
  };
  campaigns.push(expansion);

  // ChangeGuard (HYPOTHETICAL): Google migrates one branch's LSA campaign into Performance Max
  // with pay-per-lead goals. Same account (an LSA account id is its Google Ads customer id);
  // a new campaign, because a campaign's channel type cannot change. Marketing ops maps it to
  // the branch the day it appears; nobody re-checks how its spend is classified.
  const migrationAt = Date.parse(SCENARIO.lsaMigrationAt);
  const migratedFrom = campaignFor.get(`${SCENARIO.lsaMigrationBranch}:google_lsa`)!;
  const migratedTo: CampaignSpec = {
    platform: "google_ads", accountId: migratedFrom.accountId, campaignId: `pmax-lsa-${SCENARIO.lsaMigrationBranch}`,
    name: `${migratedFrom.name} (Performance Max, pay-per-lead)`, branchId: SCENARIO.lsaMigrationBranch,
    channel: "google_lsa", launchedAt: migrationAt, campaignType: "PERFORMANCE_MAX", localServicesEnabled: true, mapped: true,
  };
  campaigns.push(migratedTo);
  /** The campaign a lead for `branch:channel` at `at` belongs to. */
  const campaignAt = (branchId: string, channel: SimulatedChannel, at: number) => {
    const spec = campaignFor.get(`${branchId}:${channel}`);
    return spec === migratedFrom && at >= migrationAt ? migratedTo : spec;
  };

  // ── CRM id sequences ────────────────────────────────────────────────────────
  let customerSeq = 400_000, subscriptionSeq = 700_000, appointmentSeq = 2_000_000, ticketSeq = 3_000_000, paymentSeq = 5_000_000;
  let leadSeq = 0;

  const crm = (b: Branch) => {
    const tz = b.timezone;
    const wall = (t: number) => instantToWallTime(new Date(t), tz);
    const office = String(b.crmOfficeId);
    return {
      customer(id: number, person: Person, phoneOverride: string | null, source: string, addedAt: number) {
        push("crm.customer", "customer", addedAt, {
          customerID: String(id), officeID: office, phone1: formatPhone(phoneOverride ?? person.phone), email: person.email,
          zip: person.zip, source, dateAdded: wall(addedAt), dateUpdated: wall(addedAt),
        });
      },
      subscription(v: { id: number; customerId: number; soldBy: string; source: string; valueCents: number; soldAt: number; cancelledAt: number | null; updatedAt: number }) {
        push("crm.subscription", "subscription", v.updatedAt, {
          subscriptionID: String(v.id), customerID: String(v.customerId), officeID: office, serviceType: "General Pest",
          soldBy: v.soldBy, source: v.source, contractValue: (v.valueCents / 100).toFixed(2), active: v.cancelledAt ? "0" : "1",
          dateAdded: wall(v.soldAt), dateCancelled: v.cancelledAt ? wall(v.cancelledAt) : "0000-00-00 00:00:00", dateUpdated: wall(v.updatedAt),
        });
      },
      appointment(v: { id: number; subscriptionId: number; customerId: number; initial: boolean; status: string; scheduledAt: number; completedAt: number | null; updatedAt: number }) {
        const [date, time] = wall(v.scheduledAt).split(" ");
        push("crm.appointment", "appointment", v.updatedAt, {
          appointmentID: String(v.id), subscriptionID: String(v.subscriptionId), customerID: String(v.customerId), officeID: office,
          salesAnchor: v.initial ? "1" : "0", status: v.status, date, start: time,
          dateCompleted: v.completedAt ? wall(v.completedAt) : "0000-00-00 00:00:00", dateUpdated: wall(v.updatedAt),
        });
      },
      ticket(v: { id: number; customerId: number; appointmentId: number; initial: boolean; totalCents: number; createdAt: number; updatedAt: number }) {
        push("crm.ticket", "ticket", v.updatedAt, {
          ticketID: String(v.id), customerID: String(v.customerId), appointmentID: String(v.appointmentId), officeID: office,
          templateType: v.initial ? "I" : "R", total: (v.totalCents / 100).toFixed(2), dateCreated: wall(v.createdAt), dateUpdated: wall(v.updatedAt),
        });
      },
      payment(v: { id: number; customerId: number; ticketId: number; amountCents: number; originalId: number | null; status: "0" | "1"; at: number }) {
        push("crm.payment", "payment", v.at, {
          paymentID: String(v.id), customerID: String(v.customerId), officeID: office, ticketID: String(v.ticketId),
          amount: (v.amountCents / 100).toFixed(2), originalPaymentID: v.originalId ? String(v.originalId) : "0", status: v.status, date: wall(v.at),
        });
      },
    };
  };

  /** Bill a completed service: ticket, then payment(s), possibly a refund. */
  const bill = (b: Branch, customerId: number, appointmentId: number, initial: boolean, totalCents: number, completedAt: number) => {
    const c = crm(b);
    const ticketId = ++ticketSeq;
    const createdAt = completedAt + rng.int(10, 120) * 60_000;
    c.ticket({ id: ticketId, customerId, appointmentId, initial, totalCents, createdAt, updatedAt: createdAt });
    if (totalCents === 0) return;
    const roll = rng.next();
    let paidAt: number | null = null;
    if (roll < PARAMS.paidOnTimeRate) {
      paidAt = createdAt + rng.int(0, 7 * 24) * HOUR;
    } else if (roll < PARAMS.paidOnTimeRate + PARAMS.failedThenPaidRate) {
      const failedAt = createdAt + rng.int(0, 48) * HOUR;
      c.payment({ id: ++paymentSeq, customerId, ticketId, amountCents: totalCents, originalId: null, status: "0", at: failedAt });
      paidAt = failedAt + rng.int(2, 10) * DAY;
    }
    if (paidAt === null || paidAt >= DEMO_NOW.getTime()) return;
    const paymentId = ++paymentSeq;
    c.payment({ id: paymentId, customerId, ticketId, amountCents: totalCents, originalId: null, status: "1", at: paidAt });
    if (rng.chance(PARAMS.refundRate)) {
      const refundAt = paidAt + rng.int(3, 20) * DAY;
      if (refundAt < DEMO_NOW.getTime()) {
        c.payment({ id: ++paymentSeq, customerId, ticketId, amountCents: -totalCents, originalId: paymentId, status: "1", at: refundAt });
      }
    }
  };

  const serviceTime = (dayStart: number, b: Branch) => {
    // 08:00–16:00 local, expressed as an instant (approximate local offset is enough here).
    const offsetHours = { West: 7, Southwest: 7, Mountain: 6, Central: 5, East: 4 }[b.region];
    return dayStart + (8 + offsetHours) * HOUR + rng.int(0, 8 * 60) * 60_000;
  };

  /** Recurring services for a customer from `firstAt`, every ~90 days, until the period ends. */
  const recurring = (b: Branch, customerId: number, subscriptionId: number, perVisitCents: number, firstAt: number) => {
    const c = crm(b);
    for (let at = firstAt; at < DEMO_NOW.getTime(); at += rng.int(85, 95) * DAY) {
      const id = ++appointmentSeq;
      const createdAt = at - 14 * DAY;
      c.appointment({ id, subscriptionId, customerId, initial: false, status: "0", scheduledAt: at, completedAt: null, updatedAt: createdAt });
      if (rng.chance(0.95)) {
        const done = at + rng.int(20, 90) * 60_000;
        if (done < DEMO_NOW.getTime()) {
          c.appointment({ id, subscriptionId, customerId, initial: false, status: "1", scheduledAt: at, completedAt: done, updatedAt: done });
          bill(b, customerId, id, false, perVisitCents, done);
        }
      } else {
        c.appointment({ id, subscriptionId, customerId, initial: false, status: "-1", scheduledAt: at, completedAt: null, updatedAt: at - DAY });
      }
    }
  };

  const planValue = (b: Branch) => {
    const regional = 0.9 + ((b.crmOfficeId * 37) % 21) / 100; // ±10% by branch, stable
    const quarterly = rng.chance(0.75);
    const perVisit = Math.round((quarterly ? rng.between(98, 178) : rng.between(60, 120)) * regional) * 100;
    return { perVisitCents: perVisit, annualCents: perVisit * (quarterly ? 4 : 6) };
  };

  // ── Existing customer base (backfill) ───────────────────────────────────────
  const baseByBranch = new Map<string, Array<{ customerId: number; person: Person }>>();
  for (const b of BRANCHES) {
    const c = crm(b);
    const base: Array<{ customerId: number; person: Person }> = [];
    const n = Math.round(PARAMS.baseCustomersPerBranch * b.size);
    for (let k = 0; k < n; k++) {
      const person = newPerson(rng.pick(zipsByBranch.get(b.id)!), rng.chance(0.6));
      const customerId = ++customerSeq;
      const subscriptionId = ++subscriptionSeq;
      const soldAt = Date.parse("2025-01-01T00:00:00Z") + rng.int(0, 600) * DAY;
      const { perVisitCents, annualCents } = planValue(b);
      c.customer(customerId, person, null, rng.pick(Object.values(SOURCE_LABEL)), soldAt);
      c.subscription({ id: subscriptionId, customerId, soldBy: rng.chance(0.4) ? String(rng.int(1000, 2600)) : "0", source: rng.pick(Object.values(SOURCE_LABEL)), valueCents: annualCents, soldAt, cancelledAt: null, updatedAt: soldAt });
      recurring(b, customerId, subscriptionId, perVisitCents, SIM_START.getTime() + rng.int(0, 89) * DAY + 15 * HOUR);
      base.push({ customerId, person });
    }
    baseByBranch.set(b.id, base);
  }

  // ── Leads and acquisitions ──────────────────────────────────────────────────
  let driftedCalls = 0;
  const callPayload = (b: Branch, leadBranch: string, at: number, person: Person, source: string, gclid: string | null, campaign: string | null, note: string | null) => {
    const id = `CAL${String(++leadSeq).padStart(8, "0")}`;
    const drift = leadBranch === SCENARIO.callFeedDriftBranch && at >= Date.parse(SCENARIO.callFeedDriftFrom);
    const base: Record<string, unknown> = {
      id, branch_tag: leadBranch, start_time: new Date(at).toISOString(), tracking_phone_number: `+1${rng.int(201, 989)}5550199`,
      source, gclid, campaign, agent_note: note,
    };
    if (drift) {
      driftedCalls++;
      base.caller = { number: `+1${person.phone}` };
    } else {
      base.customer_phone_number = `+1${person.phone}`;
    }
    push("calls", "call", at + rng.int(1, 12) * 60_000, base);
  };
  const webPayload = (leadBranch: string, at: number, person: Person, form: string, utm: { source: string | null; medium: string | null; campaign: string | null }, gclid: string | null, message: string | null) => {
    push("web", "lead", at, {
      messageId: `msg-${String(++leadSeq).padStart(8, "0")}`, timestamp: new Date(at).toISOString(),
      properties: {
        form, branch_id: leadBranch, zip: person.zip, phone: formatPhone(person.phone), email: person.email,
        utm_source: utm.source, utm_medium: utm.medium, utm_campaign: utm.campaign, gclid, message,
      },
    });
  };

  /** Emits the lead record(s) a prospect produces on first contact via `channel`. */
  const emitLead = (b: Branch, leadBranch: string, channel: SimulatedChannel, at: number, person: Person) => {
    const camp = campaignAt(leadBranch, channel, at)?.campaignId ?? null;
    const gclid = () => `Cj0K${rng.int(100000, 999999)}${rng.int(100000, 999999)}`;
    switch (channel) {
      case "google_search":
        if (rng.chance(0.55)) webPayload(leadBranch, at, person, "quote", { source: "google", medium: "cpc", campaign: camp }, rng.chance(0.9) ? gclid() : null, null);
        else callPayload(b, leadBranch, at, person, "Google Ads", rng.chance(0.6) ? gclid() : null, camp, null);
        break;
      case "google_lsa": {
        const lsaCamp = leadBranch === SCENARIO.unmappedSpendBranch && at >= expansion.launchedAt && rng.chance(0.35) ? expansion.campaignId : camp;
        callPayload(b, leadBranch, at, person, "Google LSA", null, lsaCamp, null);
        break;
      }
      case "meta":
        if (rng.chance(0.7)) webPayload(leadBranch, at, person, "quote", { source: "facebook", medium: "paid_social", campaign: camp }, null, null);
        else callPayload(b, leadBranch, at, person, "Facebook", null, camp, null);
        break;
      case "microsoft":
        if (rng.chance(0.8)) webPayload(leadBranch, at, person, "quote", { source: "bing", medium: "cpc", campaign: camp }, null, null);
        else callPayload(b, leadBranch, at, person, "Bing", null, camp, null);
        break;
      case "organic_gbp":
        callPayload(b, leadBranch, at, person, "Google My Business", null, null, null);
        break;
      case "unknown":
        if (rng.chance(0.6)) callPayload(b, leadBranch, at, person, "Direct", null, null, rng.pick(HEARD_ABOUT) || null);
        else webPayload(leadBranch, at, person, "contact", { source: null, medium: null, campaign: null }, null, rng.pick(HEARD_ABOUT) || null);
        break;
      case "d2d":
        push("d2d", "sale", at + rng.int(1, 6) * HOUR, {
          saleId: `S-${String(++leadSeq).padStart(8, "0")}`, repId: `rep-${rng.int(1, 1600)}`, branchId: leadBranch,
          signedAt: new Date(at).toISOString(), customer: { phone: formatPhone(person.phone), email: person.email, zip: person.zip },
        });
        break;
    }
  };

  const paidLeadsByCampaignDay = new Map<string, number>();
  const countPaid = (b: string, channel: SimulatedChannel, at: number, n = 1) => {
    if (!["google_search", "google_lsa", "meta", "microsoft"].includes(channel)) return;
    const camp = campaignAt(b, channel, at);
    if (!camp) return;
    const key = `${camp.campaignId}:${new Date(at).toISOString().slice(0, 10)}`;
    paidLeadsByCampaignDay.set(key, (paidLeadsByCampaignDay.get(key) ?? 0) + n);
  };

  const days = Math.round((PERIOD_END.getTime() - SIM_START.getTime()) / DAY);
  for (let d = 0; d < days; d++) {
    const dayStart = SIM_START.getTime() + d * DAY;
    const season = 1.1 - 0.25 * (d / days);
    const d2dShare = 0.2 - 0.12 * (d / days);
    for (const b of BRANCHES) {
      const n = rng.poisson(PARAMS.dailyProspectsPerBranch * b.size * season);
      for (let k = 0; k < n; k++) {
        const at = dayStart + rng.int(13 * 60, 26 * 60) * 60_000; // business hours across zones
        if (at >= PERIOD_END.getTime()) continue;
        const channel = rng.weighted<SimulatedChannel>([
          ["google_search", 0.25], ["google_lsa", 0.15], ["meta", 0.08], ["microsoft", b.crmOfficeId % 2 === 1 ? 0.04 : 0],
          ["organic_gbp", 0.12], ["unknown", 0.14], ["d2d", d2dShare],
        ]);

        // An existing customer reaching out again (often for a new service).
        if (channel !== "d2d" && rng.chance(PARAMS.existingCustomerProspectRate)) {
          const existing = rng.pick(baseByBranch.get(b.id)!);
          emitLead(b, b.id, channel, at, existing.person);
          countPaid(b.id, channel, at);
          if (rng.chance(0.5)) {
            const soldAt = at + rng.int(1, 48) * HOUR;
            if (soldAt < DEMO_NOW.getTime()) {
              const { annualCents } = planValue(b);
              crm(b).subscription({ id: ++subscriptionSeq, customerId: existing.customerId, soldBy: "0", source: SOURCE_LABEL[channel], valueCents: annualCents, soldAt, cancelledAt: null, updatedAt: soldAt });
            }
          }
          continue;
        }

        const zip = b.id === SCENARIO.realignedToBranch && rng.chance(0.3) ? rng.pick(realigned) : rng.pick(zipsByBranch.get(b.id)!.filter((z) => !realignedSet.has(z)));
        const leadBranch = realignedSet.has(zip) ? SCENARIO.realignedFromBranch : b.id;
        const person = newPerson(zip, channel === "d2d" ? rng.chance(0.5) : rng.chance(0.55));

        // Some D2D customers clicked a paid search ad days before the rep knocked.
        if (channel === "d2d" && rng.chance(PARAMS.d2dPaidTouchRate)) {
          const touchAt = at - rng.int(3, 20) * DAY;
          if (touchAt >= SIM_START.getTime()) {
            emitLead(b, leadBranch, "google_search", touchAt, person);
            countPaid(leadBranch, "google_search", touchAt);
          }
        }
        emitLead(b, leadBranch, channel, at, person);
        countPaid(leadBranch, channel, at);

        if (channel !== "d2d" && rng.chance(PARAMS.duplicateLeadRate)) {
          const againAt = at + rng.int(2, 72) * HOUR;
          if (againAt < PERIOD_END.getTime()) {
            const againChannel = rng.chance(0.6) ? channel : "unknown";
            emitLead(b, leadBranch, againChannel, againAt, person);
            countPaid(leadBranch, againChannel, againAt);
          }
        }

        if (!rng.chance(PARAMS.closeRate[channel])) continue;
        const soldAt = channel === "d2d" ? at : at + rng.int(0, 96) * HOUR;
        if (soldAt >= DEMO_NOW.getTime()) continue;

        const c = crm(b);
        const customerId = ++customerSeq;
        const subscriptionId = ++subscriptionSeq;
        const mismatch = rng.chance(PARAMS.phoneMismatchRate);
        const crmPerson: Person = mismatch ? { ...person, email: null } : person;
        const typoPhone = mismatch ? newPerson(zip, false).phone : null;
        const label = rng.chance(0.85) ? SOURCE_LABEL[channel] : rng.pick(["Google", "Other", "Referral"]);
        c.customer(customerId, crmPerson, typoPhone, label, soldAt);
        const { perVisitCents, annualCents } = planValue(b);
        const soldBy = channel === "d2d" ? String(rng.int(1000, 2600)) : "0";
        c.subscription({ id: subscriptionId, customerId, soldBy, source: label, valueCents: annualCents, soldAt, cancelledAt: null, updatedAt: soldAt });

        // Initial service.
        const apptId = ++appointmentSeq;
        const scheduledAt = serviceTime(soldAt - (soldAt % DAY) + rng.int(1, 7) * DAY, b);
        c.appointment({ id: apptId, subscriptionId, customerId, initial: true, status: "0", scheduledAt, completedAt: null, updatedAt: soldAt + 5 * 60_000 });
        if (scheduledAt >= DEMO_NOW.getTime()) continue;
        const roll = rng.next();
        let completedAt: number | null = null;
        let finalApptId = apptId;
        if (roll < PARAMS.initialCompletedRate) {
          completedAt = scheduledAt + rng.int(20, 90) * 60_000;
          c.appointment({ id: apptId, subscriptionId, customerId, initial: true, status: "1", scheduledAt, completedAt, updatedAt: completedAt });
        } else if (roll < PARAMS.initialCompletedRate + PARAMS.initialCancelledRate) {
          const cancelledAt = scheduledAt - rng.int(2, 30) * HOUR;
          c.appointment({ id: apptId, subscriptionId, customerId, initial: true, status: "-1", scheduledAt, completedAt: null, updatedAt: cancelledAt });
          c.subscription({ id: subscriptionId, customerId, soldBy, source: label, valueCents: annualCents, soldAt, cancelledAt, updatedAt: cancelledAt + 60_000 });
          continue;
        } else {
          // No-show, rescheduled three days later.
          c.appointment({ id: apptId, subscriptionId, customerId, initial: true, status: "-2", scheduledAt, completedAt: null, updatedAt: scheduledAt + 2 * HOUR });
          finalApptId = ++appointmentSeq;
          const again = scheduledAt + 3 * DAY;
          c.appointment({ id: finalApptId, subscriptionId, customerId, initial: true, status: "0", scheduledAt: again, completedAt: null, updatedAt: scheduledAt + 3 * HOUR });
          if (again < DEMO_NOW.getTime()) {
            completedAt = again + rng.int(20, 90) * 60_000;
            c.appointment({ id: finalApptId, subscriptionId, customerId, initial: true, status: "1", scheduledAt: again, completedAt, updatedAt: completedAt });
          }
        }
        if (completedAt === null || completedAt >= DEMO_NOW.getTime()) continue;
        const initialFee = channel === "d2d" ? rng.pick([0, 0, 4900, 9900]) : rng.chance(0.3) ? 0 : rng.int(10, 40) * 500;
        bill(b, customerId, finalApptId, true, initialFee, completedAt);
        recurring(b, customerId, subscriptionId, perVisitCents, completedAt + rng.int(60, 90) * DAY);
      }
    }
  }

  // ── Ad spend (daily, restated for a trailing window) ────────────────────────
  for (const camp of campaigns) {
    // The migrated campaign's days are emitted under the campaign it replaced, below, with the
    // same random draws: the migration changes how spend is reported, not what was spent, and
    // every other number in the world stays exactly as it was before the scenario existed.
    if (camp === migratedTo) continue;
    const b = BRANCH_BY_ID.get(camp.branchId)!;
    const cpl = PARAMS.cplCents[camp.channel]!;
    const share = { google_search: 0.25, google_lsa: 0.15, meta: 0.08, microsoft: 0.04 }[camp.channel as "google_search"] ?? 0.1;
    for (let d = 0; d < days; d++) {
      const dayStart = SIM_START.getTime() + d * DAY;
      if (dayStart < camp.launchedAt) continue;
      const date = new Date(dayStart).toISOString().slice(0, 10);
      const spec = camp === migratedFrom && dayStart >= migrationAt ? migratedTo : camp;
      const season = 1.1 - 0.25 * (d / days);
      const expectedLeads = camp === expansion
        ? 2.2
        : PARAMS.dailyProspectsPerBranch * b.size * season * share * (1 + PARAMS.duplicateLeadRate * 0.6);
      let costCents = Math.round(expectedLeads * cpl * rng.between(0.8, 1.2));
      const actualLeads = paidLeadsByCampaignDay.get(`${spec.campaignId}:${date}`) ?? 0;
      // Platforms count view-throughs and repeat conversions: they claim more than arrives.
      const conversions = Math.round(actualLeads * rng.between(1.15, 1.4) + (rng.chance(0.3) ? 1 : 0));
      const clicks = Math.round((costCents / 100) / rng.between(6, 14));
      const emit = (fetchedAt: number, cost: number) =>
        push("ads", "spend_day", fetchedAt, {
          platform: spec.platform, accountId: spec.accountId, campaignId: spec.campaignId, campaignName: spec.name,
          date, costMicros: String(cost * 10_000), clicks, conversions, fetchedAt: new Date(fetchedAt).toISOString(),
          ...(spec.campaignType ? { campaignType: spec.campaignType } : {}),
          ...(spec.localServicesEnabled ? { localServicesEnabled: true } : {}),
        });
      emit(dayStart + DAY + 6 * HOUR, costCents);
      if (rng.chance(0.3)) {
        costCents = Math.round(costCents * rng.between(0.97, 1.05));
        emit(dayStart + 2 * DAY + 6 * HOUR, costCents);
      }
    }
  }

  // ── A CRM bug: three tickets re-sent with the same version but a different total ──
  const tickets = records.filter((r) => r.stream === "crm.ticket");
  for (let k = 0; k < 3; k++) {
    const original = tickets[rng.int(0, tickets.length - 1)];
    const total = Number(original.payload.total);
    records.push({ ...original, visibleAt: original.visibleAt + DAY, payload: { ...original.payload, total: (total + 25).toFixed(2) } });
  }

  records.sort((a, b) => a.visibleAt - b.visibleAt);
  return { records, campaigns, territories, truth: { driftedCalls, realignedZips: realigned } };
}
