"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { MetricSnapshot, ReplayResult } from "@/lib/ingest/replay";

const money = (c: number | null) => (c === null ? "—" : `$${Math.round(c / 100).toLocaleString("en-US")}`);

function Delta({ label, before, after, fmt }: { label: string; before: number | null; after: number | null; fmt: (v: number | null) => string }) {
  const changed = before !== after;
  return (
    <tr>
      <td className="py-1 pr-4 text-muted">{label}</td>
      <td className="py-1 pr-4 text-right tabular-nums">{fmt(before)}</td>
      <td className={`py-1 text-right tabular-nums ${changed ? "font-semibold text-text" : "text-faint"}`}>{fmt(after)}</td>
    </tr>
  );
}

function Snapshot({ before, after }: { before: MetricSnapshot; after: MetricSnapshot }) {
  const n = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-US"));
  return (
    <table className="mt-2 text-sm">
      <thead>
        <tr className="text-[11px] uppercase text-faint">
          <th className="pr-4 text-left font-medium">{before.branchIds.join(", ") || "scope"} · whole period</th>
          <th className="pr-4 text-right font-medium">Before</th>
          <th className="text-right font-medium">After</th>
        </tr>
      </thead>
      <tbody>
        <Delta label="Paid-media CAC" before={before.paidCacCents} after={after.paidCacCents} fmt={money} />
        <Delta label="New customers from paid media" before={before.paidAcquired} after={after.paidAcquired} fmt={n} />
        <Delta label="Unattributed new customers" before={before.unknownAcquired} after={after.unknownAcquired} fmt={n} />
        <Delta label="New customers (all channels)" before={before.acquired} after={after.acquired} fmt={n} />
        <Delta label="Paid spend" before={before.paidSpendCents} after={after.paidSpendCents} fmt={money} />
        <Delta label="Open exceptions" before={before.openExceptions} after={after.openExceptions} fmt={n} />
        <Delta label="Conversions to report to Google Ads" before={before.googleConversionsToUpload ?? null} after={after.googleConversionsToUpload ?? null} fmt={n} />
        {Object.keys(after.channels ?? {})
          .filter((code) => before.channels?.[code]?.spendCents !== after.channels?.[code]?.spendCents)
          .flatMap((code) => [
            <Delta key={`${code}-spend`} label={`${code} spend`} before={before.channels?.[code]?.spendCents ?? null} after={after.channels[code].spendCents} fmt={money} />,
            <Delta key={`${code}-cac`} label={`${code} cost per customer`} before={before.channels?.[code]?.cacCents ?? null} after={after.channels[code].cacCents} fmt={money} />,
          ])}
      </tbody>
    </table>
  );
}

export function ReplayPanel({
  exceptionId,
  source,
  versions,
  defaultVersion,
  records,
  lastReplay,
  verb = "Replay",
}: {
  exceptionId: number;
  source: string;
  versions: string[];
  defaultVersion: string;
  records: number;
  /** The committed replay that resolved this group, if any — survives page reloads. */
  lastReplay?: ReplayResult | null;
  /** "Replay" retries held records; "Re-map" re-classifies stored ones. */
  verb?: "Replay" | "Re-map";
}) {
  const router = useRouter();
  const [version, setVersion] = useState(defaultVersion);
  // Re-sending the committed request reuses its key (and is a no-op). Any new work gets a new
  // key, created in the browser on first send: a key minted during server rendering would
  // differ from the one the browser hydrates with.
  const [key, setKey] = useState<string | null>(() => (lastReplay && records === 0 ? lastReplay.idempotencyKey : null));
  const send = () => {
    const k = key ?? crypto.randomUUID();
    setKey(k);
    void call(false, k);
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ReplayResult | null>(lastReplay ?? null);
  const [error, setError] = useState<string | null>(null);

  async function call(dryRun: boolean, idempotencyKey: string) {
    setBusy(dryRun ? "dry" : "real");
    setError(null);
    try {
      const res = await fetch("/api/replays", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ exceptionId, mapperVersion: version, dryRun, idempotencyKey }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setResult(body as ReplayResult);
      if (!dryRun) router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3" data-testid="replay-panel">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted">Mapper</span>
          <select aria-label="Mapper version" value={version} onChange={(e) => setVersion(e.target.value)} className="rounded border border-border bg-surface px-2 py-1">
            {versions.map((v) => (
              <option key={v} value={v}>
                {source}@{v}
                {v === defaultVersion ? " (deployed)" : ""}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={!!busy} onClick={() => call(true, crypto.randomUUID())} className="rounded border border-border px-3 py-1.5 hover:bg-surface-2 disabled:opacity-50">
          {busy === "dry" ? "Running…" : "Dry run (rolled back)"}
        </button>
        <button type="button" disabled={!!busy} onClick={send} className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50">
          {busy === "real" ? "Working…" : lastReplay && records === 0 ? "Send the same request again" : `${verb} ${records} record${records === 1 ? "" : "s"}`}
        </button>
        <button type="button" disabled={!!busy} onClick={() => setKey(crypto.randomUUID())} className="text-xs text-accent hover:underline disabled:opacity-50">
          new request key
        </button>
      </div>
      <p className="font-mono text-[11px] text-faint">Idempotency-Key: {key ?? "assigned on first send"}</p>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      {result && (
        <div className="rounded border border-border bg-surface-2 p-3 text-sm" data-testid="replay-result" aria-live="polite">
          <p className="font-medium">
            {result.dryRun
              ? "Dry run — nothing was saved. "
              : result === lastReplay
                ? `Committed ${verb.toLowerCase()} for this exception. `
                : result.alreadyProcessed
                  ? "Already processed — this key was used before; nothing ran again. "
                  : `${verb} committed. `}
            Claimed {result.claimed} of {result.requested} · projected {result.projected}
            {verb === "Replay" ? ` · still quarantined ${result.stillQuarantined}` : ` · left as they were ${result.errors.length}`}
          </p>
          {result.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-bad">
              {result.errors.slice(0, 3).map((e) => (
                <li key={e.rawEventId}>#{e.rawEventId} {e.code}: {e.detail}</li>
              ))}
            </ul>
          )}
          {result.before && result.after && <Snapshot before={result.before} after={result.after} />}
        </div>
      )}
    </div>
  );
}
