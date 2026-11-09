import { sha256 } from "@/lib/primitives";

/**
 * DEMO credentials for the local FieldRoutes-compatible mock. They are deterministic and
 * published in source on purpose: they unlock nothing but synthetic data served by this app.
 * A real tenant's keys come only from environment variables named in the connector config.
 *
 * One key per office, mirroring FieldRoutes' default ("each key is associated with only one
 * office", research/17 §1).
 */
export function demoCredentials(officeId: number): { key: string; token: string } {
  return { key: `demo-office-${officeId}`, token: sha256(`revenue-signal-demo-token:${officeId}`).slice(0, 32) };
}

/** The office a demo key belongs to, or null when the pair is not a valid demo key. */
export function officeForDemoKey(key: string, token: string): number | null {
  const match = /^demo-office-(\d{1,9})$/.exec(key);
  if (!match) return null;
  const officeId = Number(match[1]);
  return demoCredentials(officeId).token === token ? officeId : null;
}

/** True for this app's own mock on a local host: the only place demo keys may be sent. */
export function isLocalMockUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost");
    return localHost && url.pathname.replace(/\/+$/, "").endsWith("/api/mock/fieldroutes");
  } catch {
    return false;
  }
}

/**
 * Real FieldRoutes tenants live on <subdomain>.fieldroutes.com (current) or
 * <subdomain>.pestroutes.com (legacy) — research/17 §1. This build has no authorization to
 * call them, so the client refuses these hosts unless they are explicitly authorized.
 */
export function isRealFieldRoutesHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return /(^|\.)fieldroutes\.com$/.test(host) || /(^|\.)pestroutes\.com$/.test(host);
  } catch {
    return false;
  }
}
