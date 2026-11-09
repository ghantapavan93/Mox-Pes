import { connection } from "next/server";
import { getNow } from "@/lib/db";
import { createMockFieldRoutes, dbFaultStore } from "@/lib/connectors/mock-fieldroutes";
import { generateWorld, type SourceRecordVersion } from "@/lib/sim/world";
import { getPool } from "@/lib/server";

/**
 * The FieldRoutes-compatible MOCK, served over real HTTP at /api/mock/fieldroutes/{entity}/{action}
 * so the connector exercises its full transport. Synthetic data only; demo keys only. Not a
 * FieldRoutes system and not connected to one.
 *
 * The synthetic world is generated once per server process (it takes seconds) and shared through
 * globalThis so every route bundle reuses it; records are served as of the business clock.
 */

const cache = globalThis as unknown as { __rsMockWorld?: SourceRecordVersion[]; __rsMockFieldRoutes?: (request: Request) => Promise<Response> };

function handler(): (request: Request) => Promise<Response> {
  cache.__rsMockFieldRoutes ??= createMockFieldRoutes({
    records: () => (cache.__rsMockWorld ??= generateWorld().records),
    clock: () => getNow(getPool()),
    faults: dbFaultStore(getPool()),
    basePath: "/api/mock/fieldroutes",
  });
  return cache.__rsMockFieldRoutes;
}

async function serve(request: Request): Promise<Response> {
  await connection();
  return handler()(request);
}

export const POST = serve;
// Every FieldRoutes call is POST; other methods get the mock's 405 envelope rather than Next's.
export const GET = serve;
export const PUT = serve;
export const DELETE = serve;
