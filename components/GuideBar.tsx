"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { B09_STEPS, GUIDE_ID, PATH_SECONDS, ROLE_LABEL, stepAt, stepHref } from "@/lib/demo/b09-path";

/**
 * The presenter's rail for the four-minute B09 path (lib/demo/b09-path.ts). Shown only when the
 * URL carries `?guide=b09&step=N&gap=ID`, which every link from /demo and from this bar does, so
 * it costs nothing on ordinary pages. The role button is the demo role switch (POST /api/role).
 */
export function GuideBar() {
  const params = useSearchParams();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (params.get("guide") !== GUIDE_ID) return null;
  const step = stepAt(Number(params.get("step")));
  const gapId = Number(params.get("gap"));
  if (!step || !Number.isInteger(gapId) || gapId <= 0) return null;
  const prev = stepAt(step.n - 1);
  const next = stepAt(step.n + 1);
  const elapsed = B09_STEPS.filter((s) => s.n < step.n).reduce((t, s) => t + s.seconds, 0);
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  async function switchRole() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/role", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: step!.role }) });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <nav aria-label="Guided path" data-testid="guide-bar" className="border-b border-accent/30 bg-accent-soft px-4 py-2 text-sm lg:px-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium text-text" data-testid="guide-step">
          Step {step.n} of {B09_STEPS.length} · {step.title}
        </span>
        <span className="text-xs text-muted tabular-nums">
          {clock(elapsed)} → {clock(elapsed + step.seconds)} of {clock(PATH_SECONDS)}
        </span>
        <span className="text-xs text-muted">
          As <strong className="text-text">{ROLE_LABEL[step.role]}</strong>{" "}
          <button type="button" onClick={switchRole} aria-disabled={busy} data-testid="guide-use-role" className="ml-1 rounded border border-border bg-surface px-2 py-0.5 text-xs hover:bg-surface-2 aria-disabled:opacity-50">
            {busy ? "Switching…" : "Use this role"}
          </button>
        </span>
        <span className="ml-auto flex items-center gap-3 text-xs">
          {prev && <Link href={stepHref(prev, gapId)} className="text-accent hover:underline">← {prev.title}</Link>}
          {next ? (
            <Link href={stepHref(next, gapId)} className="rounded bg-accent px-2.5 py-1 font-medium text-white hover:opacity-90" data-testid="guide-next">
              Next: {next.title} →
            </Link>
          ) : (
            <Link href="/demo" className="rounded bg-accent px-2.5 py-1 font-medium text-white hover:opacity-90" data-testid="guide-done">
              Done: back to the path
            </Link>
          )}
          <Link href="/demo" className="text-muted hover:underline">Exit</Link>
        </span>
      </div>
      <p className="mt-1 text-xs text-muted" data-testid="guide-say">
        <span className="text-faint">Show:</span> {step.show.join(" · ")} <span className="text-faint">· Say:</span> “{step.say}”
      </p>
    </nav>
  );
}
