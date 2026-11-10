import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as setRole } from "@/app/api/role/route";
import { POST as mockFieldRoutes } from "@/app/api/mock/fieldroutes/[...path]/route";
import { demoModeEnabled } from "@/lib/demo-mode";

/** Audit 2026-11-09 (E3/E7): a production build is not a demo unless DEMO_MODE=1 says so. */

// The mock route needs neither a database nor a request scope to refuse.
vi.mock("@/lib/server", () => ({ getPool: () => { throw new Error("no database in this test"); } }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

describe("demo mode", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is on in development and tests, off in production unless DEMO_MODE=1", () => {
    expect(demoModeEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(demoModeEnabled({ NODE_ENV: "test" })).toBe(true);
    expect(demoModeEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(demoModeEnabled({ NODE_ENV: "production", DEMO_MODE: "true" })).toBe(false);
    expect(demoModeEnabled({ NODE_ENV: "production", DEMO_MODE: "1" })).toBe(true);
  });

  const request = () => new Request("http://localhost/api/role", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "approver" }) });

  it("POST /api/role refuses in a production build without the flag, and sets no cookie", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "");
    const res = await setRole(request());
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("POST /api/role works in a production build started with DEMO_MODE=1", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "1");
    const res = await setRole(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/rs_role=approver/);
  });

  it("the FieldRoutes mock is not served by a production build without the flag", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "");
    const res = await mockFieldRoutes(new Request("http://localhost/api/mock/fieldroutes/customer/search", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
  });
});
