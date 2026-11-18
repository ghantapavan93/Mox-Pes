import { ActionError } from "@/lib/actions";
import type { Queryable } from "@/lib/db";
import { ForbiddenError, type Viewer } from "@/lib/viewer";
import { WORKSPACE } from "@/lib/workspace";
import type { DatasetId } from "./targets";

/**
 * Who may see which upload (release design §5.1–§5.2), in one place. A company viewer (a staff role
 * with company scope that can propose or approve) sees company uploads; a workspace guest sees only
 * its own workspace uploads, while they are live. Each side answers 404 for the other's ids.
 */

export type OnboardingAccess = "company" | "workspace" | null;

/** The 404 a workspace guest gets for anything that is not its own live item. */
export const WORKSPACE_NOT_AVAILABLE =
  "This workspace item is not available. Items last 24 hours, and the oldest may be removed when the demo is full. Upload the file again.";

export function onboardingAccess(viewer: Viewer): OnboardingAccess {
  if (viewer.can.workspace) return "workspace";
  if (viewer.branchIds === null && (viewer.can.propose || viewer.can.approve)) return "company";
  return null;
}

/**
 * Throws unless the viewer may `action`. A workspace guest may stage, map, dry-run and delete its own
 * uploads, never approve or publish. Returns which onboarding the viewer works in.
 */
export function requireOnboarding(viewer: Viewer, action: string, kind: "propose" | "approve" | "either" = "either"): Exclude<OnboardingAccess, null> {
  if (viewer.can.workspace) {
    if (kind === "approve") throw new ForbiddenError(`${viewer.label} cannot ${action}: a workspace file is compared, never counted`);
    return "workspace";
  }
  if (viewer.branchIds !== null) throw new ForbiddenError(`${viewer.label} cannot ${action}: onboarding covers every branch`);
  const ok = kind === "either" ? viewer.can.propose || viewer.can.approve : viewer.can[kind];
  if (!ok) throw new ForbiddenError(`${viewer.label} cannot ${action}`);
  return "company";
}

export interface UploadSummary {
  id: number;
  filename: string;
  format: string;
  byteSize: number;
  rowCount: number;
  columnCount: number;
  status: string;
  uploadedBy: string;
  uploadedAt: string;
  expiresAt: string;
  rowsPurged: boolean;
  layoutFingerprint: string;
  dataset: DatasetId | null;
  /** Workspace uploads only: when it started, on the wall clock (its 24 hours run from here). */
  workspaceStartedAt: string | null;
}

/** Summary columns only: the profile, assistant result and table metadata stay unread (security review #6). */
export async function summaries(db: Queryable, where: string, params: unknown[]): Promise<UploadSummary[]> {
  const rows = (
    await db.query<{
      id: string; filename: string; format: string; byte_size: number; row_count: number; column_count: number; status: string;
      uploaded_by: string; uploaded_at: Date; expires_at: Date; rows_purged_at: Date | null; layout_fingerprint: string;
      dataset: DatasetId | null; workspace_started_at: Date | null;
    }>(
      `select id, filename, format, byte_size, row_count, column_count, status, uploaded_by, uploaded_at, expires_at, rows_purged_at, layout_fingerprint,
         assistant->'dataset'->>'chosen' as dataset, workspace_started_at
       from onboarding_uploads ${where}`,
      params,
    )
  ).rows;
  return rows.map((r) => ({
    id: Number(r.id), filename: r.filename, format: r.format, byteSize: r.byte_size, rowCount: r.row_count, columnCount: r.column_count, status: r.status,
    uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at.toISOString(), expiresAt: r.expires_at.toISOString(), rowsPurged: r.rows_purged_at !== null,
    layoutFingerprint: r.layout_fingerprint, dataset: r.dataset, workspaceStartedAt: r.workspace_started_at?.toISOString() ?? null,
  }));
}

export async function summary(db: Queryable, id: number): Promise<UploadSummary> {
  const r = (await summaries(db, "where id = $1", [id]))[0];
  if (!r) throw new ActionError("Upload not found", 404);
  return r;
}

/** The upload, if this viewer may see it: its own live workspace upload, or a company upload. Otherwise 404. */
export async function uploadFor(db: Queryable, viewer: Viewer, id: number): Promise<UploadSummary> {
  const access = requireOnboarding(viewer, "see uploads");
  const row = (
    await db.query<{ workspace_owner: string | null; live: boolean | null }>(
      "select workspace_owner, workspace_started_at > now() - make_interval(hours => $2) as live from onboarding_uploads where id = $1",
      [id, WORKSPACE.retentionHours],
    )
  ).rows[0];
  const visible = row !== undefined && (access === "workspace" ? row.workspace_owner === viewer.subject && row.live === true : row.workspace_owner === null);
  if (!visible) throw new ActionError(access === "workspace" ? WORKSPACE_NOT_AVAILABLE : "Upload not found", 404);
  return summary(db, id);
}

/** The uploads this viewer may list: its own live workspace uploads, or the company's (newest first, 50). */
export async function uploadsFor(db: Queryable, viewer: Viewer): Promise<UploadSummary[]> {
  return requireOnboarding(viewer, "see uploads") === "workspace"
    ? summaries(db, "where workspace_owner = $1 and workspace_started_at > now() - make_interval(hours => $2) order by id desc limit 50", [viewer.subject, WORKSPACE.retentionHours])
    : summaries(db, "where workspace_owner is null and status <> 'deleted' order by uploaded_at desc, id desc limit 50", []);
}
