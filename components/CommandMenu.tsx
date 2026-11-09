"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NAV } from "@/lib/nav";

interface Hit {
  kind: string;
  href: string;
  title: string;
  detail: string;
}

/**
 * ⌘K / Ctrl+K command menu: pages from the shared nav list, plus branches, incidents and
 * customers from /api/search (branch-scoped on the server). Arrow keys move, Enter opens,
 * Escape closes.
 */
export function CommandMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length === 0) return;
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        if (res.ok) setRemote(((await res.json()) as { hits: Hit[] }).hits);
      } catch {
        // aborted or offline: page results still work
      }
    }, 140);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [q, open]);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const pages: Hit[] = NAV.filter((n) => !needle || `${n.label} ${n.keywords}`.toLowerCase().includes(needle)).map((n) => ({
      kind: "page",
      href: n.href,
      title: n.label,
      detail: n.group,
    }));
    return needle ? [...pages, ...remote] : pages;
  }, [q, remote]);

  const go = useCallback(
    (hit: Hit | undefined) => {
      if (!hit) return;
      setOpen(false);
      setQ("");
      router.push(hit.href);
    },
    [router],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between rounded border border-white/15 bg-white/5 px-2.5 py-1.5 text-left text-xs text-white/70 hover:bg-white/10"
        aria-label="Open command menu"
      >
        <span>Search or jump to…</span>
        <kbd className="rounded bg-white/10 px-1 font-mono text-[10px]">Ctrl K</kbd>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command menu"
            className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-surface text-text shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={input}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
                if (!e.target.value.trim()) setRemote([]);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, hits.length - 1));
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                }
                if (e.key === "Enter") go(hits[active]);
              }}
              placeholder="Pages, branches (B09), incidents (#1063), customers (415347)…"
              className="w-full border-b border-border bg-surface px-4 py-3 text-sm outline-none"
              aria-label="Search"
              data-testid="command-input"
            />
            <ul role="listbox" className="max-h-[50vh] overflow-y-auto py-1" data-testid="command-results">
              {hits.length === 0 && <li className="px-4 py-3 text-sm text-faint">No matches.</li>}
              {hits.map((h, i) => (
                <li
                  key={`${h.kind}:${h.href}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(h)}
                  className={`flex cursor-pointer items-baseline justify-between gap-3 px-4 py-2 text-sm ${i === active ? "bg-accent-soft" : ""}`}
                >
                  <span className="truncate">
                    <span className="mr-2 font-mono text-[10px] uppercase text-faint">{h.kind}</span>
                    {h.title}
                  </span>
                  <span className="shrink-0 truncate text-xs text-faint">{h.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
