import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDb, testPool } from "../helpers";

/**
 * GET /api/health names the build that answered (release design WP-H): the deployed commit on
 * Vercel, null on a local build, beside the database facts it always reported. A rollback is
 * verified by this field.
 */

const route = vi.hoisted(() => ({ pool: null as unknown as Pool }));
vi.mock("@/lib/server", () => ({ getPool: () => route.pool }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

import { GET } from "@/app/api/health/route";

const pool = testPool();
route.pool = pool;

beforeAll(async () => {
  await freshDb(pool);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await pool.end();
});

describe("GET /api/health", () => {
  it("names the deployed commit when Vercel provides it", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0123456789abcdef0123456789abcdef01234567");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; commit: string | null; migrations: string[]; streams: unknown[] };
    expect(body).toMatchObject({ ok: true, commit: "0123456789abcdef0123456789abcdef01234567" });
    expect(body.migrations).toContain("0037_workspace_and_ledger_targets.sql");
    expect(Array.isArray(body.streams)).toBe(true);
  });

  it("says null on a local build", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    const body = (await (await GET()).json()) as { commit: string | null };
    expect(body.commit).toBeNull();
  });
});
