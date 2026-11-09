import { BRAND_BY_ID, SCENARIO, branchesOfBrands, type BrandId } from "@/lib/reference";

/**
 * Who is looking, and what they may see and do.
 *
 * DEMO ONLY: there are no passwords — a role is picked from the header (cookie `rs_role`),
 * so anyone can choose any role. What is real is ENFORCEMENT given a viewer: every query
 * and mutation resolves branch scope and permissions here, on the server, so a viewer with
 * a branch-partner role cannot read or act on another branch via a URL or the API.
 * Missing or unknown roles fall back to a read-only guest.
 *
 * Production derives the Viewer from SSO claims (the internal portal signs in with Google
 * Workspace) and removes /api/role.
 *
 * Scope is a set of BRANCHES. A brand-scoped role (one brand's marketing lead) is expanded to
 * that brand's branches here, once, so every query and mutation keeps enforcing one thing: the
 * branch list. Brand is a way to grant and to slice scope, never a second enforcement path.
 *
 * Separation of duties (Action Center): an analyst or engineer PROPOSES, an engineer
 * DRY-RUNS, a different role APPROVES, and the application executes. No role can approve
 * a proposal it made.
 */

export type Role = "guest" | "marketing" | "engineer" | "approver" | "partner" | "brand";

export interface Permissions {
  /** Legacy direct replay from an exception page (integration engineers). */
  replay: boolean;
  /** Record decisions on exceptions: map campaign, override branch, acknowledge. */
  decide: boolean;
  closeConflicts: boolean;
  /** Run investigations (AI or deterministic) over permitted data. */
  investigate: boolean;
  /** Create action proposals in the Action Center. */
  propose: boolean;
  /** Execute dry runs of proposals (rolled back). */
  dryRun: boolean;
  /** Approve or reject a proposal someone else made. */
  approve: boolean;
  /** Start, retry or cancel connector sync jobs. */
  sync: boolean;
  /** Accept or reject ambiguous identity matches. */
  reviewIdentity: boolean;
}

export interface Viewer {
  role: Role;
  label: string;
  /** null = all branches */
  branchIds: string[] | null;
  /** The brands this viewer is scoped to (null = not brand-scoped). branchIds is derived from it. */
  brandIds: BrandId[] | null;
  can: Permissions;
}

export const ROLE_COOKIE = "rs_role";

/** The sister brand the demo's brand-scoped role covers. */
const SISTER_BRAND: BrandId = "joshuas";

const NONE: Permissions = {
  replay: false, decide: false, closeConflicts: false, investigate: false, propose: false,
  dryRun: false, approve: false, sync: false, reviewIdentity: false,
};

export const VIEWERS: Record<Role, Viewer> = {
  guest: { role: "guest", label: "Guest · read-only", branchIds: null, brandIds: null, can: NONE },
  marketing: {
    role: "marketing",
    label: "Marketing analyst · all branches",
    branchIds: null,
    brandIds: null,
    can: { ...NONE, decide: true, investigate: true, propose: true, reviewIdentity: true },
  },
  engineer: {
    role: "engineer",
    label: "Integration engineer · all branches",
    branchIds: null,
    brandIds: null,
    can: { ...NONE, replay: true, decide: true, closeConflicts: true, investigate: true, propose: true, dryRun: true, sync: true, reviewIdentity: true },
  },
  approver: {
    role: "approver",
    label: "Revenue ops approver · all branches",
    branchIds: null,
    brandIds: null,
    can: { ...NONE, investigate: true, approve: true },
  },
  partner: {
    role: "partner",
    label: `Branch partner · ${SCENARIO.callFeedDriftBranch} only`,
    branchIds: [SCENARIO.callFeedDriftBranch],
    brandIds: null,
    can: { ...NONE, investigate: true },
  },
  brand: {
    role: "brand",
    label: `Brand marketing lead · ${BRAND_BY_ID.get(SISTER_BRAND)!.name} only`,
    branchIds: branchesOfBrands([SISTER_BRAND]),
    brandIds: [SISTER_BRAND],
    can: { ...NONE, investigate: true },
  },
};

export const ROLES = Object.keys(VIEWERS) as Role[];

/** Unknown or missing role → read-only guest. Acting always requires an explicit role. */
export function viewerFromRole(value: string | undefined): Viewer {
  return value && Object.hasOwn(VIEWERS, value) ? VIEWERS[value as Role] : VIEWERS.guest;
}

export class ForbiddenError extends Error {
  readonly status = 403;
}

/** Throws ForbiddenError unless the viewer holds `permission`. */
export function requirePermission(viewer: Viewer, permission: keyof Permissions, action: string): void {
  if (!viewer.can[permission]) throw new ForbiddenError(`${viewer.label} cannot ${action}`);
}

/** Branch scope for a query. Asking for a branch outside your scope is refused, not filtered. */
export function resolveScope(viewer: Viewer, requestedBranch?: string | null): string[] | null {
  if (requestedBranch) {
    if (viewer.branchIds && !viewer.branchIds.includes(requestedBranch)) {
      throw new ForbiddenError(`${viewer.label} cannot view branch ${requestedBranch}`);
    }
    return [requestedBranch];
  }
  return viewer.branchIds;
}

/**
 * Branch scope for a brand slice. Asking for a brand is allowed only when the viewer may see
 * ALL of it (all branches, or that brand granted): a partial view of a brand would present one
 * branch's numbers as the brand's.
 */
export function resolveBrandScope(viewer: Viewer, brandId: BrandId): string[] {
  const branches = branchesOfBrands([brandId]);
  if (viewer.branchIds && !branches.every((b) => viewer.branchIds!.includes(b))) {
    throw new ForbiddenError(`${viewer.label} cannot view brand ${BRAND_BY_ID.get(brandId)?.name ?? brandId}`);
  }
  return branches;
}

/** May this viewer see an exception that belongs to `branchId` (null = company-wide)? */
export function canSeeBranch(viewer: Viewer, branchId: string | null): boolean {
  if (!viewer.branchIds) return true;
  return branchId !== null && viewer.branchIds.includes(branchId);
}
