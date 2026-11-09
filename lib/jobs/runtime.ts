import { hostname } from "node:os";
import type { Pool } from "pg";
import { getNow } from "@/lib/db";
import { BRANCH_BY_OFFICE } from "@/lib/reference";
import { resolveCredentials, type ConnectorRow, type Env } from "@/lib/connectors/config";
import { AuthError } from "@/lib/connectors/errors";
import { FieldRoutesHttpClient } from "@/lib/connectors/fieldroutes-client";
import type { ApiCallRecord, CrmConnector } from "@/lib/connectors/types";
import type { SyncRuntime } from "./sync";

/**
 * The production wiring of a SyncRuntime: real `fetch`, credentials from the environment (or
 * the mock's demo keys for a local mock), wall clock for scheduling, app_clock for data.
 * Shared by scripts/worker.ts and the API's after() kick, so both behave identically.
 */

export function connectorClient(
  connector: ConnectorRow,
  onCall: (call: ApiCallRecord) => void,
  opts: { env?: Env; fetch?: typeof fetch } = {},
): CrmConnector {
  const env = opts.env ?? process.env;
  return new FieldRoutesHttpClient({
    baseUrl: connector.baseUrl,
    credentials: (officeId) => {
      const resolved = resolveCredentials(connector, officeId, env);
      if (!resolved.credentials) {
        throw new AuthError(`No credentials for office ${officeId}: set ${resolved.keyEnv} and ${resolved.tokenEnv}`);
      }
      return resolved.credentials;
    },
    fetch: opts.fetch,
    timeoutMs: connector.config.timeoutMs,
    wireTimeZone: connector.config.wireTimeZone,
    officeTimeZone: (officeId) => BRANCH_BY_OFFICE.get(officeId)?.timezone,
    onCall,
    // Comma-separated hostnames a person has explicitly authorized. Unset in this build.
    authorizedHosts: (env.FIELDROUTES_AUTHORIZED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  });
}

export function defaultRuntime(pool: Pool, workerId = `${hostname()}:${process.pid}`): SyncRuntime {
  return {
    pool,
    clientFor: (connector, onCall) => connectorClient(connector, onCall),
    now: () => new Date(),
    businessNow: () => getNow(pool),
    workerId,
  };
}
