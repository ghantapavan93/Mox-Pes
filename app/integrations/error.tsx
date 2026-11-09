"use client";

import { useEffect } from "react";

/**
 * Unexpected failures on /integrations and its job pages (database unreachable, an invalid
 * connector config, a bug). Scope refusals are not errors: those pages render a 403 panel.
 * Sync jobs keep running in the background regardless of this page.
 */
export default function IntegrationsError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft p-6 text-sm text-bad">
      <p className="font-semibold">The Integration Studio could not be loaded.</p>
      <p className="mt-1">Nothing was changed, and queued sync jobs are unaffected. The error was logged; try again, or reload the page.</p>
      <button type="button" onClick={() => retry()} className="mt-3 rounded border border-bad/40 bg-surface px-3 py-1.5 font-medium hover:bg-bad-soft">
        Try again
      </button>
    </div>
  );
}
