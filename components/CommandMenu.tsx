"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
 *
 * The input is an ARIA combobox over the results listbox (aria-activedescendant follows the
 * arrow keys). The dialog keeps Tab inside itself, and closing returns focus to whatever
 * opened it (the sidebar button, or the element that had focus when Ctrl/⌘K was pressed).
 */
export function CommandMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const baseId = useId();
  const listId = `${baseId}-results`;
  const optionId = (i: number) => `${baseId}-option-${i}`;

  /** Opens the menu, remembering where focus was so closing can put it back. */
  const show = useCallback(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    const target = opener.current;
    opener.current = null;
    // After the dialog unmounts; skip if the opener left the page meanwhile.
    setTimeout(() => {
      if (target?.isConnected) target.focus();
    }, 0);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) close();
        else show();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, show, close]);

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
      // Navigating: focus goes to the new page, not back to the opener.
      opener.current = null;
      setOpen(false);
      setQ("");
      router.push(hit.href);
    },
    [router],
  );

  /** A simple focus trap: Tab and Shift+Tab cycle through the dialog's focusable elements. */
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !dialog.current) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>('input, button, [href], select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !el.hasAttribute("disabled"),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    if (e.shiftKey && (current === first || !dialog.current.contains(current))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (current === last || !dialog.current.contains(current))) {
      e.preventDefault();
      first.focus();
    }
  };

  const activeHit = hits.length > 0 ? Math.min(active, hits.length - 1) : -1;

  return (
    <>
      <button
        type="button"
        onClick={show}
        className="relative flex w-full items-center gap-2 rounded-md border border-shell-border bg-shell-raised px-2.5 py-1.5 text-left text-xs text-shell-text hover:border-shell-muted hover:text-white"
        title="Search or jump to… (Ctrl K)"
      >
        {/* Name from content: the visible label first, then the purpose (WCAG 2.5.3, label in name).
            Collapsed, the labels hide and the sr-only text still names the button. */}
        <Search aria-hidden className="size-3.5 shrink-0" />
        <span data-sidebar-label className="flex-1">Search or jump to…</span>
        <kbd data-sidebar-label className="rounded bg-white/10 px-1 font-mono text-[10px]">Ctrl K</kbd>
        <span className="sr-only"> (open command menu)</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onClick={close}>
          <div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-label="Command menu"
            className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-surface text-text shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={trapTab}
          >
            <input
              ref={input}
              role="combobox"
              aria-expanded={hits.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeHit >= 0 ? optionId(activeHit) : undefined}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
                if (!e.target.value.trim()) setRemote([]);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  close();
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, hits.length - 1));
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                }
                if (e.key === "Enter") go(hits[activeHit]);
              }}
              placeholder="Pages, branches (B09), incidents (#1063), customers (415347)…"
              className="w-full border-b border-border bg-surface px-4 py-3 text-sm outline-none"
              aria-label="Search"
              data-testid="command-input"
            />
            {hits.length === 0 && (
              <p role="status" className="px-4 py-3 text-sm text-faint">
                No matches.
              </p>
            )}
            <ul id={listId} role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto py-1 empty:hidden" data-testid="command-results">
              {hits.map((h, i) => (
                <li
                  key={`${h.kind}:${h.href}`}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === activeHit}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(h)}
                  className={`flex cursor-pointer items-baseline justify-between gap-3 px-4 py-2 text-sm ${i === activeHit ? "bg-accent-soft" : ""}`}
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
