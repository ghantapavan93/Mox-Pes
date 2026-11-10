import { describe, expect, it } from "vitest";
import { connectorConfigSchema } from "@/lib/connectors/config";

/**
 * Audit 2026-11-09 (G-6): a wire time zone other than "office" changed the search windows but
 * not the mapper, so stored instants would be wrong with no warning. It is refused until both
 * read the same zone.
 */
const base = {
  credentials: { keyEnv: "FIELDROUTES_KEY_{officeId}", tokenEnv: "FIELDROUTES_TOKEN_{officeId}", allowDemoKeys: true },
  timeoutMs: 15_000,
  wireTimeZone: "office",
  initialLookbackHours: 168,
  officeIds: null,
  maxAttempts: 5,
};

describe("connector config", () => {
  it("accepts the seeded demo config", () => {
    expect(connectorConfigSchema.safeParse(base).success).toBe(true);
  });

  it("refuses a wire time zone the mapper does not use, naming why", () => {
    const r = connectorConfigSchema.safeParse({ ...base, wireTimeZone: "America/Los_Angeles" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/deviation G1/);
  });

  it("still refuses a zone that is not a time zone at all", () => {
    expect(connectorConfigSchema.safeParse({ ...base, wireTimeZone: "Mars/Olympus" }).success).toBe(false);
  });
});
