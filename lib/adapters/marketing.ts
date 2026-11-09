import { z } from "zod";
import { microsToCents, payloadHash } from "@/lib/primitives";
import { AD_PLATFORM_CHANNEL, type ChannelCode } from "@/lib/reference";
import {
  fail,
  type LeadRow,
  type MapContext,
  type MapFailure,
  type MapResult,
  type RawRecord,
  type RecordIdentity,
  type SourceMapper,
} from "./contract";
import { emailHashOf, phoneHashOf } from "./redact";
import { schemaFailure } from "./validation";

const isoInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, "expected ISO-8601 with offset");
const branchId = z.string().regex(/^B\d{2}$/);

function identifyBy(record: RawRecord, entity: string, idField: string, versionField: string): RecordIdentity | MapFailure {
  const p = (record.payload ?? {}) as Record<string, unknown>;
  const entityId = p[idField];
  const version = p[versionField];
  if (typeof entityId !== "string" || typeof version !== "string") {
    return fail("MISSING_IDENTITY", `${entity}: missing ${idField} or ${versionField}`);
  }
  const occurredAt = new Date(version);
  if (Number.isNaN(occurredAt.getTime())) return fail("INVALID_TIMESTAMP", `${entity}.${versionField}: "${version}"`);
  return { entity, entityId, externalId: `${entity}:${entityId}:${version}`, occurredAt, versionClock: "source" };
}

function requireBranch(ctx: MapContext, branch: string, path: string): MapFailure | null {
  return ctx.timezoneForBranch(branch) ? null : fail("UNKNOWN_BRANCH", `${path}: "${branch}" is not a known branch`);
}

// ── Call tracking (CallRail-shaped) ──────────────────────────────────────────

/**
 * v1.0 reads the caller from `customer_phone_number`.
 * v1.1 also accepts `caller.number` — the shape one branch's call-tracking account
 * started sending after an account migration (the seeded incident). Same meaning,
 * new place; nothing is guessed.
 */
const callBase = {
  id: z.string().min(1),
  branch_tag: branchId,
  start_time: isoInstant,
  tracking_phone_number: z.string(),
  source: z.enum(["Google Ads", "Google LSA", "Google My Business", "Facebook", "Bing", "Direct"]),
  gclid: z.string().nullable(),
  campaign: z.string().nullable(),
  agent_note: z.string().nullable(),
};
const callV10 = z.object({ ...callBase, customer_phone_number: z.string().min(1) });
const callV11 = z.union([
  callV10,
  z.object({ ...callBase, caller: z.object({ number: z.string().min(1) }) }),
]);

function callChannel(source: string, gclid: string | null): Pick<LeadRow, "channelCode" | "attributionEvidence"> {
  switch (source) {
    case "Google Ads":
      return { channelCode: "google_search", attributionEvidence: gclid ? "click_id" : "tracking_number" };
    case "Google LSA":
      return { channelCode: "google_lsa", attributionEvidence: "lsa_lead" };
    case "Google My Business":
      return { channelCode: "organic_gbp", attributionEvidence: "tracking_number" };
    case "Facebook":
      return { channelCode: "meta", attributionEvidence: "tracking_number" };
    case "Bing":
      return { channelCode: "microsoft", attributionEvidence: "tracking_number" };
    default:
      // A call to the branch's main line: no tracking evidence. It stays unknown.
      return { channelCode: "unknown", attributionEvidence: "none" };
  }
}

export class CallTrackingMapper implements SourceMapper {
  readonly source = "calls" as const;
  constructor(readonly version: "1.0" | "1.1") {}

  /**
   * Call-tracking platforms update a call after the fact (attribution, qualification) under
   * the same id with no version stamp. A changed payload is therefore a new version,
   * identified by content and ordered by receipt — not a conflict.
   */
  identify(record: RawRecord): RecordIdentity | MapFailure {
    const base = identifyBy(record, "call", "id", "start_time");
    if (!("entityId" in base)) return base;
    return { ...base, externalId: `call:${base.entityId}:${payloadHash(record.payload).slice(0, 16)}`, versionClock: "received" };
  }

