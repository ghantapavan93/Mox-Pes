import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

const MIGRATIONS_DIR = path.join(process.cwd(), "database", "migrations");

/**
 * Applies database/migrations/*.sql in order, each in its own transaction, recording a
 * checksum. An applied migration whose file has since changed is an error: migrations
 * are append-only.
 */
export async function migrate(pool: Pool, log: (line: string) => void = () => {}): Promise<string[]> {
  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
  const applied = new Map(
    (await pool.query<{ name: string; checksum: string }>("select name, checksum from schema_migrations")).rows.map(
      (r) => [r.name, r.checksum],
    ),
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const previous = applied.get(file);
    if (previous) {
      if (previous !== checksum) throw new Error(`Migration ${file} was edited after it was applied`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [file, checksum]);
      await client.query("commit");
      log(`applied ${file}`);
      ran.push(file);
    } catch (error) {
      await client.query("rollback");
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }
  return ran;
}

/** Drops everything in the public and reporting schemas. Used by seed and tests only. */
export async function resetSchema(pool: Pool): Promise<void> {
  await pool.query("drop schema if exists reporting cascade; drop schema public cascade; create schema public;");
}
