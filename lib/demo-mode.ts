/**
 * Demo mode: the role picker (cookie `rs_role`, POST /api/role) and the FieldRoutes MOCK
 * (/api/mock/fieldroutes) exist only in development, in tests, or when a production build is
 * started with DEMO_MODE=1 explicitly (the interview demo and the browser tests do this).
 *
 * A production build without the flag ignores the role cookie (everyone is a read-only guest),
 * refuses POST /api/role and does not serve the mock, so a deployed copy cannot be made an
 * approver by anyone who finds the endpoint (audit 2026-11-09, E3/E7). Real deployments derive
 * the viewer from SSO claims instead (docs/decisions.md, ADR-11).
 */
export function demoModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" || env.DEMO_MODE === "1";
}
