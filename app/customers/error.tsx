"use client";

import { useEffect } from "react";

/**
 * Unexpected failures on /customers and /customers/[id] (database unreachable, a bug). Scope is
 * not an error: /customers renders a 403 panel for an out-of-scope branch filter, and a journey
 * outside the viewer's branches is a plain 404, the same as a missing id.
 */
export default function CustomersError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft p-6 text-sm text-bad">
      <p className="font-semibold">The customer journey could not be loaded.</p>
      <p className="mt-1">Nothing was changed. The error was logged; try again, or reload the page.</p>
      <button type="button" onClick={() => retry()} className="mt-3 rounded border border-bad/40 bg-surface px-3 py-1.5 font-medium hover:bg-bad-soft">
        Try again
      </button>
    </div>
  );
}
