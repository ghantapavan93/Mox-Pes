import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as setRole } from "@/app/api/role/route";
import { demoModeEnabled } from "@/lib/demo-mode";
import { ROLES, VIEWERS, viewerFromRole } from "@/lib/viewer";
import { isCrossSiteWrite } from "@/proxy";

/**
 * How a role is established, and what cannot establish one (docs/agent-work/SECURITY-ASVS.md).
 * The only input is the rs_role cookie, and only in demo mode; a production build without
 * DEMO_MODE=1 treats everyone as a read-only guest whatever they send.
 */
afterEach(() => vi.unstubAllEnvs());

const post = (body: unknown, url = "http://localhost/api/role", headers: Record<string, string> = {}) =>
  setRole(new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }));

describe("role establishment", () => {
  it("a production build without DEMO_MODE refuses the role picker and ignores any role", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "");
    expect(demoModeEnabled()).toBe(false);
    expect((await post({ role: "approver" })).status).toBe(404);
  });

  it("only the listed roles can be picked; anything else is a validation error, never a grant", async () => {
    for (const role of ["admin", "APPROVER", "approver ", "__proto__", "toString", ""]) {
      expect((await post({ role })).status, role).toBe(400);
    }
    expect(viewerFromRole("__proto__")).toBe(VIEWERS.guest);
    expect(viewerFromRole("constructor")).toBe(VIEWERS.guest);
  });

  it("the role cookie is httpOnly and SameSite=Lax, and Secure whenever the request came over TLS", async () => {
    const plain = (await post({ role: "marketing" })).headers.get("set-cookie") ?? "";
    expect(plain).toMatch(/HttpOnly/i);
    expect(plain).toMatch(/SameSite=lax/i);
    expect(plain).not.toMatch(/Secure/i);
    const tls = (await post({ role: "marketing" }, "http://localhost/api/role", { "x-forwarded-proto": "https" })).headers.get("set-cookie") ?? "";
    expect(tls).toMatch(/Secure/i);
  });

  it("every role has its own subject, so separation of duties can compare people", () => {
    const subjects = ROLES.map((r) => VIEWERS[r].subject);
    expect(new Set(subjects).size).toBe(ROLES.length);
  });
});

describe("cross-site write refusal (proxy.ts)", () => {
  const req = (over: Partial<Parameters<typeof isCrossSiteWrite>[0]>) =>
    isCrossSiteWrite({ method: "POST", pathname: "/api/proposals/1", origin: "http://localhost:3000", host: "localhost:3000", fetchSite: "same-origin", ...over });

  it("same-origin writes and reads pass", () => {
    expect(req({})).toBe(false);
    expect(req({ method: "GET", origin: "https://evil.example", fetchSite: "cross-site" })).toBe(false);
    expect(req({ origin: null, fetchSite: null })).toBe(false); // server-to-server and tools send neither
  });

  it("a write from another site is refused, by Origin or by Fetch Metadata", () => {
    expect(req({ origin: "https://evil.example" })).toBe(true);
    expect(req({ origin: "http://localhost:3001" })).toBe(true);
    expect(req({ origin: null, fetchSite: "cross-site" })).toBe(true);
    expect(req({ origin: "null" })).toBe(true); // sandboxed frames and file: pages
    expect(req({ method: "DELETE", origin: "https://evil.example" })).toBe(true);
  });

  it("machine routes authenticated by key are exempt", () => {
    expect(req({ pathname: "/api/ingest/calls", origin: "https://partner.example" })).toBe(false);
    expect(req({ pathname: "/api/ingestion", origin: "https://evil.example" })).toBe(true);
  });
});
