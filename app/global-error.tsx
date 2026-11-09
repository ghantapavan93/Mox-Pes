"use client";

import { useEffect } from "react";
import "./globals.css";

/**
 * Last-resort boundary for a failure in the root layout itself (for example the viewer lookup
 * in the header). It replaces the whole document, so it renders its own <html> and <body>
 * and imports the global styles; the shell (sidebar, header) is not available here.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <body className="min-h-full">
        <title>Revenue Signal OS — error</title>
        <main className="mx-auto max-w-xl px-4 py-16">
          <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft p-6 text-sm text-bad" data-testid="global-error">
            <p className="font-semibold">Revenue Signal OS could not be loaded.</p>
            <p className="mt-1">Nothing was changed. The error was logged; try again, or reload the page.</p>
            <button type="button" onClick={() => retry()} className="mt-3 rounded border border-bad/40 bg-surface px-3 py-1.5 font-medium hover:bg-bad-soft">
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
