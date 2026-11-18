"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { buttonClass } from "@/components/ui";

const FOCUSABLE = 'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A side drawer over the page (docs/design-system.md, "Drawer"), extracted from the incident's
 * evidence drawer so every drawer behaves alike:
 *
 * - a `role="dialog"` with `aria-modal`, named by its title;
 * - on open, focus moves to Close; Tab and Shift+Tab stay inside; Escape and the backdrop close it;
 * - the page behind does not scroll while it is open.
 *
 * The opener puts focus back when it closes the drawer (`returnFocusTo`, or its own `onClose`),
 * because only the opener knows which control opened it.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  footer,
  children,
  width = "xl",
  live = false,
  returnFocusTo,
  testId,
}: {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  subtitle?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  width?: "xl" | "2xl";
  /** Announce body changes (a record that loads after the drawer opens). */
  live?: boolean;
  returnFocusTo?: React.RefObject<HTMLElement | null>;
  testId?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const returnTo = returnFocusTo?.current ?? null;
    closeButton.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      // Keep Tab inside the open drawer; Escape and Close always leave it.
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, [open, onClose, returnFocusTo]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-text/30" onClick={onClose}>
      {/* A div: role="dialog" is not allowed on <aside> (axe aria-allowed-role). */}
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`flex h-full w-full ${width === "2xl" ? "max-w-2xl" : "max-w-xl"} flex-col border-l border-border bg-surface shadow-overlay`}
        onClick={(e) => e.stopPropagation()}
        data-testid={testId}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[15px] font-semibold leading-6 text-text">
              {title}
            </h2>
            {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
          </div>
          <button ref={closeButton} type="button" onClick={onClose} className={buttonClass({ size: "sm" })}>
            Close <span className="text-faint">Esc</span>
          </button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm" aria-live={live ? "polite" : undefined}>
          {children}
        </div>
        {footer && <footer className="border-t border-border px-4 py-3 text-sm">{footer}</footer>}
      </div>
    </div>
  );
}
