"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button } from "@/components/ui";
import { tooLargeMessage } from "@/lib/onboarding/limits";

/** Synthetic exports (public/samples/README.md lists every deliberate difference from the ledger). */
export const SAMPLES: Array<{ file: string; label: string; what: string }> = [
  { file: "demo-crm-payments.csv", label: "CRM payments export", what: "Disagrees with the ledger on 2 payments; an invoice Total; damaged ids" },
  { file: "demo-calls.csv", label: "Call-tracking export", what: "US dates, branch names, a duplicate, an injected note" },
  { file: "demo-google-ads.csv", label: "Google Ads daily report", what: "Title lines, a total row, one restated day" },
  { file: "meta-spend-semicolon.csv", label: "Meta spend (semicolons)", what: "BOM, quoted newlines, a formula cell, dated after the business clock" },
  { file: "mixed-garbage.csv", label: "Not a supported dataset", what: "A correct system refuses to guess" },
];

type UploadResponse = {
  upload?: { id: number };
  repeatOf?: { id: number; startedAt: string };
  refused?: { code: string; message: string };
  error?: string;
};

/**
 * Sends a file's bytes to POST /api/onboarding/uploads. Samples are fetched from /samples and
 * sent through exactly the same request, so a demo exercises the real upload path.
 *
 * A file over this viewer's size limit is refused here, from its size, before any byte is sent;
 * a 413 the platform answers without JSON (Vercel refuses bodies over 4.5 MB itself) reads the same
 * way. A file the workspace already holds opens its earlier result (`?repeat=1`).
 */
export function UploadForm({
  canUpload,
  reason,
  maxBytes,
  scope,
  limits,
}: {
  canUpload: boolean;
  reason: string | null;
  maxBytes: number;
  scope: "workspace" | "company";
  /** One line under the file input: formats, size and rows, and what happens to the file. */
  limits: string;
}) {
  const id = useId();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(name: string, bytes: Blob) {
    setError(null);
    if (bytes.size > maxBytes) {
      setError(tooLargeMessage(bytes.size, maxBytes, scope));
      return;
    }
    setBusy(name);
    let res: Response;
    try {
      res = await fetch("/api/onboarding/uploads", { method: "POST", headers: { "x-filename": encodeURIComponent(name), "content-type": "application/octet-stream" }, body: bytes });
    } catch {
      // No answer: the file may or may not have been staged. Sending it again is safe in the
      // workspace, which opens the earlier upload of the same file instead of staging it twice.
      setError(scope === "workspace" ? "The connection dropped before the server answered. Send the file again: if it arrived, its result opens." : "The connection dropped before the server answered. Check Recent uploads before sending the file again.");
      setBusy(null);
      return;
    }
    try {
      const json = (await res.json().catch(() => null)) as UploadResponse | null;
      if (res.status === 413 && !json?.refused && !json?.error) throw new Error(tooLargeMessage(null, maxBytes, scope));
      if (json?.refused) throw new Error(json.refused.message);
      if (json?.repeatOf) {
        router.push(`/onboarding/${json.repeatOf.id}?repeat=1`);
        return;
      }
      if (!res.ok || !json?.upload) throw new Error(json?.error ?? `The upload failed (HTTP ${res.status}). Try again.`);
      router.push(`/onboarding/${json.upload.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  async function sample(file: string) {
    const res = await fetch(`/samples/${file}`);
    await send(file, await res.blob());
  }

  return (
    <div className="space-y-4" data-testid="upload-form">
      {!canUpload && reason && <p className="text-sm text-muted">{reason}</p>}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const input = (e.currentTarget.elements.namedItem("file") as HTMLInputElement | null)?.files?.[0];
          if (input) void send(input.name, input);
        }}
      >
        <label htmlFor={`${id}-file`} className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium">Export file</span>
          <input
            id={`${id}-file`}
            name="file"
            type="file"
            required
            disabled={!canUpload || !!busy}
            accept=".csv,.tsv,.txt,.xlsx,.json"
            aria-describedby={`${id}-limits`}
            className="min-w-0 max-w-full rounded border border-border bg-surface px-2 py-1 text-sm file:mr-3 file:rounded file:border-0 file:bg-surface-2 file:px-2 file:py-1"
          />
          <span id={`${id}-limits`} className="text-xs text-faint">
            {limits}
          </span>
        </label>
        <Button type="submit" variant="primary" disabled={!canUpload} busy={!!busy && !SAMPLES.some((s) => s.file === busy)} busyLabel="Profiling…" testId="upload-submit">
          Upload and profile
        </Button>
      </form>
      <div>
        <p className="text-sm font-medium">Or try a synthetic export</p>
        <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {SAMPLES.map((s) => (
            <li key={s.file}>
              <button
                type="button"
                onClick={() => void sample(s.file)}
                disabled={!canUpload || !!busy}
                aria-busy={busy === s.file || undefined}
                className="tap-target relative flex w-full flex-col items-start rounded-md border border-border bg-surface px-3 py-2 text-left text-sm hover:border-accent disabled:opacity-50"
                data-testid={`sample-${s.file}`}
              >
                <span className="font-medium">{busy === s.file ? "Profiling…" : s.label}</span>
                <span className="text-xs text-muted">{s.what}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {error && (
        <p role="alert" className="text-sm text-bad" data-testid="upload-error">
          {error}
        </p>
      )}
    </div>
  );
}
