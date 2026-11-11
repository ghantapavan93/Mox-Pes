"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

/** Synthetic exports (public/samples/README.md lists every deliberate difference from the ledger). */
export const SAMPLES: Array<{ file: string; label: string; what: string }> = [
  { file: "demo-crm-payments.csv", label: "CRM payments export", what: "Disagrees with the ledger on 2 payments; an invoice Total; damaged ids" },
  { file: "demo-calls.csv", label: "Call-tracking export", what: "US dates, branch names, a duplicate, an injected note" },
  { file: "demo-google-ads.csv", label: "Google Ads daily report", what: "Title lines, a total row, one restated day" },
  { file: "meta-spend-semicolon.csv", label: "Meta spend (semicolons)", what: "BOM, quoted newlines, a formula cell, dated after the business clock" },
  { file: "mixed-garbage.csv", label: "Not a supported dataset", what: "A correct system refuses to guess" },
];

/**
 * Sends a file's bytes to POST /api/onboarding/uploads. Samples are fetched from /samples and
 * sent through exactly the same request, so a demo exercises the real upload path.
 */
export function UploadForm({ canUpload, reason }: { canUpload: boolean; reason: string | null }) {
  const id = useId();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(name: string, bytes: Blob) {
    setBusy(name);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/uploads", { method: "POST", headers: { "x-filename": encodeURIComponent(name), "content-type": "application/octet-stream" }, body: bytes });
      const json = (await res.json().catch(() => ({}))) as { upload?: { id: number }; refused?: { code: string; message: string }; error?: string };
      if (json.refused) throw new Error(`Refused (${json.refused.code}): ${json.refused.message}`);
      if (!res.ok || !json.upload) throw new Error(json.error ?? `HTTP ${res.status}`);
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
            className="min-w-0 max-w-full rounded border border-border bg-surface px-2 py-1 text-sm file:mr-3 file:rounded file:border-0 file:bg-surface-2 file:px-2 file:py-1"
          />
          <span className="text-xs text-faint">CSV, XLSX or JSON, up to 5 MB and 50,000 rows. Staged rows are deleted after 24 hours.</span>
        </label>
        <button type="submit" disabled={!canUpload || !!busy} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50">
          {busy && !SAMPLES.some((s) => s.file === busy) ? "Profiling…" : "Upload and profile"}
        </button>
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
                className="flex w-full flex-col items-start rounded-md border border-border bg-surface px-3 py-2 text-left text-sm hover:border-accent disabled:opacity-50"
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
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
