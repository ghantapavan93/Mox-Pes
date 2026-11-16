"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

type Disposition = "reviewed_no_change" | "needs_investigation";

interface Draft {
  disposition: Disposition;
  rationale: string;
  owner: string;
}

interface Conflict {
  latestRunId: number;
  reviewedRunId: number;
  newFacts: number;
}

/**
 * The one decision on a drift case. "Record a decision" opens the form in place; the save names
 * the check the reviewer read (runId) and its evidence key, and the server refuses it when a newer
 * check carries something they have not seen. The draft survives that refusal (and a reload, in
 * this tab): nothing typed is lost.
 */
export function DriftDecision({
  exceptionId,
  runId,
  evidenceKey,
  leadCount,
  ownerOptions,
  canDecide,
  reopened,
  replacedBy = null,
}: {
  exceptionId: number;
  runId: number;
  evidenceKey: string;
  leadCount: number;
  ownerOptions: Array<{ value: string; label: string }>;
  canDecide: boolean;
  reopened: boolean;
  /** A newer ChangeGuard change set the live mapping: "no mapping change" then means this review changes nothing further. */
  replacedBy?: number | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const storageKey = `drift-review-draft:${exceptionId}`;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({ disposition: "reviewed_no_change", rationale: "", owner: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<(Conflict & { message: string }) | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const formId = useId();

  // A draft from earlier in this tab (a refused save, a reload): restore it and reopen the form.
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as Draft;
        if (parsed.rationale || parsed.owner) {
          // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring browser storage once, after hydration
          setDraft(parsed);
          setOpen(true);
        }
      }
    } catch {
      // Storage blocked: the draft lives only in this page.
    }
  }, [storageKey]);

  const update = (next: Partial<Draft>) => {
    setDraft((d) => {
      const merged = { ...d, ...next };
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(merged));
      } catch {
        // ignore
      }
      return merged;
    });
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch(`/api/exceptions/${exceptionId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          disposition: draft.disposition,
          runId,
          evidenceKey,
          rationale: draft.rationale,
          ...(draft.disposition === "needs_investigation" ? { owner: draft.owner } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string; issues?: string[]; conflict?: Conflict };
      if (res.status === 409 && json.conflict) {
        // The notice takes focus once it is on the page (the effect below).
        setConflict({ ...json.conflict, message: json.error ?? "Newer evidence arrived." });
        // Show what is new relative to the check this reviewer read; the draft stays in this form.
        router.replace(`${pathname}?since=${json.conflict.reviewedRunId}`, { scroll: false });
        return;
      }
      if (!res.ok) throw new Error([json.error ?? `HTTP ${res.status}`, ...(json.issues ?? [])].join(" — "));
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
      setDraft({ disposition: "reviewed_no_change", rationale: "", owner: "" });
      setConflict(null);
      setOpen(false);
      setSaved(json.message ?? "Saved.");
      router.replace(pathname, { scroll: false });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // A refused save: move focus to the conflict notice once React has put it on the page. A frame
  // callback requested next to setConflict can run before that commit, find no notice and drop the
  // focus; on a slowed CPU it mostly did (SUITE-STABILIZATION.md).
  useEffect(() => {
    if (conflict) alertRef.current?.focus();
  }, [conflict]);

  // Once the saved state arrives from the server, move focus to the decision it now shows.
  useEffect(() => {
    if (!saved) return;
    const target = document.getElementById("case-decision");
    target?.focus();
  }, [saved, canDecide]);

  const tooShort = draft.rationale.trim().length < 10;
  const needsOwner = draft.disposition === "needs_investigation" && !draft.owner;

  return (
    <div className="space-y-3" data-testid="drift-decision">
      {saved && (
        <p role="status" className="text-sm font-medium text-good" data-testid="decision-saved">
          {saved}
        </p>
      )}
      {canDecide && !open && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              requestAnimationFrame(() => firstField.current?.focus());
            }}
            aria-expanded={false}
            aria-controls={formId}
            className="inline-flex min-h-10 items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-white shadow-raised hover:bg-accent-hover"
            data-testid="record-decision"
          >
            Record a decision
          </button>
          <span className="text-sm text-muted">
            {reopened ? "Review the new evidence, then decide again." : "Reviewed with no mapping change, or needs investigation."}
          </span>
        </div>
      )}
      {canDecide && open && (
        <form id={formId} onSubmit={save} className="space-y-4 rounded-lg border border-border-strong bg-surface p-4" aria-label="Record a decision" data-testid="decision-form">
          {conflict && (
            <div ref={alertRef} tabIndex={-1} role="alert" className="rounded-md border border-bad/30 bg-bad-soft p-3 text-sm text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="stale-conflict">
              <p className="font-semibold">Not saved: newer evidence arrived</p>
              <p className="mt-1 text-muted">{conflict.message}</p>
              <p className="mt-2">
                <a href="#new-since-check" className="font-medium text-accent underline">
                  Read what is new (check #{conflict.latestRunId})
                </a>
              </p>
            </div>
          )}
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-semibold text-text">Decision</legend>
            {(
              [
                [
                  "reviewed_no_change",
                  "Reviewed — no mapping change",
                  replacedBy !== null
                    ? `Closes the case. Change #${replacedBy} already changed the mapping; this review changes nothing further and re-verifies nothing.`
                    : "Closes the case. The finding and the mapping stay as they are; nothing is re-verified.",
                ],
                ["needs_investigation", "Needs investigation", "Keeps the case open with an accountable owner."],
              ] as const
            ).map(([value, label, hint], i) => (
              <label key={value} className={`flex cursor-pointer gap-3 rounded-md border p-3 ${draft.disposition === value ? "border-accent bg-accent-soft" : "border-border"}`}>
                <input
                  ref={i === 0 ? firstField : undefined}
                  type="radio"
                  name="disposition"
                  value={value}
                  checked={draft.disposition === value}
                  onChange={() => update({ disposition: value })}
                  className="mt-1 size-4 accent-[var(--accent)]"
                />
                <span>
                  <span className="block text-sm font-semibold text-text">{label}</span>
                  <span className="block text-xs text-muted">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {draft.disposition === "needs_investigation" && (
            <label className="block text-sm">
              <span className="font-medium text-text">Owner</span>
              <select
                required
                value={draft.owner}
                onChange={(e) => update({ owner: e.target.value })}
                className="mt-1 block min-h-10 w-full rounded-md border border-border-strong bg-surface px-2 text-sm"
                data-testid="decision-owner"
              >
                <option value="">Choose the accountable role…</option>
                {ownerOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-sm">
            <span className="font-medium text-text">{draft.disposition === "needs_investigation" ? "What needs checking?" : "Why no mapping change? Say what you checked."}</span>
            <textarea
              required
              minLength={10}
              maxLength={1000}
              rows={3}
              value={draft.rationale}
              onChange={(e) => update({ rationale: e.target.value })}
              aria-describedby={`${formId}-scope`}
              className="mt-1 block w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
              data-testid="decision-rationale"
            />
          </label>
          <p id={`${formId}-scope`} className="text-xs text-muted">
            Bound to check #{runId} ({leadCount} changed {leadCount === 1 ? "lead" : "leads"}). If a newer check has found something you have not seen, the save is refused and this note is kept.
          </p>
          {error && (
            <p role="alert" className="text-sm text-bad">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={busy || tooShort || needsOwner}
              className="inline-flex min-h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="save-decision"
            >
              {busy ? "Saving…" : "Save decision"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="inline-flex min-h-10 items-center rounded-md border border-border px-3 text-sm hover:bg-surface-2">
              Cancel
            </button>
            {(tooShort || needsOwner) && (
              <span className="text-xs text-muted">{needsOwner ? "Choose an owner and say what needs checking (10+ characters)." : "Write at least 10 characters."}</span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
