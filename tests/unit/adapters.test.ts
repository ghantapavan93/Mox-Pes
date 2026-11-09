import { describe, expect, it } from "vitest";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { redactValue } from "@/lib/adapters/redact";
import { hashPhone } from "@/lib/primitives";
import { prepare } from "@/lib/ingest/ingest";
import { call, crm, T0 } from "../helpers";

const ctx = referenceContext;

describe("redaction happens before anything else", () => {
  it("hashes phones and emails wherever they appear, including fields no mapper knows", () => {
    const redacted = redactValue({ customer_phone_number: "+12125550142", caller: { number: "(212) 555-0142" }, note: "call back", email: "A@Example.com" }) as { customer_phone_number: string; caller: { number: string }; email: string; note: string };
    expect(redacted.customer_phone_number).toBe(`h:phone:${hashPhone("+12125550142")}`);
    expect(redacted.caller.number).toBe(redacted.customer_phone_number);
    expect(redacted.email).toMatch(/^h:email:[0-9a-f]{64}$/);
    expect(redacted.note).toBe("call back");
    expect(JSON.stringify(redacted)).not.toMatch(/555-?0142|example\.com/i);
  });
  it("is idempotent, so stored payloads can be replayed", () => {
    const once = redactValue({ p: "+12125550142" });
    expect(redactValue(once)).toEqual(once);
  });
});

describe("call-tracking mapper versions (the seeded incident)", () => {
  const legacy = call("CAL-1", "B20", "+12125550142", T0);
  const migrated = call("CAL-2", "B20", "+12125550142", T0);
  delete (migrated.payload as Record<string, unknown>).customer_phone_number;
  (migrated.payload as Record<string, unknown>).caller = { number: "+12125550142" };

  it("calls@1.0 quarantines the new shape with a precise reason", () => {
    const p = prepare(migrated, mapperFor("calls", "1.0"), ctx, T0);
    expect(p.result).toMatchObject({ ok: false, code: "MISSING_FIELD" });
    expect((p.result as { detail: string }).detail).toContain("call.customer_phone_number");
  });
  it("calls@1.1 accepts both shapes and maps them identically", () => {
    const a = prepare(legacy, mapperFor("calls", "1.1"), ctx, T0);
    const b = prepare(migrated, mapperFor("calls", "1.1"), ctx, T0);
    expect(a.result.ok && b.result.ok).toBe(true);
    if (a.result.ok && b.result.ok) {
      expect(a.result.projection.row).toMatchObject({ phoneHash: hashPhone("+12125550142") });
      expect((b.result.projection.row as { phoneHash: string }).phoneHash).toBe((a.result.projection.row as { phoneHash: string }).phoneHash);
    }
  });
  it("a call to the branch main line stays unknown — it is never upgraded to paid", () => {
    const p = prepare(call("CAL-3", "B20", "+12125550142", T0, "Direct"), mapperFor("calls"), ctx, T0);
    expect(p.result.ok && p.result.projection.row).toMatchObject({ channelCode: "unknown", attributionEvidence: "none" });
  });
  it("unknown branch tags are rejected, not defaulted", () => {
    const p = prepare(call("CAL-4", "B99", "+12125550142", T0), mapperFor("calls"), ctx, T0);
    expect(p.result).toMatchObject({ ok: false, code: "UNKNOWN_BRANCH" });
  });
});

describe("CRM mapper (FieldRoutes-shaped)", () => {
  const m = mapperFor("crm");
  it("rejects an unknown appointment status code instead of guessing", () => {
    const r = crm.appointment(1, 2, 3, "B20", "0", T0, T0);
    (r.payload as Record<string, unknown>).status = "3";
    expect(prepare(r, m, ctx, T0).result).toMatchObject({ ok: false, code: "SCHEMA_VIOLATION" });
  });
  it("treats the zero-date as null and requires dateCompleted exactly when completed", () => {
    const ok = prepare(crm.appointment(1, 2, 3, "B20", "1", T0, T0), m, ctx, T0);
    expect(ok.result.ok).toBe(true);
    const bad = crm.appointment(1, 2, 3, "B20", "1", T0, T0);
    (bad.payload as Record<string, unknown>).dateCompleted = "0000-00-00 00:00:00";
    expect(prepare(bad, m, ctx, T0).result).toMatchObject({ ok: false });
  });
  it("a refund must reference the original payment", () => {
    const refund = crm.payment(9, 1, 2, "B20", "-149.00", T0);
    expect(prepare(refund, m, ctx, T0).result).toMatchObject({ ok: false, code: "SCHEMA_VIOLATION" });
    const linked = crm.payment(9, 1, 2, "B20", "-149.00", T0, "1", "8");
    expect(prepare(linked, m, ctx, T0).result).toMatchObject({ ok: true });
  });
  it("versions records by dateUpdated so a re-read is recognisable as a duplicate", () => {
    const a = prepare(crm.customer(1, "B20", "+12125550142", T0), m, ctx, T0);
    const b = prepare(crm.customer(1, "B20", "(212) 555-0142", T0), m, ctx, T0);
    expect(a.identity.externalId).toBe(b.identity.externalId);
    expect(a.hash).toBe(b.hash); // phone formats redact to the same token
  });
  it("interprets wall time in the office's zone", () => {
    const p = prepare(crm.customer(1, "B07", "+12125550142", new Date("2026-10-01T17:00:00Z")), m, ctx, T0); // B07 = America/Phoenix
    expect(p.identity.occurredAt.toISOString()).toBe("2026-10-01T17:00:00.000Z");
  });
});
