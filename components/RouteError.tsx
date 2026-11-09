"use client";

import { useEffect } from "react";

/**
 * The shell's error panel for a route segment that failed to render (database unreachable, a
 * bug). A failed render changes nothing: every mutation in the product is its own audited
 * request. `retry` re-fetches and re-renders the segment (Next 16 error boundary prop).
 */
export function RouteError({ title, error, retry }: { title: string; error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : null;
  return (
    <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft p-6 text-sm text-bad" data-testid="route-error">
      <p className="font-semibold">{title}</p>
      <p className="mt-1">Nothing was changed. The error was logged; try again, or reload the page.</p>
      {digest && <p className="mt-1 font-mono text-xs">Reference {digest}</p>}
      <button type="button" onClick={() => retry()} className="mt-3 rounded border border-bad/40 bg-surface px-3 py-1.5 font-medium hover:bg-bad-soft">
        Try again
      </button>
    </div>
  );
}
