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
  /** Campaign-days held at their newest version, with no counted version. */
  campaignDays: number;
  amountCents: number;
}

type Call = (key: string, url: string, body: Record<string, unknown>, done: string) => Promise<boolean>;

const MIN_REASON = 10;

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The error a route sent, or a plain one when the response is not JSON (a proxy page, a crash). */
async function errorOf(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof json?.error === "string" ? json.error : `The request failed (HTTP ${res.status})`;
}

/**
 * Ad accounts whose feed states no currency, and the rules that make their spend count as USD.
 * Without a rule the spend is excluded and listed here, never assumed. An engineer proposes a
 * rule with a reason; a different person with approval rights authorizes it (lib/currency/rules.ts).
 * Pending proposals are shown in full; authorized rules fold behind their count. Each account
 * keeps its own reason, so text typed for one is never sent for another.
 */
export function CurrencyRules({ rules, awaiting, canPropose, canApprove, subject }: { rules: Rule[]; awaiting: Awaiting[]; canPropose: boolean; canApprove: boolean; subject: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const call: Call = async (key, url, body, done) => {
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await errorOf(res));
      const json = (await res.json().catch(() => ({}))) as { reprojected?: number; excluded?: number };
      setMessage({ ok: true, text: done.replace("{n}", String(json.reprojected ?? json.excluded ?? 0)) });
      router.refresh();
      return true;
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
      return false;
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
          {awaiting.map((a) => {
            const key = `${a.platform}:${a.adAccountId}`;
            const reason = reasons[key] ?? "";
            const inputId = `currency-reason-${key.replace(/[^\w-]/g, "_")}`;
            // A rule already proposed for this account waits for a second person: no second proposal.
            const pendingRule = pending.find((r) => r.platform === a.platform && r.adAccountId === a.adAccountId);
            return (
              <li key={key} className="rounded border border-border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warn">held</Badge>
                  <span className="break-all font-mono text-xs">
                    {a.platform} · {a.adAccountId}
                  </span>
                  <span className="min-w-0 break-words text-muted">
                    {a.campaignDays} campaign-day{a.campaignDays === 1 ? "" : "s"} of spend, {dollars(a.amountCents)} as written, not counted: the feed states no currency
                  </span>
                </div>
                {pendingRule && <p className="mt-1 text-xs text-muted">A rule for this account is proposed by {pendingRule.proposedBy} and waits for a different approver; the spend stays held until then.</p>}
                {canPropose && !pendingRule && (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <label htmlFor={inputId} className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="text-xs text-muted">Why {a.adAccountId} reports in USD</span>
                      <input
                        id={inputId}
                        value={reason}
                        onChange={(e) => setReasons((all) => ({ ...all, [key]: e.target.value }))}
                        placeholder="e.g. the account's settings show USD billing"
                        className="min-w-0 rounded border border-border bg-surface px-2 py-1"
                      />
                    </label>
                    <button
                      type="button"
                      aria-label={`Propose a USD rule for ${a.platform} account ${a.adAccountId}`}
                      disabled={busy !== null || reason.trim().length < MIN_REASON}
                      onClick={async () => {
                        const ok = await call(`p:${key}`, "/api/currency-rules", { platform: a.platform, adAccountId: a.adAccountId, reason }, "Proposed. It counts once another person authorizes it.");
                        if (ok) setReasons((all) => ({ ...all, [key]: "" }));
                      }}
                      className="rounded bg-text px-3 py-1 text-white disabled:opacity-50"
                    >
                      Propose USD rule
                    </button>
                  </div>
                )}
              </li>
            );
          })}
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
          <summary className="cursor-pointer text-xs text-muted">
            {authorized.length} authorized account rule{authorized.length === 1 ? "" : "s"}
          </summary>
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
  // Revoking asks for its reason inline: the form stays on the page, readable and labelled, and
  // nothing is sent until the reason is long enough.
  const [revoking, setRevoking] = useState(false);
  const [why, setWhy] = useState("");
  const account = `${r.platform} account ${r.adAccountId}`;
  return (
    <li className="rounded bg-surface-2 px-2 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={r.authorizedBy ? "good" : "accent"}>{r.authorizedBy ? "authorized" : "awaiting a second person"}</Badge>
        <span className="break-all font-mono text-xs">
          {r.platform} · {r.adAccountId}
        </span>
        <span className="min-w-0 break-words text-xs text-muted">
          “{r.reason}” — proposed by {r.proposedBy}
          {r.authorizedBy ? `, authorized by ${r.authorizedBy}` : ""}
          {r.heldRecords > 0 ? ` · ${r.heldRecords} record${r.heldRecords === 1 ? "" : "s"} still held` : ""}
        </span>
        {!r.authorizedBy && canApprove && r.proposedBy !== subject && (
          <button
            type="button"
            aria-label={`Authorize the USD rule for ${account}`}
            disabled={busy !== null}
            onClick={() => void call(`a:${r.id}`, `/api/currency-rules/${r.id}`, { action: "authorize" }, "Authorized: {n} spend record(s) now count as USD.")}
            className="rounded border border-border px-2 py-0.5 text-xs"
          >
            Authorize
          </button>
        )}
        {(canPropose || canApprove) && !revoking && (
          <button type="button" aria-label={`Revoke the USD rule for ${account}`} disabled={busy !== null} onClick={() => setRevoking(true)} className="rounded border border-border px-2 py-0.5 text-xs text-muted">
            Revoke
          </button>
        )}
      </div>
      {revoking && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label htmlFor={`revoke-${r.id}`} className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs text-muted">Why the rule for {r.adAccountId} no longer holds</span>
            <input id={`revoke-${r.id}`} value={why} onChange={(e) => setWhy(e.target.value)} className="min-w-0 rounded border border-border bg-surface px-2 py-1 text-xs" />
          </label>
          <button
            type="button"
            disabled={busy !== null || why.trim().length < MIN_REASON}
            onClick={async () => {
              const ok = await call(`r:${r.id}`, `/api/currency-rules/${r.id}`, { action: "revoke", reason: why }, "Revoked: {n} spend record(s) excluded again.");
              if (ok) {
                setRevoking(false);
                setWhy("");
              }
            }}
            className="rounded border border-bad px-2 py-0.5 text-xs text-bad disabled:opacity-50"
          >
            Confirm revoke
          </button>
          <button type="button" onClick={() => setRevoking(false)} className="rounded px-2 py-0.5 text-xs text-muted">
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}
