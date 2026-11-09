import type { Pool, PoolClient } from "pg";

/**
 * Runs a pool-based unit of work inside a transaction that is already open.
 *
 * `replay()` (lib/ingest/replay.ts) takes a Pool and opens its own transaction through
 * withTransaction/withRollback. An Action Center execution must run the replay, the
 * re-reconciliation, the verification and the case bookkeeping as ONE atomic unit, so a
 * failure anywhere rolls back everything. This adapter hands such a function a Pool-shaped
 * object whose single "connection" is the caller's transaction client, with the
 * transaction verbs mapped to savepoints:
 *
 *   begin → savepoint · commit → release savepoint · rollback → rollback to savepoint
 *
 * so the nested unit keeps its own all-or-nothing semantics and its own error handling,
 * while its effects only become durable when the outer transaction commits.
 *
 * It implements exactly the surface lib/db's withTransaction/withRollback and replay() use
 * (connect, query, client.query, client.release); it is not a general pool. The cast is
 * confined here. The intended replacement is a transaction-accepting core exported by
 * lib/ingest/replay.ts (requested from the integrator), after which this file goes away.
 */
export function nestedPool(tx: PoolClient): Pool {
  let counter = 0;
  const open: string[] = [];

  const client = {
    async query(text: unknown, params?: unknown[]) {
      if (typeof text === "string") {
        const verb = text.trim().toLowerCase();
        if (verb === "begin") {
          const name = `rs_nested_${++counter}`;
          open.push(name);
          return tx.query(`savepoint ${name}`);
        }
        if (verb === "commit") {
          const name = open.pop();
          if (!name) throw new Error("nestedPool: commit without begin");
          return tx.query(`release savepoint ${name}`);
        }
        if (verb === "rollback") {
          const name = open.pop();
          if (!name) throw new Error("nestedPool: rollback without begin");
          await tx.query(`rollback to savepoint ${name}`);
          return tx.query(`release savepoint ${name}`);
        }
        return tx.query(text, params);
      }
      throw new Error("nestedPool supports text queries only");
    },
    release() {
      // The outer transaction owns the connection.
    },
  };

  const pool = {
    connect: async () => client,
    query: (text: string, params?: unknown[]) => tx.query(text, params),
  };
  return pool as unknown as Pool;
}
