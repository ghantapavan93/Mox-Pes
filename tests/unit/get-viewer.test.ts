import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R-20: the viewer must always be read from the request, even when demo mode is off.
 *
 * Under cacheComponents, a server component that touches no request API is prerendered into the
 * static shell at build time. `next build` runs without DEMO_MODE (the flag is given to
 * `next start`), so when getViewer returned the guest before calling cookies(), the viewer was
 * baked into every page as "Guest · read-only". The request-time payload named the real role,
 * and React threw hydration error #418 on every page for any non-guest role. The production
 * browser gate (z-quality-gates, "hydration") proves the symptom is gone; this pins the cause
 * without a build.
 *
 * The visitor workspace (release design §5.1) adds one step to the order: the guest of a
 * deployment with PUBLIC_WORKSPACE=1 is the workspace guest, owned by its `rs_visitor` token.
 */

let jar: Record<string, string> = {};
const cookies = vi.fn(async () => ({ get: (name: string) => (Object.hasOwn(jar, name) ? { name, value: jar[name] } : undefined) }));
vi.mock("next/headers", () => ({ cookies }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getNow: vi.fn(), getPool: vi.fn(), withTransaction: vi.fn() }));
// connection() throws outside a request; getViewer waits for it so a prerender stops before any read.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const TOKEN = "A".repeat(43);
const ownerOf = (token: string) => `visitor:${createHash("sha256").update(token).digest("hex")}`;

describe("getViewer", () => {
  beforeEach(() => {
    cookies.mockClear();
    jar = { rs_role: "approver" };
  });
  afterEach(() => vi.unstubAllEnvs());

  it("reads the request even when demo mode is off, and still returns the guest", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "");
    const { getViewer } = await import("@/lib/server");
    const viewer = await getViewer();
    expect(cookies).toHaveBeenCalledTimes(1);
    expect(viewer.role).toBe("guest");
    expect(viewer.can.workspace).toBe(false);
  });

  it("uses the role cookie when demo mode is on", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "1");
    const { getViewer } = await import("@/lib/server");
    const viewer = await getViewer();
    expect(cookies).toHaveBeenCalledTimes(1);
    expect(viewer.role).toBe("approver");
  });

  it("gives the guest its workspace when PUBLIC_WORKSPACE=1, owned by its visitor token", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("PUBLIC_WORKSPACE", "1");
    jar = { rs_role: "approver", rs_visitor: TOKEN };
    const { getViewer } = await import("@/lib/server");
    const viewer = await getViewer();
    // Outside demo mode the role cookie is not trusted: the guest, then the workspace guest.
    expect(viewer.role).toBe("guest");
    expect(viewer.subject).toBe(ownerOf(TOKEN));
    expect(viewer.can).toMatchObject({ workspace: true, propose: false, approve: false, investigate: false, dryRun: false });
  });

  it("gives a guest without a valid token the workspace under demo:guest, which owns nothing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("PUBLIC_WORKSPACE", "1");
    for (const visitor of [undefined, "short", `${TOKEN}=`, "A".repeat(42) + "*"]) {
      jar = visitor === undefined ? {} : { rs_visitor: visitor };
      const { getViewer } = await import("@/lib/server");
      const viewer = await getViewer();
      expect(viewer.subject).toBe("demo:guest");
      expect(viewer.can.workspace).toBe(true);
    }
  });

  it("never gives a staff role the workspace, flag or not", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "1");
    vi.stubEnv("PUBLIC_WORKSPACE", "1");
    jar = { rs_role: "engineer", rs_visitor: TOKEN };
    const { getViewer } = await import("@/lib/server");
    const viewer = await getViewer();
    expect(viewer.role).toBe("engineer");
    expect(viewer.subject).toBe("demo:engineer");
    expect(viewer.can.workspace).toBe(false);
  });

  it("keeps the read-only guest when the flag is off", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "1");
    vi.stubEnv("PUBLIC_WORKSPACE", "");
    jar = { rs_visitor: TOKEN };
    const { getViewer } = await import("@/lib/server");
    const viewer = await getViewer();
    expect(viewer.role).toBe("guest");
    expect(viewer.can.workspace).toBe(false);
  });
});

describe("viewerForWorkspaceStart", () => {
  beforeEach(() => {
    jar = {};
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("PUBLIC_WORKSPACE", "1");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("creates a token for a guest without one, so the item gets a real owner", async () => {
    const { viewerForWorkspaceStart } = await import("@/lib/server");
    const { viewer, setCookie } = await viewerForWorkspaceStart(new Request("https://demo.example/api/onboarding/uploads", { method: "POST" }));
    expect(setCookie).not.toBeNull();
    expect(setCookie!.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(viewer.subject).toBe(ownerOf(setCookie!.value));
    expect(setCookie).toMatchObject({ name: "rs_visitor", httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 86_400 });
  });

  it("re-sends the same token with a fresh Max-Age, and Secure follows the scheme", async () => {
    jar = { rs_visitor: TOKEN };
    const { viewerForWorkspaceStart } = await import("@/lib/server");
    const { viewer, setCookie } = await viewerForWorkspaceStart(new Request("http://localhost:3989/api/onboarding/uploads", { method: "POST" }));
    expect(setCookie).toMatchObject({ value: TOKEN, secure: false, maxAge: 86_400 });
    expect(viewer.subject).toBe(ownerOf(TOKEN));
    const behindProxy = await viewerForWorkspaceStart(new Request("http://internal/api/onboarding/uploads", { method: "POST", headers: { "x-forwarded-proto": "https" } }));
    expect(behindProxy.setCookie?.secure).toBe(true);
  });

  it("sets no cookie for a viewer without the workspace", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    jar = { rs_role: "marketing" };
    const { viewerForWorkspaceStart } = await import("@/lib/server");
    const { viewer, setCookie } = await viewerForWorkspaceStart(new Request("https://demo.example/api/onboarding/uploads", { method: "POST" }));
    expect(viewer.role).toBe("marketing");
    expect(setCookie).toBeNull();
  });
});
