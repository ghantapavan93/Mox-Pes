import type { Bridge as BridgeData } from "@/lib/metrics/scorecard";
import { count } from "@/lib/format";

/**
 * From what ad platforms claim to verified paid customers. Each step is a count from the
 * database; the prospect buckets are exclusive and add up (asserted in tests).
 */
export function Bridge({ data, periodLabel }: { data: BridgeData; periodLabel: string }) {
  const max = Math.max(data.platformClaimed, data.paidLeadRecords, 1);
  const steps: Array<{ label: string; value: number; note: string; tone: "base" | "loss" | "win" }> = [
    { label: "Conversions claimed by ad platforms", value: data.platformClaimed, note: "Platform-reported, includes view-throughs and repeats", tone: "base" },
    { label: "Paid lead records received", value: data.paidLeadRecords, note: `Platforms claim ${count(Math.max(data.platformClaimed - data.paidLeadRecords, 0))} more than arrived as lead records (view-throughs, repeat conversions, platform counting rules)`, tone: "base" },
    { label: "Unique paid prospects", value: data.paidProspects, note: `${count(data.paidLeadRecords - data.paidProspects)} were repeat contacts from the same person`, tone: "base" },
    { label: "Already customers", value: data.existingCustomers, note: "Existing customers are not acquisitions", tone: "loss" },
    { label: "Not sold (yet)", value: data.notSold, note: "Includes leads still being worked", tone: "loss" },
    { label: "Sold, credited to another channel", value: data.creditedElsewhere, note: "An earlier evidenced touch wins (first-touch policy)", tone: "loss" },
    { label: "Sold, initial service not completed", value: data.soldNotServiced, note: "Pending, cancelled or no-show", tone: "loss" },
    { label: "Verified paid customers (serviced)", value: data.serviced, note: "Initial service completed in the CRM", tone: "win" },
  ];
  return (
    <div>
      <p className="mb-3 text-xs text-muted">
        Paid prospects whose first contact was in {periodLabel}, followed to their outcome as of the data cut-off.
      </p>
      <ol className="space-y-2">
        {steps.map((s) => (
          <li key={s.label} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted">{s.label}</span>
              <span className="font-semibold tabular-nums">{count(s.value)}</span>
            </div>
            <div className="mt-1 h-2.5 rounded bg-surface-2" title={s.note}>
              <div
                className={`h-full rounded ${s.tone === "win" ? "bg-good" : s.tone === "loss" ? "bg-warn/60" : "bg-accent/70"}`}
                style={{ width: `${Math.max((s.value / max) * 100, s.value > 0 ? 0.6 : 0)}%` }}
              />
            </div>
            <p className="mt-0.5 text-[11px] text-faint">{s.note}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
