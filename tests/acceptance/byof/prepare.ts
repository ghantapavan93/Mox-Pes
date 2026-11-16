/**
 * Step 1 of `npm run acceptance:byof` (docs/agent-work/BYOF-WORKFLOW.md): an EMPTY workspace.
 * It refuses the demo database and a port already in use, creates the acceptance database if it
 * is missing, then drops its schema and applies the migrations: no seed, no reference rows, no
 * ledger records, no campaign mappings, no currency rules. Everything the proof sees afterwards
 * arrives through the upload screen.
 */
import net from "node:net";
import { Pool } from "pg";
import { createPool } from "@/lib/db";
import { migrate, resetSchema } from "@/lib/migrate";
import { acceptanceDatabaseName, acceptanceDatabaseUrl, acceptancePort } from "../b09/env";
import { BYOF } from "./settings";

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
  const url = acceptanceDatabaseUrl(BYOF.database);
  const name = acceptanceDatabaseName(BYOF.database);
  const port = acceptancePort(BYOF.port);
  if (await listening(port)) {
    throw new Error(`refusing to run: something already listens on port ${port}. This runner starts its own server and never reuses one. Stop it, or set ACCEPTANCE_PORT to a free port.`);
  }
  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const admin = new Pool({ connectionString: maintenance.toString(), max: 1 });
  try {
    const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [name]);
    // The name matched ^revenue_signal_acceptance(_[a-z0-9_]+)?$, so quoting it is safe.
    if (!rowCount) await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  const pool = createPool(url);
  try {
    await resetSchema(pool);
    await migrate(pool, (line) => console.log(`[migrate] ${line}`));
    console.log(`[acceptance] ${name} is empty: migrations only. The server will use port ${port}.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[acceptance] ${(error as Error).message}`);
  process.exit(1);
});
