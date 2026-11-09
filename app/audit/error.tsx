"use client";

import { useEffect } from "react";

/** Unexpected failures on /audit (database unreachable, a bug). Reading the audit log changes nothing. */
export default function AuditError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft p-6 text-sm text-bad">
      <p className="font-semibold">Audit &amp; Health could not be loaded.</p>
      <p className="mt-1">The error was logged; try again, or reload the page.</p>
      <button type="button" onClick={() => retry()} className="mt-3 rounded border border-bad/40 bg-surface px-3 py-1.5 font-medium hover:bg-bad-soft">
        Try again
      </button>
    </div>
  );
}
