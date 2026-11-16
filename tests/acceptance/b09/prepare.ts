/**
 * Step 1 of `npm run acceptance:b09` (docs/agent-work/B09-ACCEPTANCE-RUNNER.md): the isolated
 * world. It refuses the demo database and a port already in use, creates the acceptance database
 * if it is missing, and seeds it with the demo seed (the same `seed()` the browser suite uses).
 * Step 2, Playwright, then builds this checkout and starts its own server on that port.
 *
 * It runs before Playwright because Playwright starts its web server before any global setup,
 * and the server should never see a half-built world.
 */
import net from "node:net";
import { Pool } from "pg";
import { createPool } from "@/lib/db";
import { seed } from "@/lib/sim/seed";
import { acceptanceDatabaseName, acceptanceDatabaseUrl, acceptancePort } from "./env";

/** True when something accepts connections on the port, over IPv4 or IPv6. */
async function listening(port: number): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host });
      socket.setTimeout(2_000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(false));
    });
  return (await probe("127.0.0.1")) || (await probe("::1"));
}

async function main() {
  const url = acceptanceDatabaseUrl();
  const name = acceptanceDatabaseName();
  const port = acceptancePort();
  if (await listening(port)) {
    throw new Error(`refusing to run: something already listens on port ${port}. This runner starts its own server and never reuses one. Stop it, or set ACCEPTANCE_PORT to a free port.`);
  }

  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const admin = new Pool({ connectionString: maintenance.toString(), max: 1 });
  try {
    const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [name]);
    if (!rowCount) {
      // The name matched ^revenue_signal_acceptance(_[a-z0-9_]+)?$, so quoting it is safe.
      await admin.query(`create database "${name}"`);
      console.log(`[acceptance] created database ${name}`);
    }
  } finally {
    await admin.end();
  }

  const pool = createPool(url);
  try {
    console.log(`[acceptance] seeding ${name} (synthetic demo world, about a minute); the server will use port ${port}`);
    await seed(pool, { log: (line) => console.log(`[seed] ${line}`) });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[acceptance] ${(error as Error).message}`);
  process.exit(1);
});
