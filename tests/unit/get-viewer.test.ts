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
 */

const cookies = vi.fn(async () => ({ get: (name: string) => (name === "rs_role" ? { name, value: "approver" } : undefined) }));
vi.mock("next/headers", () => ({ cookies }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getNow: vi.fn(), getPool: vi.fn() }));
// connection() throws outside a request; getViewer waits for it so a prerender stops before any read.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

describe("getViewer", () => {
  beforeEach(() => cookies.mockClear());
  afterEach(() => vi.unstubAllEnvs());

  it("reads the request even when demo mode is off, and still returns the guest", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "");
    const { getViewer } = await import("@/lib/server");
    const viewer = await getViewer();
    expect(cookies).toHaveBeenCalledTimes(1);
    expect(viewer.role).toBe("guest");
  });

  it("uses the role cookie when demo mode is on", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "1");
    const { getViewer } = await import("@/lib/server");
    const viewer = await getViewer();
    expect(cookies).toHaveBeenCalledTimes(1);
    expect(viewer.role).toBe("approver");
  });
});
