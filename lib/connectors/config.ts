import { z } from "zod";
import type { Queryable } from "@/lib/db";
import { demoCredentials, isLocalMockUrl } from "./demo-keys";

/**
 * Connector configuration as stored in `connectors.config`, and credential resolution.
 *
 * Credentials are never stored in the database and never leave the server: the config holds
 * environment variable NAME templates ("FIELDROUTES_KEY_{officeId}"), resolved by the worker at
 * call time. What the UI may see is `credentialStatus` — names and whether they are set.
 */

/** Environment lookup (process.env in production; a plain object in tests). */
export type Env = Record<string, string | undefined>;

const ianaZone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "expected an IANA time zone");

export const connectorConfigSchema = z.object({
  credentials: z.object({
    keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*(\{officeId\})?[A-Z0-9_]*$/, "env var name template"),
    tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*(\{officeId\})?[A-Z0-9_]*$/, "env var name template"),
    /** Fall back to the mock's published demo keys — honoured only for a local mock base URL. */
    allowDemoKeys: z.boolean(),
  }),
  timeoutMs: z.number().int().min(10).max(120_000),
  /**
   * The zone the source writes its zone-less datetimes in, so window bounds are sent in the
   * same clock the source compares against. "office" = each office's own zone (what the
   * synthetic world and FieldRoutesMapper assume). Real FieldRoutes documents Pacific time
   * for every datetime (research/17 §6.1) — a real tenant would set "America/Los_Angeles",
   * and the mapper would need the same change (README, deviation G1).
   */
  wireTimeZone: z.union([z.literal("office"), ianaZone]),
  /** First window for an office+entity with no checkpoint: this far behind the business clock. */
  initialLookbackHours: z.number().int().min(1).max(24 * 3650),
  /** Offices this connector syncs; null = every branch's office. */
  officeIds: z.array(z.number().int().positive()).nullable(),
  maxAttempts: z.number().int().min(1).max(20),
});

export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;

export interface ConnectorRow {
  id: number;
  slug: string;
  provider: "fieldroutes";
  displayName: string;
  /** Resolved: the env override when set, else the stored URL. */
  baseUrl: string;
  baseUrlSource: "env" | "config";
  baseUrlEnv: string | null;
  config: ConnectorConfig;
  synthetic: boolean;
  enabled: boolean;
}

interface ConnectorDbRow {
  id: string;
  slug: string;
  provider: "fieldroutes";
  display_name: string;
  base_url: string;
  base_url_env: string | null;
  config: unknown;
  synthetic: boolean;
  enabled: boolean;
}

function toConnector(row: ConnectorDbRow, env: Env): ConnectorRow {
  const override = row.base_url_env ? env[row.base_url_env] : undefined;
  return {
    id: Number(row.id),
    slug: row.slug,
    provider: row.provider,
    displayName: row.display_name,
    baseUrl: override || row.base_url,
    baseUrlSource: override ? "env" : "config",
    baseUrlEnv: row.base_url_env,
    // A config that fails validation is a deployment error: refuse loudly rather than guess.
    config: connectorConfigSchema.parse(row.config),
    synthetic: row.synthetic,
    enabled: row.enabled,
  };
}

export async function getConnector(db: Queryable, id: number, env: Env = process.env): Promise<ConnectorRow | null> {
  const { rows } = await db.query<ConnectorDbRow>("select * from connectors where id = $1", [id]);
  return rows[0] ? toConnector(rows[0], env) : null;
}

export async function listConnectorRows(db: Queryable, env: Env = process.env): Promise<ConnectorRow[]> {
  const { rows } = await db.query<ConnectorDbRow>("select * from connectors order by id");
  return rows.map((r) => toConnector(r, env));
}

/** The offices a connector syncs: its explicit list, or every branch's CRM office. */
export async function connectorOffices(db: Queryable, connector: ConnectorRow): Promise<Array<{ officeId: number; branchId: string; branchName: string }>> {
  const { rows } = await db.query<{ crm_office_id: number; id: string; name: string }>(
    "select crm_office_id, id, name from branches where $1::int[] is null or crm_office_id = any($1::int[]) order by crm_office_id",
    [connector.config.officeIds],
  );
  return rows.map((r) => ({ officeId: r.crm_office_id, branchId: r.id, branchName: r.name }));
}

const envName = (template: string, officeId: number) => template.replace("{officeId}", String(officeId));

export interface Credentials {
  key: string;
  token: string;
}

export type CredentialSource = "env" | "demo" | "missing";

/** Where an office's credentials would come from — names only, safe to show in the UI. */
export function credentialStatus(connector: ConnectorRow, officeId: number, env: Env = process.env) {
  const keyEnv = envName(connector.config.credentials.keyEnv, officeId);
  const tokenEnv = envName(connector.config.credentials.tokenEnv, officeId);
  const fromEnv = Boolean(env[keyEnv] && env[tokenEnv]);
  const source: CredentialSource = fromEnv
    ? "env"
    : connector.config.credentials.allowDemoKeys && isLocalMockUrl(connector.baseUrl)
      ? "demo"
      : "missing";
  return { officeId, keyEnv, tokenEnv, source };
}

/** The office's credentials, or null with the env names a person must set. Server-only. */
export function resolveCredentials(
  connector: ConnectorRow,
  officeId: number,
  env: Env = process.env,
): { credentials: Credentials; source: Exclude<CredentialSource, "missing"> } | { credentials: null; keyEnv: string; tokenEnv: string } {
  const status = credentialStatus(connector, officeId, env);
  if (status.source === "env") return { credentials: { key: env[status.keyEnv]!, token: env[status.tokenEnv]! }, source: "env" };
  if (status.source === "demo") return { credentials: demoCredentials(officeId), source: "demo" };
  return { credentials: null, keyEnv: status.keyEnv, tokenEnv: status.tokenEnv };
}