  map(record: RawRecord, ctx: MapContext): MapResult {
    const schema = this.version === "1.0" ? callV10 : callV11;
    const parsed = schema.safeParse(record.payload);
    if (!parsed.success) return schemaFailure("call", parsed.error);
    const c = parsed.data;
    const bad = requireBranch(ctx, c.branch_tag, "call.branch_tag");
    if (bad) return bad;
    const callerNumber = "customer_phone_number" in c ? c.customer_phone_number : c.caller.number;
    const phoneHash = phoneHashOf(callerNumber);
    if (!phoneHash) return fail("SCHEMA_VIOLATION", "call.caller: not a dialable US number");
    const at = new Date(c.start_time);
    return {
      ok: true,
      projection: {
        table: "leads",
        row: {
          source: "calls",
          sourceLeadId: c.id,
          branchId: c.branch_tag,
          ...callChannel(c.source, c.gclid),
          campaignExternalId: c.campaign,
          clickId: c.gclid,
          phoneHash,
          emailHash: null,
          zip: null,
          heardAboutText: c.agent_note,
          occurredAt: at,
          sourceUpdatedAt: ctx.receivedAt ?? at,
        },
      },
    };
  }
}

// ── Website lead events ──────────────────────────────────────────────────────

const webLead = z.object({
  messageId: z.string().min(1),
  timestamp: isoInstant,
  properties: z.object({
    form: z.enum(["quote", "contact", "checkout"]),
    branch_id: branchId,
    zip: z.string().regex(/^\d{5}$/),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    utm_source: z.string().nullable(),
    utm_medium: z.string().nullable(),
    utm_campaign: z.string().nullable(),
    gclid: z.string().nullable(),
    message: z.string().nullable(),
  }),
});

function webChannel(p: z.infer<typeof webLead>["properties"]): Pick<LeadRow, "channelCode" | "attributionEvidence"> {
  if (p.gclid) return { channelCode: "google_search", attributionEvidence: "click_id" };
  const source = p.utm_source?.toLowerCase() ?? "";
  const paid = ["cpc", "paid", "ppc", "paid_social"].includes(p.utm_medium?.toLowerCase() ?? "");
  if (source === "google" && paid) return { channelCode: "google_search", attributionEvidence: "utm" };
  if ((source === "facebook" || source === "meta" || source === "instagram") && paid) return { channelCode: "meta", attributionEvidence: "utm" };
  if (source === "bing" && paid) return { channelCode: "microsoft", attributionEvidence: "utm" };
  return { channelCode: "unknown", attributionEvidence: "none" };
}

export class WebLeadMapper implements SourceMapper {
  readonly source = "web" as const;
  readonly version = "1.0";

  identify(record: RawRecord): RecordIdentity | MapFailure {
    return identifyBy(record, "lead", "messageId", "timestamp");
  }

  map(record: RawRecord, ctx: MapContext): MapResult {
    const parsed = webLead.safeParse(record.payload);
    if (!parsed.success) return schemaFailure("lead", parsed.error);
    const { messageId, timestamp, properties: p } = parsed.data;
    const bad = requireBranch(ctx, p.branch_id, "lead.properties.branch_id");
    if (bad) return bad;
    const phoneHash = phoneHashOf(p.phone);
    const emailHash = emailHashOf(p.email);
    if (!phoneHash && !emailHash) return fail("SCHEMA_VIOLATION", "lead.properties: neither a phone nor an email");
    const at = new Date(timestamp);
    return {
      ok: true,
      projection: {
        table: "leads",
        row: {
          source: "web",
          sourceLeadId: messageId,
          branchId: p.branch_id,
          ...webChannel(p),
          campaignExternalId: p.utm_campaign,
          clickId: p.gclid,
          phoneHash,
          emailHash,
          zip: p.zip,
          heardAboutText: p.message,
          occurredAt: at,
          sourceUpdatedAt: at,
        },
      },
    };
  }
}

// ── Door-to-door sales app ───────────────────────────────────────────────────

const d2dSale = z.object({
  saleId: z.string().min(1),
  repId: z.string().min(1),
  branchId,
  signedAt: isoInstant,
  customer: z.object({ phone: z.string().nullable(), email: z.string().nullable(), zip: z.string().regex(/^\d{5}$/) }),
});

export class DoorToDoorMapper implements SourceMapper {
  readonly source = "d2d" as const;
  readonly version = "1.0";

  identify(record: RawRecord): RecordIdentity | MapFailure {
    return identifyBy(record, "sale", "saleId", "signedAt");
  }

