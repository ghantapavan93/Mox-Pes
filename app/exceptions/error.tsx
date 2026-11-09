"use client";

import { useEffect } from "react";

/**
 * Unexpected failures on the Action Center queue and case pages (database unreachable, a bug).
 * Scope refusals are not errors: those pages render a 403 panel. A failed render changes
 * nothing; every mutation is its own audited request.
 */
export default function ActionCenterError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft p-6 text-sm text-bad">
      <p className="font-semibold">The Action Center could not be loaded.</p>
      <p className="mt-1">Nothing was changed. The error was logged; try again, or reload the page.</p>
      <button type="button" onClick={() => retry()} className="mt-3 rounded border border-bad/40 bg-surface px-3 py-1.5 font-medium hover:bg-bad-soft">
        Try again
      </button>
    </div>
  );
}
