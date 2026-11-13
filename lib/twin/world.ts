import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { createPool } from "@/lib/db";
import { seed } from "@/lib/sim/seed";
import { freeBytesOnServer } from "./disk";

/**
 * The twin's isolated world: a separate Postgres database per evaluation, cloned from a BASE
 * database that holds the synthetic world as it stood before calls@1.2 shipped (calls@1.0 before
 * the call-feed fix, calls@1.1 after it). The base is built once by the production seed
 * (`versionsAfterFix: { calls: "1.1" }`) and rebuilt only when its recipe changes: the
 * migrations, the seed, the world generator, or this recipe. Its fingerprint is stored as the
 * database's comment.
 *
 * Nothing here touches the application's own database except to read its connection URL.
 */

/** A clean-checkout verification names its own base (TWIN_BASE_DATABASE=rso_twin_verify_base) and builds it from scratch. */
export const TWIN_BASE_DATABASE = process.env.TWIN_BASE_DATABASE ?? "rso_twin_base";
/** Bump when the base world's recipe changes in a way the hashed files below do not show. */
const BASE_RECIPE = "twin-base-v1: production seed, calls@1.1 after the call-feed fix";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The same server, another database. */
export function databaseUrl(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** A database identifier the twin creates or drops: never anything it did not name itself. */
export function assertTwinDatabase(name: string): void {
  if (!/^rso_twin_[a-z0-9_]{1,50}$/.test(name)) throw new Error(`Refusing to manage database "${name}": not a twin database`);
}

/** Every file under `dir` (relative to the repository), sorted, as "path:sha256" lines; line endings normalised. */
function treeDigest(dir: string, skip: (rel: string) => boolean = () => false): string[] {
  const root = process.cwd();
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${rel}/${entry.name}`;
      if (skip(child)) continue;
      if (entry.isDirectory()) walk(child);
      else out.push(`${child}:${sha256(readFileSync(path.join(root, child), "utf8").replace(/\r\n/g, "\n"))}`);
    }
  };
  walk(dir);
  return out;
}

/**
 * The base world's recipe: the migrations and every library module the seed can reach (all of
 * lib/, except the twin itself), so a change to any import of the seed rebuilds it (independent
 * review 2026-11-12, SRE M6: hashing seven named files missed their imports).
 */
export function baseFingerprint(): string {
  return sha256([BASE_RECIPE, ...treeDigest("database/migrations"), ...treeDigest("lib", (rel) => rel === "lib/twin")].join("\n"));
}

/** The code that computes a verdict: the migrations and all of lib/, the twin included. */
export function codeFingerprint(): string {
  return sha256([BASE_RECIPE, ...treeDigest("database/migrations"), ...treeDigest("lib")].join("\n"));
}

async function withAdmin<T>(mainUrl: string, fn: (admin: Pool) => Promise<T>): Promise<T> {
  const admin = createPool(databaseUrl(mainUrl, "postgres"));
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(admin: Pool, name: string): Promise<void> {
  assertTwinDatabase(name);
  await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [name]);
  await admin.query(`drop database if exists ${name}`);
}

export interface BaseInfo {
  fingerprint: string;
  built: boolean;
  buildMs: number;
}

/**
 * Makes sure the base world exists and matches the recipe; builds it (about a minute) when not.
 * Serialised by an advisory lock, so two evaluations never build it at once.
 */
export async function ensureBase(mainUrl: string, log: (line: string) => void = () => {}): Promise<BaseInfo> {
  assertTwinDatabase(TWIN_BASE_DATABASE);
  const fingerprint = baseFingerprint();
  return withAdmin(mainUrl, async (admin) => {
    const lock = await admin.connect();
    try {
      // Wait for another build at most ten minutes; a lock held longer is an error, not a hang.
      for (let waited = 0; ; waited += 2_000) {
        if ((await lock.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext($1)) as ok", [TWIN_BASE_DATABASE])).rows[0].ok) break;
        if (waited >= 10 * 60_000) throw new Error(`The base world ${TWIN_BASE_DATABASE} has been locked by another build for ten minutes`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      const current = await admin.query<{ comment: string | null }>(
        "select shobj_description(oid, 'pg_database') as comment from pg_database where datname = $1",
        [TWIN_BASE_DATABASE],
      );
      if (current.rows[0]?.comment === fingerprint) return { fingerprint, built: false, buildMs: 0 };
      const started = Date.now();
      log(`twin: building the base world ${TWIN_BASE_DATABASE} (calls@1.1 after the call-feed fix)`);
      await dropDatabase(admin, TWIN_BASE_DATABASE);
      await admin.query(`create database ${TWIN_BASE_DATABASE}`);
      const base = createPool(databaseUrl(mainUrl, TWIN_BASE_DATABASE));
      try {
        await seed(base, { versionsAfterFix: { calls: "1.1" }, log: (line) => log(`twin base: ${line}`) });
      } finally {
        await base.end();
      }
      await admin.query(`comment on database ${TWIN_BASE_DATABASE} is '${fingerprint}'`);
      return { fingerprint, built: true, buildMs: Date.now() - started };
    } finally {
      await lock.query("select pg_advisory_unlock(hashtext($1))", [TWIN_BASE_DATABASE]).catch(() => undefined);
      lock.release();
    }
  });
}

/** A fresh copy of the base for one evaluation (any earlier copy of that name is dropped). */
export async function cloneWorld(mainUrl: string, name: string): Promise<number> {
  assertTwinDatabase(name);
  return withAdmin(mainUrl, async (admin) => {
    const started = Date.now();
    await dropDatabase(admin, name);
    // FILE_COPY: a block copy of the template, seconds for the ~200 MB world.
    await admin.query(`create database ${name} template ${TWIN_BASE_DATABASE} strategy file_copy`);
    return Date.now() - started;
  });
}

export async function worldExists(mainUrl: string, name: string): Promise<boolean> {
  assertTwinDatabase(name);
  return withAdmin(mainUrl, async (admin) => (await admin.query("select 1 from pg_database where datname = $1", [name])).rowCount === 1);
}

/** Twin databases on this server whose names start with `prefix` (a control database's own prefix). */
export async function listWorlds(mainUrl: string, prefix: string): Promise<string[]> {
  return withAdmin(mainUrl, async (admin) =>
    (await admin.query<{ datname: string }>("select datname from pg_database where starts_with(datname, $1) order by datname", [prefix])).rows
      .map((r) => r.datname)
      .filter((name) => /^rso_twin_[a-z0-9_]{1,50}$/.test(name)),
  );
}

export async function dropWorld(mainUrl: string, name: string): Promise<void> {
  await withAdmin(mainUrl, (admin) => dropDatabase(admin, name));
}

/**
 * What the next clone will write (lib/twin/disk.ts): a copy of the base when it is current, or
 * a rebuilt base AND its copy (about twice the control database) when it is missing or outdated.
 */
export async function cloneBytesNeeded(mainUrl: string): Promise<number> {
  return withAdmin(mainUrl, async (admin) => {
    const { rows } = await admin.query<{ comment: string | null; bytes: string }>(
      "select shobj_description(oid, 'pg_database') as comment, pg_database_size(oid) as bytes from pg_database where datname = $1",
      [TWIN_BASE_DATABASE],
    );
    if (rows[0]?.comment === baseFingerprint()) return Number(rows[0].bytes);
    const control = await admin.query<{ bytes: string }>("select pg_database_size($1) as bytes", [databaseName(mainUrl)]);
    return 2 * Number(control.rows[0].bytes);
  });
}

/** Free bytes on the database server's data volume (fail-closed: lib/twin/disk.ts). */
export async function serverFreeBytes(mainUrl: string): Promise<number> {
  return withAdmin(mainUrl, (admin) => freeBytesOnServer(admin, new URL(mainUrl).hostname));
}
