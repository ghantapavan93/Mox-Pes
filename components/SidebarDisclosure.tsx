"use client";

import { useId, useState, type MouseEvent, type ReactNode } from "react";

/**
 * Below the `lg` breakpoint the sidebar's navigation collapses behind a "Menu" button, so a
 * phone shows the page content right after the brand and search instead of ~450px of links.
 * From `lg` up the button is hidden and the navigation is always shown (CSS only, no
 * hydration flash). Following a link closes the menu; the disclosure is a plain
 * button with aria-expanded / aria-controls.
 */
export function SidebarDisclosure({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const closeOnLink = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest("a")) setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded border border-white/15 px-2.5 py-1.5 text-left text-xs text-white/80 hover:bg-white/10 lg:hidden"
        data-testid="sidebar-menu-button"
      >
        <span>Menu</span>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {/* The click handler is not an interaction of its own: it only closes the menu after a
          link inside it was followed (Enter on a link fires click too). */}
      <div id={panelId} onClick={closeOnLink} className={`${open ? "flex" : "hidden"} flex-col gap-4 lg:flex`} data-testid="sidebar-panel">
        {children}
      </div>
    </>
  );
}
