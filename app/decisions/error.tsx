"use client";

import { useEffect } from "react";

/**
 * Error state for the Decision Lab. Server errors arrive with a generic message and a digest
 * (Next.js does not leak server details), so the digest is shown to match the server log line.
 */
export default function DecisionsError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";
  return (
    <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft p-6 text-sm text-bad">
      <p className="font-semibold">The Decision Lab could not load.</p>
      <p className="mt-1">Nothing was changed. {digest && <span className="font-mono text-xs">Reference {digest}.</span>}</p>
      <button type="button" onClick={() => retry()} className="mt-3 rounded border border-bad/40 bg-surface px-3 py-1.5 text-text hover:bg-surface-2">
        Try again
      </button>
    </div>
  );
}
