"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";

/**
 * Search + filters for /customers. Navigates by URL (shareable, back-button friendly) inside a
 * transition, so the current results stay on screen, dimmed, with a visible "Searching…" state
 * until the server has rendered the new page.
 */
export function CustomerFilters({
  q,
  branch,
  lifecycle,
  branchOptions,
  lifecycleOptions,
  children,
}: {
  q: string;
  branch: string;
  lifecycle: string;
  /** Only the branches in the viewer's scope; empty value = all in scope. */
  branchOptions: Array<{ id: string; label: string }>;
  lifecycleOptions: Array<{ value: string; label: string }>;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // A single-branch viewer has exactly one option; keep the control honest about it.
  const onlyBranch = branchOptions.length === 1 ? branchOptions[0].id : "";
  const [form, setForm] = useState({ q, branch: branch || onlyBranch, lifecycle });

  function go(next: typeof form) {
    const params = new URLSearchParams();
    if (next.q.trim()) params.set("q", next.q.trim());
    if (next.branch) params.set("branch", next.branch);
    if (next.lifecycle) params.set("lifecycle", next.lifecycle);
    const qs = params.toString();
    startTransition(() => router.push(qs ? `/customers?${qs}` : "/customers"));
  }

  const clear = () => {
    const empty = { q: "", branch: onlyBranch, lifecycle: "" };
    setForm(empty);
    go(empty);
  };

  return (
    <div className="space-y-3">
      <form
        role="search"
        aria-label="Search customers"
        onSubmit={(e) => {
          e.preventDefault();
          go(form);
        }}
        className="flex flex-wrap items-end gap-2 text-sm"
      >
        <label className="flex min-w-56 flex-1 flex-col gap-1">
          <span className="text-xs text-muted">CRM customer id, lead id (CAL…, msg-…, S-…) or prospect P-…</span>
          <input
            type="search"
            name="q"
            value={form.q}
            maxLength={64}
            onChange={(e) => setForm({ ...form, q: e.target.value })}
            placeholder="e.g. 400123 or CAL00001234"
            className="rounded border border-border bg-surface px-2 py-1.5 font-mono text-xs"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Branch</span>
          <select
            name="branch"
            value={form.branch}
            onChange={(e) => {
              const next = { ...form, branch: e.target.value };
              setForm(next);
              go(next);
            }}
            className="rounded border border-border bg-surface px-2 py-1.5"
          >
            {branchOptions.length > 1 && <option value="">All branches in scope</option>}
            {branchOptions.map((b) => (
              <option key={b.id} value={b.id}>{b.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Lifecycle</span>
          <select
            name="lifecycle"
            value={form.lifecycle}
            onChange={(e) => {
              const next = { ...form, lifecycle: e.target.value };
              setForm(next);
              go(next);
            }}
            className="rounded border border-border bg-surface px-2 py-1.5"
          >
            <option value="">Any</option>
            {lifecycleOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={pending} className="rounded bg-text px-3 py-1.5 font-medium text-white disabled:opacity-50">
          Search
        </button>
        <button type="button" onClick={clear} disabled={pending} className="rounded border border-border px-3 py-1.5 hover:bg-surface-2 disabled:opacity-50">
          Clear
        </button>
        <span role="status" aria-live="polite" className="pb-1.5 text-xs text-muted">
          {pending ? "Searching…" : ""}
        </span>
      </form>
      <div aria-busy={pending} className={pending ? "pointer-events-none opacity-50 transition-opacity" : "transition-opacity"}>
        {children}
      </div>
    </div>
  );
}
