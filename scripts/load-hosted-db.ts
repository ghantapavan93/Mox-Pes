import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Pool } from "pg";
import { createPool } from "@/lib/db";
import { seed } from "@/lib/sim/seed";
import { readClipboard, writeClipboard } from "./clipboard";

/**
 * Loads the synthetic demo world into a hosted Postgres (a Neon branch, behind the Vercel deployment):
 * `npm run db:load-hosted`. It seeds a fresh local copy, dumps it, and restores the dump into
 * the hosted database in one transaction. Copying the finished world takes seconds; replaying
 * the seed's daily runs over the internet would take a round trip per query. Rerun it to reset
 * the hosted demo. Steps: docs/deploy.md.
 *
 * The hosted URL comes from HOSTED_DATABASE_URL, the clipboard (`-- --from-clipboard`, Windows),
 * or a hidden prompt. It is never printed and never put on a command line: pg_restore reads it
 * from PG* environment variables. On Windows a successful load leaves the exact DATABASE_URL
 * value for Vercel (the URL with its sslmode) on the clipboard.
 *
 * Environment: LOCAL_ADMIN_URL (default postgres://postgres@127.0.0.1:54333/postgres), the local
 * server the copy is built on; PG_BIN, the folder holding pg_dump and pg_restore (default
 * C:\Program Files\PostgreSQL\17\bin on Windows, otherwise PATH); ALLOW_LOCAL_TARGET=1 to restore
 * into a local database, for a rehearsal.
 */

const LOCAL_COPY = "revenue_signal_deploy";
/** Local databases this script must never overwrite: the demo, the release candidate, the tests. */
const PROTECTED = new Set(["postgres", "revenue_signal", "revenue_signal_rc", "revenue_signal_test", LOCAL_COPY]);
/** Node TLS errors that mean "the certificate did not verify", as opposed to a refused login. */
const CERT_ERRORS = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
]);

type AppSslMode = "verify-full" | "no-verify" | "disable";

function isLocalHost(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
}

function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

function withSslMode(url: URL, mode: AppSslMode): string {
  const copy = new URL(url.toString());
  copy.searchParams.set("sslmode", mode);
  return copy.toString();
}

/** libpq settings for pg_dump / pg_restore, so no password appears in a process's arguments. */
function libpqEnv(url: URL, sslmode: "require" | "disable"): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: databaseName(url),
    PGSSLMODE: sslmode,
  };
}

function pgTool(tool: "pg_dump" | "pg_restore"): string {
  const dir = process.env.PG_BIN ?? (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\17\\bin" : "");
  if (!dir) return tool;
  return path.join(dir, process.platform === "win32" ? `${tool}.exe` : tool);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with code ${code}`)),
    );
  });
}

/**
 * Asks for a value without echoing it (the URL holds the database password). Each character
 * shows as "*", so a paste visibly registers while its text stays hidden.
 */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const internals = rl as unknown as { _writeToOutput: (text: string) => void; line: string };
    const write = internals._writeToOutput.bind(rl);
    let masked = false;
    internals._writeToOutput = (text: string) => {
      if (!masked) return write(text);
      write(`\r\x1b[2K${question}${"*".repeat(internals.line.length)}`);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    masked = true;
  });
}

const PASTE_HELP =
  "In Neon's Connect dialog, turn Connection pooling off and click the copy button beside the " +
  "connection string, then paste here (right-click or Ctrl+V) and press Enter.";
const FROM_CLIPBOARD = process.argv.includes("--from-clipboard");
const DATABASE_URL_PATTERN = /^postgres(ql)?:\/\//;

/** The hosted URL: HOSTED_DATABASE_URL, the clipboard when asked, or three tries at the hidden prompt. */
async function readHostedUrl(): Promise<string> {
  if (process.env.HOSTED_DATABASE_URL) return process.env.HOSTED_DATABASE_URL;
  if (FROM_CLIPBOARD) {
    const clipboard = await readClipboard();
    if (DATABASE_URL_PATTERN.test(clipboard)) return clipboard;
    console.log("The clipboard does not hold a database URL.");
  }
  console.log(PASTE_HELP);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const answer = await askHidden("Neon connection string: ");
    if (DATABASE_URL_PATTERN.test(answer)) return answer;
    console.log(
      answer === ""
        ? "Nothing was pasted. " + PASTE_HELP
        : `That was ${answer.length} characters but not a database URL; it starts with postgresql://. ` + PASTE_HELP,
    );
  }
  throw new Error("No database URL after three tries; nothing was changed.");
}

async function hostedTarget(): Promise<URL> {
  const raw = await readHostedUrl();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That is not a database URL. Copy the connection string from Neon's Connect dialog.");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error("The URL must start with postgres:// or postgresql://.");
  // A host with no domain is a name inside some private network, not one this computer can reach.
  if (!isLocalHost(url) && !url.hostname.includes(".")) {
    throw new Error("That host has no domain, so it is not reachable from here. Copy the connection string Neon's Connect dialog shows.");
  }
  // Neon's pooler (PgBouncer, transaction mode) cannot hold the restore's single transaction.
  if (url.hostname.includes("-pooler.")) {
    throw new Error("That is Neon's pooled connection string. Turn Connection pooling off in the Connect dialog and copy it again.");
  }
  if (isLocalHost(url)) {
    if (process.env.ALLOW_LOCAL_TARGET !== "1") {
      throw new Error("That URL points at this computer. Set ALLOW_LOCAL_TARGET=1 only for a rehearsal.");
    }
    if (PROTECTED.has(databaseName(url))) throw new Error(`Refusing to overwrite the local ${databaseName(url)} database.`);
  }
  return url;
}

