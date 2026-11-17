"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { BRAND_BY_ID, SCENARIO } from "@/lib/reference";

const OPTIONS = [
  ["guest", "Guest (read-only)"],
  ["marketing", "Marketing analyst"],
  ["engineer", "Integration engineer"],
  ["approver", "Revenue ops approver"],
  ["partner", `Branch partner (${SCENARIO.callFeedDriftBranch})`],
  ["brand", `Brand marketing lead (${BRAND_BY_ID.get("joshuas")!.name})`],
] as const;

export function RoleSwitcher({ current }: { current: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-muted">
      <span>Viewing as</span>
      <select
        aria-label="Viewing as"
        data-testid="role-switcher"
        className="rounded border border-border bg-surface px-2 py-1 text-xs text-text aria-disabled:opacity-50"
        value={current}
        // aria-disabled, not disabled: a disabled select drops keyboard focus mid-switch.
        aria-disabled={pending || undefined}
        onChange={(e) => {
          if (pending) return;
          const role = e.target.value;
          start(async () => {
            await fetch("/api/role", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }) });
            router.refresh();
          });
        }}
      >
        {OPTIONS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
