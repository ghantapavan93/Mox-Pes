"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui";

interface Rule {
  id: number;
  platform: string;
  adAccountId: string;
  proposedBy: string;
  reason: string;
  authorizedBy: string | null;
  heldRecords: number;
}

interface Awaiting {
  platform: string;
  adAccountId: string;
  records: number;
  amountCents: number;
}

type Call = (key: string, url: string, body: Record<string, unknown>, done: string) => Promise<void>;

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Ad accounts whose feed states no currency, and the rules that make their spend count as USD.
 * Without a rule the spend is excluded and listed here, never assumed. An engineer proposes a
 * rule with a reason; a different person with approval rights authorizes it (lib/currency/rules.ts).
 * Pending proposals are shown in full; authorized rules fold behind their count.
 */
export function CurrencyRules({ rules, awaiting, canPropose, canApprove, subject }: { rules: Rule[]; awaiting: Awaiting[]; canPropose: boolean; canApprove: boolean; subject: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reason, setReason] = useState("");

  const call: Call = async (key, url, body, done) => {
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setMessage({ ok: true, text: done.replace("{n}", String(json.reprojected ?? json.excluded ?? "")) });
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const pending = rules.filter((r) => !r.authorizedBy);
  const authorized = rules.filter((r) => r.authorizedBy);
  const rowProps = { busy, canApprove, canPropose, subject, call };

  return (
    <div className="space-y-3 text-sm" data-testid="currency-rules">
      {awaiting.length === 0 ? (
        <p className="text-muted">No spend is held for lacking a stated currency.</p>
      ) : (
        <ul className="space-y-2">
          {awaiting.map((a) => (
            <li key={`${a.platform}:${a.adAccountId}`} className="rounded border border-border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="warn">held</Badge>
                <span className="font-mono text-xs">
                  {a.platform} · {a.adAccountId}
                </span>
                <span className="text-muted">
                  {a.records} spend record{a.records === 1 ? "" : "s"}, {dollars(a.amountCents)} as written, not counted: the feed states no currency
                </span>
              </div>
              {canPropose && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-xs text-muted">Why this account reports in USD</span>
                    <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. the account's settings show USD billing" className="rounded border border-border bg-surface px-2 py-1" />
                  </label>
                  <button
                    type="button"
                    disabled={busy !== null || reason.trim().length < 10}
                    onClick={() => call(`p:${a.adAccountId}`, "/api/currency-rules", { platform: a.platform, adAccountId: a.adAccountId, reason }, "Proposed. It counts once another person authorizes it.")}
                    className="rounded bg-text px-3 py-1 text-white disabled:opacity-50"
                  >
                    Propose USD rule
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {pending.length > 0 && (
        <ul className="space-y-1">
          {pending.map((r) => (
            <RuleRow key={r.id} r={r} {...rowProps} />
          ))}
        </ul>
      )}
      {authorized.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted">{authorized.length} authorized account rule(s)</summary>
          <ul className="mt-1 space-y-1">
            {authorized.map((r) => (
              <RuleRow key={r.id} r={r} {...rowProps} />
            ))}
          </ul>
        </details>
      )}
      {message && (
        <p role="status" className={message.ok ? "text-good" : "text-bad"}>
          {message.text}
        </p>
      )}
    </div>
  );
}

function RuleRow({ r, busy, canApprove, canPropose, subject, call }: { r: Rule; busy: string | null; canApprove: boolean; canPropose: boolean; subject: string; call: Call }) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded bg-surface-2 px-2 py-1">
      <Badge tone={r.authorizedBy ? "good" : "accent"}>{r.authorizedBy ? "authorized" : "awaiting a second person"}</Badge>
      <span className="font-mono text-xs">
        {r.platform} · {r.adAccountId}
      </span>
      <span className="min-w-0 break-words text-xs text-muted">
        “{r.reason}” — proposed by {r.proposedBy}
        {r.authorizedBy ? `, authorized by ${r.authorizedBy}` : ""}
        {r.heldRecords > 0 ? ` · ${r.heldRecords} record(s) still held` : ""}
      </span>
      {!r.authorizedBy && canApprove && r.proposedBy !== subject && (
        <button type="button" disabled={busy !== null} onClick={() => call(`a:${r.id}`, `/api/currency-rules/${r.id}`, { action: "authorize" }, "Authorized: {n} spend record(s) now count as USD.")} className="rounded border border-border px-2 py-0.5 text-xs">
          Authorize
        </button>
      )}
      {(canPropose || canApprove) && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            const why = window.prompt("Why does this rule no longer hold? (at least 10 characters)") ?? "";
            if (why.trim().length >= 10) void call(`r:${r.id}`, `/api/currency-rules/${r.id}`, { action: "revoke", reason: why }, "Revoked: {n} spend record(s) excluded again.");
          }}
          className="rounded border border-border px-2 py-0.5 text-xs text-muted"
        >
          Revoke
        </button>
      )}
    </li>
  );
}