/**
 * The sslmode the app's own driver (node-postgres) needs for this server: full certificate
 * checks when they pass, otherwise encryption without them. Any other failure is reported as is.
 */
async function appSslMode(url: URL): Promise<AppSslMode> {
  if (isLocalHost(url)) return "disable";
  for (const mode of ["verify-full", "no-verify"] as const) {
    const pool = new Pool({ connectionString: withSslMode(url, mode), max: 1 });
    try {
      await pool.query("select 1");
      return mode;
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (mode === "verify-full" && CERT_ERRORS.has(code)) continue;
      throw error;
    } finally {
      await pool.end();
    }
  }
  throw new Error("unreachable");
}

async function buildLocalCopy(adminUrl: URL): Promise<URL> {
  const admin = createPool(adminUrl.toString());
  try {
    await admin.query(`drop database if exists ${LOCAL_COPY} with (force)`);
    await admin.query(`create database ${LOCAL_COPY}`);
  } finally {
    await admin.end();
  }
  const localUrl = new URL(adminUrl.toString());
  localUrl.pathname = `/${LOCAL_COPY}`;
  const pool = createPool(localUrl.toString());
  try {
    await seed(pool, { log: (line) => console.log(`  ${line}`) });
  } finally {
    await pool.end();
  }
  return localUrl;
}

/** Exact row counts per table, keyed "schema.table". */
async function rowCounts(pool: Pool): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ schema: string; name: string }>(
    `select table_schema as schema, table_name as name from information_schema.tables
     where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')
     order by 1, 2`,
  );
  const counts = new Map<string, number>();
  for (const { schema, name } of rows) {
    const quoted = `"${schema.replace(/"/g, '""')}"."${name.replace(/"/g, '""')}"`;
    const result = await pool.query<{ n: string }>(`select count(*) as n from ${quoted}`);
    counts.set(`${schema}.${name}`, Number(result.rows[0].n));
  }
  return counts;
}

async function main() {
  const target = await hostedTarget();
  const sslmode = await appSslMode(target);
  console.log(`Connected to ${target.hostname}, database ${databaseName(target)} (app sslmode: ${sslmode}).`);

  console.log(`Seeding a fresh local copy (${LOCAL_COPY})…`);
  const adminUrl = new URL(process.env.LOCAL_ADMIN_URL ?? "postgres://postgres@127.0.0.1:54333/postgres");
  const localUrl = await buildLocalCopy(adminUrl);

  const dir = await mkdtemp(path.join(tmpdir(), "rs-load-"));
  const dumpFile = path.join(dir, "demo.dump");
  try {
    console.log("Dumping the local copy…");
    await run(pgTool("pg_dump"), ["--format=custom", "--no-owner", "--no-privileges", `--file=${dumpFile}`], libpqEnv(localUrl, "disable"));

    console.log("Restoring into the hosted database (one transaction)…");
    await run(
      pgTool("pg_restore"),
      [
        // pg_restore needs the target named; only the name goes on the command line, the
        // password stays in PGPASSWORD.
        `--dbname=${databaseName(target)}`,
        "--no-owner",
        "--no-privileges",
        "--clean",
        "--if-exists",
        "--single-transaction",
        "--exit-on-error",
        dumpFile,
      ],
      libpqEnv(target, isLocalHost(target) ? "disable" : "require"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const local = new Pool({ connectionString: localUrl.toString(), max: 1 });
  const hosted = new Pool({ connectionString: withSslMode(target, sslmode), max: 1 });
  try {
    // A restore leaves the planner without statistics until autovacuum runs; the app's
    // queries are planned for analysed tables.
    await hosted.query("analyze");
    const [want, got] = await Promise.all([rowCounts(local), rowCounts(hosted)]);
    const mismatched = [...want].filter(([table, n]) => got.get(table) !== n);
    const rows = [...want.values()].reduce((sum, n) => sum + n, 0);
    if (mismatched.length > 0) {
      for (const [table, n] of mismatched) console.error(`  ${table}: local ${n}, hosted ${got.get(table) ?? "missing"}`);
      throw new Error(`${mismatched.length} table(s) differ after the restore.`);
    }
    console.log(`Verified: ${want.size} tables, ${rows.toLocaleString("en-US")} rows, identical to the local copy.`);
  } finally {
    await Promise.all([local.end(), hosted.end()]);
  }

  console.log("");
  if (process.platform === "win32" && !isLocalHost(target)) {
    await writeClipboard(withSslMode(target, sslmode));
    console.log("Done. Your clipboard now holds the exact DATABASE_URL value for Vercel: paste it into Value.");
  } else {
    console.log(`Done. In Vercel, set DATABASE_URL to the same URL with ?sslmode=${sslmode} at the end.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
