import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor } from "@/lib/adapters/registry";
import { replay } from "@/lib/ingest/replay";
import {
  decideIdentityConflict,
  getCustomerJourney,
  getJourneyRawEvent,
  getProspectJourney,
  listIdentityConflicts,
  resolveIdentities,
  searchCustomers,
} from "@/lib/identity";
import { ForbiddenError, VIEWERS, resolveScope, type Viewer } from "@/lib/viewer";
import { GET as getCustomerRoute } from "@/app/api/customers/[id]/route";
import { GET as getRawEventRoute } from "@/app/api/customers/[id]/raw-events/[rawEventId]/route";
import { T0, call, crm, freshDb, ingest, one, testPool } from "../helpers";

const pool: Pool = testPool();
afterAll(async () => pool.end());

/**
 * Route handlers read the viewer from a cookie and the pool from lib/server, which need a Next
 * request. The route tests swap those for the test pool and a chosen viewer; everything else
 * (ref parsing, scope checks, error mapping) is the real code.
 */
const route = vi.hoisted(() => ({ viewer: null as unknown, pool: null as unknown }));
vi.mock("@/lib/server", () => ({ getViewer: async () => route.viewer, getPool: () => route.pool }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
route.pool = pool;

/** GET a route handler as `viewer`; returns the status and parsed JSON body. */
async function callRoute<P extends Record<string, string>>(
  handler: (request: Request, ctx: { params: Promise<P> }) => Promise<Response>,
  viewer: Viewer,
  params: P,
): Promise<{ status: number; body: unknown }> {
  route.viewer = viewer;
  const response = await handler(new Request("http://test.local/api"), { params: Promise.resolve(params) });
  return { status: response.status, body: await response.json() };
}

const HOUR = 3_600_000;
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);
const NOW = at(24 * 20);
const PARTNER_SCOPE = resolveScope(VIEWERS.partner); // ["B20"]

function web(id: string, branchId: string, phone: string | null, email: string | null, when: Date, extra: Record<string, unknown> = {}): RawRecord {
  return {
    entity: "lead",
    payload: {
      messageId: id,
      timestamp: when.toISOString(),
      properties: {
        form: "quote", branch_id: branchId, zip: "10001", phone, email,
        utm_source: "google", utm_medium: "cpc", utm_campaign: null, gclid: "Cj0KTEST", message: null, ...extra,
      },
    },
  };
}

function sale(id: string, branchId: string, phone: string | null, email: string | null, when: Date): RawRecord {
  return { entity: "sale", payload: { saleId: id, repId: "rep-7", branchId, signedAt: when.toISOString(), customer: { phone, email, zip: "10001" } } };
}

/** A complete CRM customer: customer → subscription → completed initial → invoice → payment. */
function crmCustomer(id: number, branchId: string, phone: string, soldAt: Date, opts: { email?: string | null; amount?: string } = {}): RawRecord[] {
  const done = new Date(soldAt.getTime() + 48 * HOUR);
  const amount = opts.amount ?? "149.00";
  return [
    crm.customer(id, branchId, phone, soldAt, { email: opts.email ?? null }),
    crm.subscription(id + 10_000, id, branchId, soldAt),
    crm.appointment(id + 20_000, id + 10_000, id, branchId, "1", done, done),
    crm.ticket(id + 30_000, id, id + 20_000, branchId, amount, new Date(done.getTime() + HOUR)),
    crm.payment(id + 40_000, id, id + 30_000, branchId, amount, new Date(done.getTime() + 2 * HOUR)),
  ];
}

const leadId = async (source: string, sourceLeadId: string) =>
  Number((await one<{ id: string }>(pool, "select id from leads where source = $1 and source_lead_id = $2", [source, sourceLeadId])).id);

const linkOf = (source: string, sourceRecordId: string) =>
  pool.query<{ identity_id: string; rule: string; crm_customer_id: string | null; kind: string }>(
    `select k.identity_id, k.rule, i.crm_customer_id, i.kind from identity_links k join identities i on i.id = k.identity_id
     where k.source = $1 and k.source_record_id = $2`,
    [source, sourceRecordId],
  );

/** Everything resolution owns, in a comparable form. */
async function snapshot() {
  const [identities, links, conflicts, audit] = await Promise.all([
    pool.query("select id, kind, anchor_key, crm_customer_id, branch_id, retired_at, updated_at from identities order by id"),
    pool.query("select id, identity_id, source, source_record_id, rule, confidence, evidence, linked_at from identity_links order by id"),
    pool.query("select id, fingerprint, status, evidence_fingerprint, decided_by, decided_at from identity_conflicts order by id"),
    pool.query("select count(*) as n from audit_log"),
  ]);
  return { identities: identities.rows, links: links.rows, conflicts: conflicts.rows, audit: audit.rows[0].n };
}

describe("identity resolution", () => {
  beforeEach(async () => freshDb(pool));

  it("one customer in calls + web + D2D + CRM resolves to one identity and one coherent, ordered timeline", async () => {
    const phone = "+12125550101";
    await ingest(pool, "calls", [call("CAL-1", "B20", phone, at(-30), "Google Ads")]);
    // Same person, phone formatted differently, plus an email.
    await ingest(pool, "web", [web("msg-1", "B20", "(212) 555-0101", "pat@example.com", at(-2))]);
    await ingest(pool, "d2d", [sale("S-1", "B20", "212-555-0101", null, at(-1))]);
    await ingest(pool, "crm", crmCustomer(1001, "B20", phone, at(0), { email: "pat@example.com" }));

    const stats = await resolveIdentities(pool, NOW);
    expect(stats.identities).toMatchObject({ customers: 1, prospects: 0 });
    expect(stats.leads).toMatchObject({ considered: 3, linkedToCustomer: 3, awaitingReview: 0 });

    const journey = (await getCustomerJourney(pool, 1001, null))!;
    expect(journey.links.map((l) => [l.source, l.sourceRecordId, l.rule, l.confidence])).toEqual([
      ["crm", "1001", "crm_customer_anchor", 1],
      ["calls", "CAL-1", "exact_phone_hash", 1],
      ["web", "msg-1", "exact_phone_hash", 1],
      ["d2d", "S-1", "exact_phone_hash", 1],
    ]);
    // The web lead matched on phone AND email: the evidence says so and names both records.
    const webLink = journey.links.find((l) => l.source === "web")!;
    expect(webLink.evidence).toMatchObject({ matchedKey: "phone_hash", alsoMatchedEmail: true, crmCustomerId: 1001, lead: { source: "web", sourceRecordId: "msg-1" } });

    expect(journey.timeline.map((t) => t.kind)).toEqual(["lead", "lead", "lead", "customer_created", "subscription_sold", "appointment", "ticket", "payment"]);
    expect(journey.timeline.map((t) => t.sourceRecordId).slice(0, 3)).toEqual(["CAL-1", "msg-1", "S-1"]);
    const times = journey.timeline.map((t) => t.at);
    expect([...times].sort()).toEqual(times);
    // Credit is the attribution view's decision (first evidenced touch), shown, not recomputed.
    expect(journey.attribution).toMatchObject({ channelCode: "google_search", attributionBasis: "lead_evidence", creditedLeadSourceId: "CAL-1", creditedLeadLinked: true });
    expect(journey.timeline.filter((t) => t.credited).map((t) => t.sourceRecordId)).toEqual(["CAL-1"]);
    expect(journey.overview).toMatchObject({ lifecycle: "serviced", leadRecords: 3, firstTouch: { sourceLeadId: "CAL-1" } });
    expect(journey.unresolvedMatches).toEqual([]);
    expect(journey.freshness.find((f) => f.entity === "CRM payments")?.records).toBe(1);
    // A D2D sale without an email is reported as an unknown, not left blank.
    expect(journey.unknowns).toContainEqual({ subject: "Door-to-door sale S-1", field: "email", note: "not captured" });
  });

  it("links on an exact email hash when no phone matches, and groups unmatched leads into prospects by phone", async () => {
    await ingest(pool, "web", [web("msg-2", "B20", null, "sam@example.com", at(-5))]);
    await ingest(pool, "crm", crmCustomer(1002, "B20", "+12125550102", at(0), { email: "sam@example.com" }));
    await ingest(pool, "calls", [call("CAL-9", "B20", "+12125550199", at(1)), call("CAL-10", "B20", "212.555.0199", at(3))]);

    await resolveIdentities(pool, NOW);
    expect((await linkOf("web", "msg-2")).rows[0]).toMatchObject({ rule: "exact_email_hash", crm_customer_id: "1002" });
    const a = (await linkOf("calls", "CAL-9")).rows[0];
    const b = (await linkOf("calls", "CAL-10")).rows[0];
    expect(a).toMatchObject({ rule: "prospect_phone_hash", kind: "prospect" });
    expect(b.identity_id).toBe(a.identity_id);

    const prospect = (await getProspectJourney(pool, Number(a.identity_id), null))!;
    expect(prospect.overview).toMatchObject({ lifecycle: "prospect", leadRecords: 2, branchId: "B20" });
    const search = await searchCustomers(pool, { lifecycle: "prospect" }, null);
    expect(search.rows.map((r) => r.identityId)).toEqual([Number(a.identity_id)]);

    // The prospect buys: its leads move to the CRM customer and the prospect is retired, not deleted.
    await ingest(pool, "crm", crmCustomer(1003, "B20", "+12125550199", at(10)));
    await resolveIdentities(pool, NOW);
    expect((await linkOf("calls", "CAL-9")).rows[0]).toMatchObject({ rule: "exact_phone_hash", crm_customer_id: "1003" });
    const retired = (await getProspectJourney(pool, Number(a.identity_id), null))!;
    expect(retired.overview.retired?.nowPartOf.map((p) => p.crmCustomerId)).toEqual([1003]);
  });

  it("a different customer sharing a phone hash is NOT merged: the lead becomes a pending conflict", async () => {
    const shared = "+12125550111";
    await ingest(pool, "crm", [...crmCustomer(1011, "B20", shared, at(0)), ...crmCustomer(1012, "B20", shared, at(5))]);
    await ingest(pool, "calls", [call("CAL-11", "B20", shared, at(-3))]);

    const stats = await resolveIdentities(pool, NOW);
    expect(stats.identities.customers).toBe(2);
    expect(stats.conflicts).toMatchObject({ pending: 2, opened: 2, leadsAwaitingReview: 1 });
    expect((await linkOf("calls", "CAL-11")).rowCount).toBe(0);
    // Two customers, two identities: never merged with each other.
    const ids = await pool.query("select distinct identity_id from identity_links where source = 'crm'");
    expect(ids.rowCount).toBe(2);

    const { rows } = await listIdentityConflicts(pool, { status: "pending" }, null);
    expect(rows.map((r) => [r.kind, r.crmCustomerId, r.leadSourceRecordId])).toEqual(
      expect.arrayContaining([["shared_phone", 1011, "CAL-11"], ["shared_phone", 1012, "CAL-11"]]),
    );
    expect(rows[0].evidence).toMatchObject({ matchedOn: ["phone_hash"], candidateCount: 2 });

    const journey = (await getCustomerJourney(pool, 1011, null))!;
    expect(journey.leads).toEqual([]);
    expect(journey.overview.flags.pendingConflicts).toBe(1);
    expect(journey.unresolvedMatches).toMatchObject([{ sourceLeadId: "CAL-11", state: "pending_review", matchedOn: ["phone_hash"] }]);
  });

  it("phone and email pointing at different CRM customers is a conflict, not a link", async () => {
    await ingest(pool, "crm", [
      ...crmCustomer(1021, "B20", "+12125550121", at(0)),
      ...crmCustomer(1022, "B20", "+12125550122", at(1), { email: "lee@example.com" }),
    ]);
    await ingest(pool, "web", [web("msg-21", "B20", "+12125550121", "lee@example.com", at(-1))]);
    const stats = await resolveIdentities(pool, NOW);
    expect(stats.conflicts.pending).toBe(2);
    const { rows } = await listIdentityConflicts(pool, {}, null);
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(["phone_email_disagree"]));
    expect((await linkOf("web", "msg-21")).rowCount).toBe(0);
  });

  it("accepting creates a reviewer_accepted link, rejects the lead's other candidates, and is audited", async () => {
    const shared = "+12125550131";
    await ingest(pool, "crm", [...crmCustomer(1031, "B20", shared, at(0)), ...crmCustomer(1032, "B20", shared, at(2))]);
    await ingest(pool, "calls", [call("CAL-31", "B20", shared, at(-1))]);
    await resolveIdentities(pool, NOW);
    const { rows } = await listIdentityConflicts(pool, {}, null);
    const toAccept = rows.find((r) => r.crmCustomerId === 1031)!;
    const sibling = rows.find((r) => r.crmCustomerId === 1032)!;

    await expect(decideIdentityConflict(pool, { conflictId: toAccept.id, decision: "accept", reason: "no", actor: "marketing", now: NOW })).rejects.toMatchObject({ status: 400 });

    const result = await decideIdentityConflict(pool, {
      conflictId: toAccept.id, decision: "accept", reason: "Caller confirmed account 1031 on the recording", actor: "marketing", now: NOW,
    });
    expect(result.conflict.status).toBe("accepted");
    expect(result.autoRejectedIds).toEqual([sibling.id]);
    expect(result.link).toMatchObject({ rule: "reviewer_accepted", crmCustomerId: 1031 });

    const link = (await linkOf("calls", "CAL-31")).rows[0];
    expect(link).toMatchObject({ rule: "reviewer_accepted", crm_customer_id: "1031" });
    const evidence = (await one<{ evidence: Record<string, unknown> }>(pool, "select evidence from identity_links where source_record_id = 'CAL-31'")).evidence;
    expect(evidence).toMatchObject({ conflictId: toAccept.id, decidedBy: "marketing", crmCustomerId: 1031 });
    expect((await one(pool, "select status, decided_by from identity_conflicts where id = $1", [sibling.id]))).toEqual({ status: "rejected", decided_by: "marketing" });

    const audit = await pool.query("select action, subject, detail from audit_log where action like 'identity_conflict_%'");
    expect(audit.rows).toEqual([
      { action: "identity_conflict_accept", subject: `identity_conflict:${toAccept.id}`, detail: expect.objectContaining({ autoRejectedConflictIds: [sibling.id], reason: "Caller confirmed account 1031 on the recording" }) },
    ]);
    // Deciding again is refused, and a re-run keeps the decision.
    await expect(decideIdentityConflict(pool, { conflictId: toAccept.id, decision: "reject", reason: "changed my mind", actor: "engineer", now: NOW })).rejects.toMatchObject({ status: 409 });
    const before = await snapshot();
    const again = await resolveIdentities(pool, NOW);
    expect(again.changed).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect((await getCustomerJourney(pool, 1031, null))!.leads.map((l) => [l.sourceLeadId, l.linkRule])).toEqual([["CAL-31", "reviewer_accepted"]]);
  });

  it("a rejected conflict stays rejected after re-runs and after a replay; new evidence re-opens it and references the decision", async () => {
    const shared = "+12125550141";
    await ingest(pool, "crm", [...crmCustomer(1041, "B20", shared, at(0)), ...crmCustomer(1042, "B20", shared, at(2))]);
    const first = call("CAL-41", "B20", shared, at(-1));
    await ingest(pool, "calls", [first]);
    // A later version of the same call arrives in the drifted shape and is quarantined by calls@1.0.
    const drifted = call("CAL-41", "B20", shared, at(-1), "Google Ads", { agent_note: "callback requested" });
    const p = drifted.payload as Record<string, unknown>;
    p.caller = { number: p.customer_phone_number };
    delete p.customer_phone_number;
    await ingest(pool, "calls", [drifted], { mapper: mapperFor("calls", "1.0") });
    const quarantined = Number((await one<{ id: string }>(pool, "select id from raw_events where status = 'quarantined'")).id);

    await resolveIdentities(pool, NOW);
    const pending = (await listIdentityConflicts(pool, {}, null)).rows;
    expect(pending).toHaveLength(2);
    for (const c of pending) {
      await decideIdentityConflict(pool, { conflictId: c.id, decision: "reject", reason: "Shared office line, different people", actor: "engineer", now: NOW });
    }
    // Every candidate rejected → the lead is a prospect, not anyone's customer record.
    expect((await linkOf("calls", "CAL-41")).rows[0]).toMatchObject({ rule: "prospect_phone_hash", kind: "prospect" });

    const decided = await snapshot();
    expect((await resolveIdentities(pool, NOW)).changed).toBe(false);
    expect(await snapshot()).toEqual(decided);

    // Replay the quarantined version: the lead row is re-projected from a new raw event.
    const lead = await leadId("calls", "CAL-41");
    const rawBefore = (await one<{ raw_event_id: string }>(pool, "select raw_event_id from leads where id = $1", [lead])).raw_event_id;
    const r = await replay(pool, {
      source: "calls", rawEventIds: [quarantined], mapperVersion: "1.1", actor: "engineer", idempotencyKey: "identity-replay-0001",
      dryRun: false, now: NOW, scope: { from: at(-48), to: at(48), branchIds: ["B20"] },
    });
    expect(r.projected).toBe(1);
    expect((await one<{ raw_event_id: string }>(pool, "select raw_event_id from leads where id = $1", [lead])).raw_event_id).not.toBe(rawBefore);
    await resolveIdentities(pool, NOW);
    const afterReplay = await snapshot();
    expect(afterReplay.conflicts).toEqual(decided.conflicts);
    expect(afterReplay.links.map((l) => [l.source_record_id, l.rule, l.identity_id])).toEqual(decided.links.map((l) => [l.source_record_id, l.rule, l.identity_id]));

    // New evidence: a third customer with the same phone. The pair decisions no longer cover it.
    await ingest(pool, "crm", crmCustomer(1043, "B20", shared, at(4)));
    const stats = await resolveIdentities(pool, NOW);
    expect(stats.conflicts.opened).toBe(3);
    const reopened = (await listIdentityConflicts(pool, { status: "pending" }, null)).rows;
    expect(reopened).toHaveLength(3);
    const rejectedIds = pending.map((c) => c.id);
    for (const c of reopened.filter((k) => k.crmCustomerId !== 1043)) {
      expect(rejectedIds).toContain(c.priorDecision?.id);
      expect(c.priorDecision?.status).toBe("rejected");
    }
    // The old rejections are history, unchanged; the lead waits for review again.
    expect((await pool.query("select status from identity_conflicts where id = any($1::bigint[])", [rejectedIds])).rows).toEqual([{ status: "rejected" }, { status: "rejected" }]);
    expect((await linkOf("calls", "CAL-41")).rowCount).toBe(0);
  });

  it("is idempotent: a second run over unchanged data changes nothing", async () => {
    await ingest(pool, "calls", [call("CAL-51", "B20", "+12125550151", at(-2)), call("CAL-52", "B21", "+12125550152", at(-2)), call("CAL-53", "B20", "+12125550159", at(-2))]);
    await ingest(pool, "crm", [...crmCustomer(1051, "B20", "+12125550151", at(0)), ...crmCustomer(1052, "B21", "+12125550152", at(0)), ...crmCustomer(1053, "B21", "+12125550152", at(1))]);
    const first = await resolveIdentities(pool, NOW);
    expect(first.changed).toBe(true);
    const before = await snapshot();

    const second = await resolveIdentities(pool, at(24 * 40));
    expect(second.changed).toBe(false);
    expect(second.identities).toMatchObject({ created: 0, retired: 0, reactivated: 0 });
    expect(second.links).toMatchObject({ created: 0, changed: 0, removed: 0 });
    expect(second.conflicts).toMatchObject({ opened: 0, superseded: 0, pending: first.conflicts.pending });
    expect(await snapshot()).toEqual(before);
    expect((await one(pool, "select count(*) n from identity_runs")).n).toBe("2");
  });

  it("refunds appear in the timeline and collected = payments − refunds", async () => {
    await ingest(pool, "crm", [
      ...crmCustomer(1061, "B20", "+12125550161", at(0), { amount: "149.00" }),
      crm.payment(51061, 1061, 31061, "B20", "-49.00", at(80), "1", String(41061)),
      crm.payment(52061, 1061, 31061, "B20", "75.00", at(81), "0"),
    ]);
    await resolveIdentities(pool, NOW);
    const journey = (await getCustomerJourney(pool, 1061, null))!;
    expect(journey.money).toEqual({ paymentsCents: 14900, refundsCents: 4900, collectedCents: 10000, failedOrVoidedCents: 7500, invoicedCents: 14900 });
    const fromView = await one<{ collected_cents: string }>(pool, "select collected_cents from v_customer_revenue where crm_customer_id = 1061");
    expect(Number(fromView.collected_cents)).toBe(journey.money.collectedCents);
    const refund = journey.timeline.find((t) => t.kind === "refund")!;
    expect(refund).toMatchObject({ sourceTable: "crm_payments", sourceId: "51061", amountCents: -4900 });
    expect(journey.payments.filter((p) => p.isRefund).map((p) => p.originalPaymentId)).toEqual([41061]);
  });

  it("enforces branch scope: another branch's customer is indistinguishable from a missing one, and its conflicts stay hidden", async () => {
    const shared = "+12125550171";
    await ingest(pool, "crm", [...crmCustomer(1071, "B21", shared, at(0)), ...crmCustomer(1072, "B21", shared, at(1)), ...crmCustomer(1073, "B20", "+12125550173", at(0))]);
    await ingest(pool, "calls", [call("CAL-71", "B21", shared, at(-1)), call("CAL-72", "B21", "+12125550172", at(-1))]);
    await resolveIdentities(pool, NOW);

    // No existence or branch oracle: out of scope reads exactly like an id that does not exist.
    expect(await getCustomerJourney(pool, 1071, PARTNER_SCOPE)).toBeNull();
    expect(await getCustomerJourney(pool, 999_999_999, PARTNER_SCOPE)).toBeNull();
    const outOfScope = await callRoute(getCustomerRoute, VIEWERS.partner, { id: "1071" });
    const missing = await callRoute(getCustomerRoute, VIEWERS.partner, { id: "999999999" });
    expect(outOfScope).toEqual({ status: 404, body: { error: "Customer not found" } });
    expect(outOfScope).toEqual(missing);
    expect(JSON.stringify(outOfScope.body)).not.toContain("B21");

    // The raw-event drill-down behind an out-of-scope customer gives the same answer.
    const foreignRaw = (await getCustomerJourney(pool, 1071, null))!.timeline[0].rawEventId;
    const rawOutOfScope = await callRoute(getRawEventRoute, VIEWERS.partner, { id: "1071", rawEventId: String(foreignRaw) });
    const rawMissing = await callRoute(getRawEventRoute, VIEWERS.partner, { id: "999999999", rawEventId: String(foreignRaw) });
    expect(rawOutOfScope).toEqual({ status: 404, body: { error: "Customer not found" } });
    expect(rawOutOfScope).toEqual(rawMissing);

    // Prospects follow the same rule.
    const prospectId = Number((await linkOf("calls", "CAL-72")).rows[0].identity_id);
    expect(await getProspectJourney(pool, prospectId, null)).not.toBeNull();
    expect(await getProspectJourney(pool, prospectId, PARTNER_SCOPE)).toBeNull();
    const prospectOutOfScope = await callRoute(getCustomerRoute, VIEWERS.partner, { id: `P-${prospectId}` });
    expect(prospectOutOfScope).toEqual(missing);
    expect(prospectOutOfScope).toEqual(await callRoute(getCustomerRoute, VIEWERS.partner, { id: "P-999999999" }));

    // An all-branch viewer still reads it; an explicit out-of-scope branch filter is still refused.
    expect((await callRoute(getCustomerRoute, VIEWERS.marketing, { id: "1071" })).status).toBe(200);
    expect(() => resolveScope(VIEWERS.partner, "B21")).toThrow(ForbiddenError);

    expect((await getCustomerJourney(pool, 1073, PARTNER_SCOPE))?.overview.branchId).toBe("B20");
    const search = await searchCustomers(pool, {}, PARTNER_SCOPE);
    expect(search.rows.map((r) => r.crmCustomerId)).toEqual([1073]);
    expect((await searchCustomers(pool, { q: "1071" }, PARTNER_SCOPE)).total).toBe(0);

    expect((await listIdentityConflicts(pool, {}, PARTNER_SCOPE)).total).toBe(0);
    const conflict = (await listIdentityConflicts(pool, {}, null)).rows[0];
    await expect(
      decideIdentityConflict(pool, { conflictId: conflict.id, decision: "reject", reason: "out of scope attempt", actor: "partner", now: NOW, scope: PARTNER_SCOPE }),
    ).rejects.toMatchObject({ status: 404 });
    expect(VIEWERS.partner.can.reviewIdentity).toBe(false);
  });

  it("every timeline item references a stored projection row and its raw event, and the drill-down returns the redacted payload", async () => {
    await ingest(pool, "calls", [call("CAL-81", "B20", "+12125550181", at(-3))]);
    await ingest(pool, "web", [web("msg-81", "B20", "+12125550181", "kim@example.com", at(-2))]);
    await ingest(pool, "crm", [...crmCustomer(1081, "B20", "+12125550181", at(0)), crm.payment(51081, 1081, 31081, "B20", "-10.00", at(90), "1", "41081")]);
    await resolveIdentities(pool, NOW);
    const journey = (await getCustomerJourney(pool, 1081, null))!;
    expect(journey.timeline.length).toBeGreaterThanOrEqual(8);

    const keyColumn: Record<string, string> = {
      leads: "id", crm_customers: "crm_customer_id", crm_subscriptions: "crm_subscription_id", crm_appointments: "crm_appointment_id",
      crm_tickets: "crm_ticket_id", crm_payments: "crm_payment_id",
    };
    for (const item of journey.timeline) {
      const row = await pool.query(`select raw_event_id from ${item.sourceTable} where ${keyColumn[item.sourceTable]} = $1`, [item.sourceId]);
      expect(row.rowCount, item.key).toBe(1);
      expect(Number(row.rows[0].raw_event_id), item.key).toBe(item.rawEventId);
      const raw = await getJourneyRawEvent(pool, journey, item.rawEventId);
      expect(raw?.adapterVersion, item.key).toBe(item.adapterVersion);
      expect(raw?.versions.some((v) => v.id === item.rawEventId && v.current)).toBe(true);
    }
    // Stored payloads are redacted: the web lead's phone and email are hash tokens.
    const webItem = journey.timeline.find((t) => t.sourceRecordId === "msg-81")!;
    const payload = JSON.stringify((await getJourneyRawEvent(pool, journey, webItem.rawEventId))!.payload);
    expect(payload).toContain("h:phone:");
    expect(payload).toContain("h:email:");
    expect(payload).not.toContain("kim@example.com");

    // A raw event that is not part of this journey is not served through it.
    await ingest(pool, "calls", [call("CAL-99", "B20", "+12125550199", at(-3))]);
    const other = Number((await one<{ raw_event_id: string }>(pool, "select raw_event_id from leads where source_lead_id = 'CAL-99'")).raw_event_id);
    expect(await getJourneyRawEvent(pool, journey, other)).toBeNull();
  });
});
