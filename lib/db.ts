import { Pool, type PoolClient, type QueryResultRow } from "pg";

/**
 * The one database seam. Everything that touches Postgres takes a `Queryable`, so the
 * same function runs on the pool, inside a transaction, or inside a dry-run transaction
 * that is rolled back.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export const DEFAULT_DATABASE_URL = "postgres://postgres@127.0.0.1:54333/revenue_signal";

const globalForPool = globalThis as unknown as { __rsPool?: Pool };

export function getPool(): Pool {
  if (!globalForPool.__rsPool) {
    globalForPool.__rsPool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  }
  return globalForPool.__rsPool;
}

/**
 * Every connection runs in UTC, so no result depends on the database server's time zone; a
 * database on another machine is reached over TLS with a small pool (see tlsOption, poolMax).
 */
export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: poolMax(connectionString), options: "-c TimeZone=UTC", ...tlsOption(connectionString) });
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True for a database on another machine; local hosts and Unix sockets are not remote. */
function isRemoteDatabase(connectionString: string): boolean {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return false;
  }
  return Boolean(host) && !LOCAL_HOSTS.has(host);
}

/**
 * TLS for a database on another machine. Hosted Postgres (Render, behind the Vercel deployment)
 * refuses plain connections, and the URL its dashboard copies names no sslmode, so a remote host
 * gets TLS with full certificate checks by default. An sslmode in the URL still decides
 * (node-postgres lets the URL override this option). Local databases (development, tests, CI)
 * and Unix sockets stay plain.
 */
export function tlsOption(connectionString: string): { ssl?: { rejectUnauthorized: true } } {
  return isRemoteDatabase(connectionString) ? { ssl: { rejectUnauthorized: true } } : {};
}

/**
 * Connections per pool. A page runs its reads in parallel; on the hosted demo database (Render's
 * free instance, 256 MB) ten at once from one serverless instance ran the server out of memory
 * and restarted it (2026-11-16). Remote pools take three, and the other reads wait their turn.
 */
export function poolMax(connectionString: string): number {
  return isRemoteDatabase(connectionString) ? 3 : 10;
}

export async function withTransaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Runs `fn` in a transaction that is always rolled back: a what-if against real data. */
export async function withRollback<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

/**
 * Independent reads: at once on a pool (each read takes its own connection), one after another
 * on a single client. A client cannot run two queries at once; pg 8 queues them with a
 * deprecation warning and pg 9 removes the queue. Results keep the order of the reads.
 */
export async function readAll<T extends readonly unknown[]>(db: Queryable, reads: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> {
  const list = reads as unknown as ReadonlyArray<() => Promise<unknown>>;
  if (db instanceof Pool) return (await Promise.all(list.map((read) => read()))) as unknown as T;
  const out: unknown[] = [];
  for (const read of list) out.push(await read());
  return out as unknown as T;
}

/** The business clock. The demo dataset is frozen at a fixed instant; see app_clock. */
export async function getNow(db: Queryable): Promise<Date> {
  const { rows } = await db.query<{ now: Date }>("select now from app_clock");
  return rows[0]?.now ?? new Date();
}