  map(record: RawRecord, ctx: MapContext): MapResult {
    const parsed = d2dSale.safeParse(record.payload);
    if (!parsed.success) return schemaFailure("sale", parsed.error);
    const s = parsed.data;
    const bad = requireBranch(ctx, s.branchId, "sale.branchId");
    if (bad) return bad;
    const phoneHash = phoneHashOf(s.customer.phone);
    const emailHash = emailHashOf(s.customer.email);
    if (!phoneHash && !emailHash) return fail("SCHEMA_VIOLATION", "sale.customer: neither a phone nor an email");
    const at = new Date(s.signedAt);
    return {
      ok: true,
      projection: {
        table: "leads",
        row: {
          source: "d2d",
          sourceLeadId: s.saleId,
          branchId: s.branchId,
          channelCode: "d2d",
          attributionEvidence: "rep_signature",
          campaignExternalId: null,
          clickId: null,
          phoneHash,
          emailHash,
          zip: s.customer.zip,
          heardAboutText: null,
          occurredAt: at,
          sourceUpdatedAt: at,
        },
      },
    };
  }
}

// ── Ad platforms (daily campaign spend) ──────────────────────────────────────

const spendDay = z.object({
  platform: z.enum(["google_ads", "google_lsa", "microsoft_ads", "meta"]),
  accountId: z.string().min(1),
  campaignId: z.string().min(1),
  campaignName: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  costMicros: z.string().regex(/^\d{1,18}$/),
  clicks: z.number().int().nonnegative().max(2_147_483_647),
  conversions: z.number().int().nonnegative().max(2_147_483_647),
  fetchedAt: isoInstant,
  // Google Ads campaign typing. Optional: other platforms do not send it.
  campaignType: z.string().min(1).nullable().optional(),
  localServicesEnabled: z.boolean().optional(),
});

/**
 * Daily campaign spend from the ad platforms.
 *
 * v1.0 classifies the channel by platform alone. That was right while Local Services Ads had
 * its own platform, and is wrong after Google migrates an LSA campaign into Google Ads: the
 * migrated campaign is typed PERFORMANCE_MAX with local services enabled (Google Ads API docs,
 * 2026), so v1.0 files its spend as Google Search. Nothing fails; the money lands in the wrong
 * channel.
 *
 * v1.1 reads the campaign type and the local-services flag. Same records, corrected meaning.
 */
export class AdSpendMapper implements SourceMapper {
  readonly source = "ads" as const;
  constructor(readonly version: "1.0" | "1.1" = "1.0") {}

  identify(record: RawRecord): RecordIdentity | MapFailure {
    const p = (record.payload ?? {}) as Record<string, unknown>;
    if (typeof p.campaignId !== "string" || typeof p.date !== "string" || typeof p.fetchedAt !== "string") {
      return fail("MISSING_IDENTITY", "spend_day: missing campaignId, date or fetchedAt");
    }
    // Platforms restate recent days, so a day is re-fetched for a trailing window. Each
    // fetch is a version (keyed by fetch time); the projection keeps the newest. Keying by
    // cost instead would treat a restatement back to an earlier value as a duplicate and
    // leave the projection stale.
    const entityId = `${String(p.platform)}:${p.campaignId}:${p.date}`;
    return {
      entity: "spend_day",
      entityId,
      externalId: `spend_day:${entityId}:${p.fetchedAt}`,
      occurredAt: new Date(p.fetchedAt),
      versionClock: "source",
    };
  }

  map(record: RawRecord): MapResult {
    const parsed = spendDay.safeParse(record.payload);
    if (!parsed.success) return schemaFailure("spend_day", parsed.error);
    const s = parsed.data;
    const typed = this.version !== "1.0";
    if (typed && s.localServicesEnabled === true && !s.campaignType) {
      // Without the campaign type the flag cannot be placed; refuse rather than guess a channel.
      return fail("AMBIGUOUS_CAMPAIGN_TYPE", `spend_day ${s.campaignId}: localServicesEnabled without campaignType`);
    }
    const localServices = typed && s.localServicesEnabled === true;
    const channelCode: ChannelCode =
      localServices && s.platform === "google_ads" && s.campaignType === "PERFORMANCE_MAX"
        ? "google_lsa"
        : (AD_PLATFORM_CHANNEL[s.platform] as ChannelCode);
    return {
      ok: true,
      projection: {
        table: "ad_spend_daily",
        row: {
          platform: s.platform,
          adAccountId: s.accountId,
          externalCampaignId: s.campaignId,
          campaignName: s.campaignName,
          campaignType: typed ? (s.campaignType ?? null) : null,
          localServicesEnabled: localServices,
          channelCode,
          spendDate: s.date,
          costCents: microsToCents(s.costMicros),
          clicks: s.clicks,
          platformConversions: s.conversions,
          sourceUpdatedAt: new Date(s.fetchedAt),
        },
      },
    };
  }
}
