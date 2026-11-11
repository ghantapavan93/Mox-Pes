import { describe, expect, it } from "vitest";
import type { RawRecord, SourceName } from "@/lib/adapters/contract";
import { ACTIVE_VERSION, mapperFor, referenceContext } from "@/lib/adapters/registry";
import { call, crm } from "../helpers";

/**
 * Vendor contract states (docs/agent-work/VENDOR-CONTRACTS.md). Each case is a state the
 * vendor's own documentation says can occur, fed through the mapper exactly as intake would.
 * The expectation pins today's behaviour, sorted into three outcomes:
 *
 *   projected   the state is understood and stored correctly
 *   refused     quarantined with a code: visible, blocks decisions, never silently wrong
 *   SILENT      stored as if it were something else, with no signal: a known defect, pinned
 *               here so a fix (or a regression) changes this test
 *
 * These run against synthetic payloads in the documented shape. None of this is live-verified.
 */
const NOW = new Date("2026-10-31T13:00:00Z");
const BRANCH = "B01";

function outcome(source: SourceName, record: RawRecord, version = ACTIVE_VERSION[source]): string {
  const mapper = mapperFor(source, version);
  const ctx = { ...referenceContext, receivedAt: NOW };
  const identity = mapper.identify(record, ctx);
  if (!("entityId" in identity)) return `refused:${identity.code}`;
  const result = mapper.map(record, ctx);
  return result.ok ? `projected:${result.projection.table}` : `refused:${result.code}`;
}

const at = new Date("2026-10-14T14:12:33Z");
const callRail = (extra: Record<string, unknown>) => call("CR-1", BRANCH, "+12125550123", at, "Google Ads", extra);

describe("CallRail v3 call states", () => {
  it("start_time with milliseconds and an offset (documented format) is read", () => {
    expect(outcome("calls", call("CR-2", BRANCH, "+12125550123", at, "Google Ads", { start_time: "2026-10-14T10:12:33.000-04:00" }))).toBe("projected:leads");
  });

  it("a native CallRail call object (company_id, no branch_tag) is refused, not guessed", () => {
    const native: RawRecord = {
      entity: "call",
      payload: { id: "CAL8154", start_time: "2026-10-14T10:12:33.000-04:00", company_id: "COM123", customer_phone_number: "+12125550123", tracking_phone_number: "+12125550199", source: "Google Ads", direction: "inbound", answered: true, duration: 74 },
    };
    expect(outcome("calls", native)).toBe("refused:SCHEMA_VIOLATION");
  });

  it("SILENT on calls@1.1: an outbound call is counted as an inbound lead; calls@1.2 refuses it", () => {
    expect(outcome("calls", callRail({ direction: "outbound" }))).toBe("projected:leads");
    expect(outcome("calls", callRail({ direction: "outbound" }), "1.2")).toBe("refused:NOT_INBOUND");
  });

  it("SILENT on calls@1.1: a call marked spam is a lead; calls@1.2 refuses it", () => {
    expect(outcome("calls", callRail({ spam: true }))).toBe("projected:leads");
    expect(outcome("calls", callRail({ spam: true }), "1.2")).toBe("refused:SPAM_CALL");
  });

  it("SILENT on calls@1.1: lead_status not_a_lead is a lead; calls@1.2 refuses it, and keeps good leads", () => {
    expect(outcome("calls", callRail({ lead_status: "not_a_lead" }))).toBe("projected:leads");
    expect(outcome("calls", callRail({ lead_status: "not_a_lead" }), "1.2")).toBe("refused:NOT_A_LEAD");
    expect(outcome("calls", callRail({ lead_status: "good_lead", direction: "inbound", spam: false }), "1.2")).toBe("projected:leads");
    expect(outcome("calls", callRail({ lead_status: null }), "1.2")).toBe("projected:leads");
  });

  it("Call Modified resends the whole call under the same id: a new version, ordered by receipt", () => {
    const mapper = mapperFor("calls");
    const posted = mapper.identify(callRail({}), referenceContext);
    const modified = mapper.identify(callRail({ campaign: "Spring termite" }), referenceContext);
    if (!("entityId" in posted) || !("entityId" in modified)) throw new Error("unidentifiable");
    expect(modified.entityId).toBe(posted.entityId);
    expect(modified.externalId).not.toBe(posted.externalId);
    // No updated_at exists on a CallRail call, so receipt order is the only clock. A Post-Call
    // delivered after a Call Modified (Post-Call may lag hangup by up to 20 minutes) would win:
    // VENDOR-CONTRACTS.md C-4 (SILENT, open).
    expect(modified.versionClock).toBe("received");
  });

  it("calls@1.2 is staged, not active", () => {
    expect(ACTIVE_VERSION.calls).toBe("1.1");
  });
});

