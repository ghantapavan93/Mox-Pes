"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { SCENARIO } from "@/lib/reference";

const OPTIONS = [
  ["guest", "Guest (read-only)"],
  ["marketing", "Marketing analyst"],
  ["engineer", "Integration engineer"],
  ["approver", "Revenue ops approver"],
  ["partner", `Branch partner (${SCENARIO.callFeedDriftBranch})`],
  ["brand", "Brand marketing lead (Joshua's)"],
] as const;

export function RoleSwitcher({ current }: { current: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span>Viewing as</span>
      <select
        aria-label="Viewing as"
        data-testid="role-switcher"
        className="rounded border border-border bg-surface px-2 py-1 text-xs text-text"
        value={current}
        disabled={pending}
        onChange={(e) => {
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
