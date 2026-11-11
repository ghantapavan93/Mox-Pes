import type { ChangeStatus } from "@/lib/changeguard/model";

export const STATUS_TONE: Record<ChangeStatus, "neutral" | "good" | "warn" | "bad" | "accent"> = {
  draft: "neutral",
  preflight_failed: "bad",
  ready_for_review: "accent",
  approved: "accent",
  rejected: "neutral",
  monitoring: "warn",
  verified: "good",
  degraded: "warn",
  recovery_required: "bad",
  superseded: "neutral",
};