describe("Google Ads API v26 spend states", () => {
  const day = (extra: Record<string, unknown>): RawRecord => ({
    entity: "spend_day",
    payload: { platform: "google_ads", accountId: "GA-1", campaignId: "c-1", campaignName: "Search", date: "2026-10-14", costMicros: "152340000", clicks: 12, conversions: 3, fetchedAt: "2026-10-15T06:00:00Z", campaignType: "SEARCH", ...extra },
  });

  it("cost_micros as an int64 string (REST JSON) is read exactly", () => {
    const mapper = mapperFor("ads");
    const r = mapper.map(day({}), referenceContext);
    expect(r.ok && r.projection.table === "ad_spend_daily" && (r.projection.row as { costCents: number }).costCents).toBe(15234);
  });

  it("fractional conversions (metrics.conversions is a double) are refused, never rounded", () => {
    expect(outcome("ads", day({ conversions: 2.5 }))).toBe("refused:SCHEMA_VIOLATION");
    expect(outcome("ads", day({ conversions: 2.5 }), "1.2")).toBe("refused:FRACTIONAL_CONVERSIONS");
    expect(outcome("ads", day({ conversions: 2 }), "1.2")).toBe("projected:ad_spend_daily");
  });

  it("SILENT on ads@1.1: a non-USD account is summed as dollars; ads@1.2 refuses it", () => {
    expect(outcome("ads", day({ currencyCode: "CAD" }))).toBe("projected:ad_spend_daily");
    expect(outcome("ads", day({ currencyCode: "CAD" }), "1.2")).toBe("refused:CURRENCY_UNSUPPORTED");
    expect(outcome("ads", day({ currencyCode: "USD" }), "1.2")).toBe("projected:ad_spend_daily");
  });

  it("a restated day is a new version keyed by fetch time, newest fetch wins by source clock", () => {
    const mapper = mapperFor("ads");
    const first = mapper.identify(day({}), referenceContext);
    const restated = mapper.identify(day({ costMicros: "149990000", fetchedAt: "2026-10-17T06:00:00Z" }), referenceContext);
    if (!("entityId" in first) || !("entityId" in restated)) throw new Error("unidentifiable");
    expect(restated.entityId).toBe(first.entityId);
    expect(restated.versionClock).toBe("source");
    expect(restated.occurredAt.getTime()).toBeGreaterThan(first.occurredAt.getTime());
  });
});

describe("FieldRoutes states the documentation describes", () => {
  it("a refund (negative amount referencing the original payment) is projected", () => {
    expect(outcome("crm", crm.payment(9001, 1001, 4001, BRANCH, "-49.00", at, "1", "9000"))).toBe("projected:crm_payments");
  });

  it("a documented payment shape (paymentApplications, no ticketID) is refused: every real payment, loudly (G5)", () => {
    const record = crm.payment(9002, 1001, 4001, BRANCH, "149.00", at);
    const payload: Record<string, unknown> = { ...(record.payload as Record<string, unknown>), invoiceIDs: "4001", paymentApplications: [{ ticketID: "4001", appliedAmount: "149.00" }] };
    delete payload.ticketID;
    expect(outcome("crm", { entity: "payment", payload })).toBe("refused:MISSING_FIELD");
  });

  it("an unapplied payment (no invoice) is refused the same way: applied vs unapplied is not modelled", () => {
    const record = crm.payment(9003, 1001, 4001, BRANCH, "149.00", at);
    const payload: Record<string, unknown> = { ...(record.payload as Record<string, unknown>), invoiceIDs: "", unassignedAmount: "149.00" };
    delete payload.ticketID;
    expect(outcome("crm", { entity: "payment", payload })).toBe("refused:MISSING_FIELD");
  });

  it("payment statuses 3-7 (disputes, ACH return) are refused, not mapped to paid or void (G6)", () => {
    for (const status of ["3", "4", "5", "6", "7"]) {
      const record = crm.payment(9004, 1001, 4001, BRANCH, "149.00", at);
      expect(outcome("crm", { entity: "payment", payload: { ...(record.payload as Record<string, unknown>), status } }), status).toBe("refused:SCHEMA_VIOLATION");
    }
  });

  it("a soft-deleted customer (negative officeID) is refused, not stored under no branch (G2)", () => {
    const record = crm.customer(1002, BRANCH, "+12125550124", at);
    const payload = record.payload as Record<string, unknown>;
    expect(outcome("crm", { entity: "customer", payload: { ...payload, officeID: `-${String(payload.officeID)}` } })).toMatch(/^refused:/);
  });

  it("a stand-alone visit (subscriptionID = -1) is refused (G2)", () => {
    const record = crm.appointment(3002, 2001, 1001, BRANCH, "0", at, at);
    expect(outcome("crm", { entity: "appointment", payload: { ...(record.payload as Record<string, unknown>), subscriptionID: "-1" } })).toBe("refused:SCHEMA_VIOLATION");
  });
});
