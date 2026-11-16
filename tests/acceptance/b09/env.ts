import path from "node:path";
import { DEFAULT_DATABASE_URL } from "@/lib/db";

/**
 * Where the B09 acceptance runner may run (docs/agent-work/B09-ACCEPTANCE-RUNNER.md): its own
 * database and its own port, never the demo's.
 *
 * - Database: ACCEPTANCE_DATABASE_URL, default the demo server's address with the database
 *   revenue_signal_acceptance. The name must be revenue_signal_acceptance or
 *   revenue_signal_acceptance_<suffix>. DATABASE_URL is never read, so a shell pointed at the demo
 *   database cannot redirect the runner there.
 * - Port: ACCEPTANCE_PORT, default 3990, never 3000 (the demo's). Playwright starts the server
 *   there and refuses to run if anything already listens (reuseExistingServer: false).
 * - Output: ACCEPTANCE_OUT, default test-results/acceptance-b09 (ignored by git).
 */

export const REPO = path.resolve(__dirname, "../../..");

const ACCEPTANCE_DB = /^revenue_signal_acceptance(_[a-z0-9_]+)?$/;

/**
 * The acceptance database. Each runner passes its own default name (the B09 proof uses
 * revenue_signal_acceptance; the bring-your-own-file proof, revenue_signal_acceptance_byof), so
 * the two never share a world unless ACCEPTANCE_DATABASE_URL says so.
 */
export function acceptanceDatabaseUrl(defaultName = "revenue_signal_acceptance"): string {
  const url = new URL(process.env.ACCEPTANCE_DATABASE_URL ?? DEFAULT_DATABASE_URL.replace(/\/[^/]+$/, `/${defaultName}`));
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!ACCEPTANCE_DB.test(name)) {
    throw new Error(`refusing to run: the database is "${name}". The B09 acceptance runner uses only revenue_signal_acceptance or revenue_signal_acceptance_<suffix>, never the demo database.`);
  }
  return url.toString();
}

export function acceptanceDatabaseName(defaultName?: string): string {
  return decodeURIComponent(new URL(acceptanceDatabaseUrl(defaultName)).pathname.slice(1));
}

export function acceptancePort(defaultPort = 3990): number {
  const raw = process.env.ACCEPTANCE_PORT ?? String(defaultPort);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3000) {
    throw new Error(`refusing to run: ACCEPTANCE_PORT is "${raw}". Use a free port from 1024 to 65535 other than 3000, the demo's.`);
  }
  return port;
}

export function acceptanceOut(defaultDir = path.join("test-results", "acceptance-b09")): string {
  return path.resolve(REPO, process.env.ACCEPTANCE_OUT ?? defaultDir);
}
