"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

/**
 * Enter another system's figure or answer and check it (POST /api/shadow). The definition
 * presets say in plain words what the other system computed; each maps to the shared vocabulary
 * (docs/agent-work/SHADOW-MODE.md §1). The server re-checks scope and permission.
 */

const PRESETS = {
  paid_cac: { label: "Paid-media CAC: paid spend ÷ new customers whose first touch was paid", definition: { id: "atlas.paid_cac", version: "3", family: "cac", numerator: "paid_media_spend_mapped_to_branch", population: "new_customers_first_serviced_paid_first_touch", periodBasis: "utc_day", branchBasis: "campaign_mapping" } },
  blended_cac: { label: "Blended CAC: all media spend ÷ all new customers", definition: { id: "atlas.blended_cac", version: "1", family: "cac", numerator: "all_media_spend", population: "new_customers_first_serviced", periodBasis: "utc_day", branchBasis: "campaign_mapping" } },
  paid_spend: { label: "Paid media spend mapped to the branch", definition: { id: "atlas.paid_spend", version: "1", family: "spend", numerator: "paid_media_spend_mapped_to_branch", periodBasis: "utc_day", branchBasis: "campaign_mapping" } },
  new_customers: { label: "New customers serviced (any channel)", definition: { id: "atlas.new_customers", version: "1", family: "customers", population: "new_customers_first_serviced", periodBasis: "utc_day", branchBasis: "crm_office" } },
  sold_customers: { label: "Customers sold (service not required)", definition: { id: "atlas.sold", version: "1", family: "customers", population: "customers_sold", periodBasis: "utc_day", branchBasis: "crm_office" } },
  collected: { label: "Collected cash, refunds subtracted", definition: { id: "atlas.collected", version: "1", family: "cash", cashBasis: "payment_date_net_of_refunds", periodBasis: "utc_day", branchBasis: "crm_office" } },
  gross: { label: "Gross payments, refunds not subtracted", definition: { id: "atlas.gross", version: "1", family: "cash", cashBasis: "payment_date_gross", periodBasis: "utc_day", branchBasis: "crm_office" } },
  invoiced: { label: "Invoiced revenue (not collected)", definition: { id: "atlas.invoiced", version: "1", family: "cash", cashBasis: "invoice_date", periodBasis: "utc_day", branchBasis: "crm_office" } },
} as const;
type Preset = keyof typeof PRESETS;

const field = "w-full rounded border border-border bg-surface px-2 py-1 text-sm";

export function ShadowForm({ branches, initial }: { branches: Array<{ id: string; label: string }>; initial: { branch: string | null; preset: string | null; kind: "snapshot" | "answer" } }) {
  const router = useRouter();
  const id = useId();
  const [kind, setKind] = useState<"snapshot" | "answer">(initial.kind);
  const [system, setSystem] = useState("Atlas BI (synthetic)");
  const [preset, setPreset] = useState<Preset>((initial.preset && initial.preset in PRESETS ? initial.preset : "paid_cac") as Preset);
  const [branch, setBranch] = useState(initial.branch ?? branches[0]?.id ?? "");
  const [from, setFrom] = useState("2026-10-01");
  const [to, setTo] = useState("2026-10-30");
  const [currency, setCurrency] = useState("USD");
  const [value, setValue] = useState("");
  const [asOf, setAsOf] = useState("2026-10-31T06:00");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = kind === "answer" ? answer.trim().length > 0 : branch !== "" && /^-?\d+(\.\d{1,4})?$/.test(value.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const asOfIso = new Date(`${asOf}:00Z`).toISOString();
    const body =
      kind === "answer"
        ? { kind, input: { system, asOf: asOfIso, question: "", answer } }
        : { kind, input: { system, asOf: asOfIso, definition: PRESETS[preset].definition, scope: { branch }, period: { from, to }, currency: currency === "none" ? null : currency, value: value.trim() } };
    try {
      const res = await fetch("/api/shadow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => null)) as { check?: { id: number }; error?: string; issues?: string[] } | null;
      if (!res.ok || !json?.check) throw new Error(json?.error ? `${json.error}${json.issues ? `: ${json.issues.join("; ")}` : ""}` : `The check could not run (HTTP ${res.status}). Nothing was recorded; try again.`);
      router.push(`/assurance/${json.check.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 text-sm" data-testid="shadow-form" aria-label="Check another system">
      <fieldset className="flex flex-wrap gap-4">
        <legend className="sr-only">What to check</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name={`${id}-kind`} checked={kind === "snapshot"} onChange={() => setKind("snapshot")} />
          A figure from a report
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={`${id}-kind`} checked={kind === "answer"} onChange={() => setKind("answer")} />
          An answer someone was given
        </label>
      </fieldset>

      <label className="block space-y-1">
        <span className="block text-xs text-muted">Which system it came from</span>
        <input value={system} onChange={(e) => setSystem(e.target.value)} className={field} maxLength={80} required />
      </label>

      {kind === "snapshot" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 sm:col-span-2">
            <span className="block text-xs text-muted">What the figure measures (as the other system defines it)</span>
            <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className={field}>
              {(Object.keys(PRESETS) as Preset[]).map((k) => (
                <option key={k} value={k}>
                  {PRESETS[k].label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">Branch</span>
            <select value={branch} onChange={(e) => setBranch(e.target.value)} className={field}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">Value as reported (dollars, or a count)</span>
            <input value={value} onChange={(e) => setValue(e.target.value)} className={field} inputMode="decimal" placeholder="237.00" required />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">First day (UTC)</span>
            <input type="date" value={from} min="2026-09-01" max="2026-10-31" onChange={(e) => setFrom(e.target.value)} className={field} required />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">Last day, included (UTC)</span>
            <input type="date" value={to} min="2026-09-01" max="2026-10-31" onChange={(e) => setTo(e.target.value)} className={field} required />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">Currency</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} className={field}>
              <option value="USD">USD</option>
              <option value="CAD">CAD</option>
              <option value="none">Not stated</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">Report refreshed at (UTC)</span>
            <input type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={field} required />
          </label>
        </div>
      ) : (
        <label className="block space-y-1">
          <span className="block text-xs text-muted">The answer, exactly as it was given (it is read, never followed)</span>
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} className={`${field} min-h-28`} maxLength={8000} required />
        </label>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy || !ready} className="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover disabled:opacity-50">
          {busy ? "Checking against the records…" : "Check it"}
        </button>
        <span className="text-xs text-faint">Reads the product&apos;s records; changes nothing in either system. The check itself is recorded.</span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
    </form>
  );
}
