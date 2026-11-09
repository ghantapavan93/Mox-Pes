import Link from "next/link";
import type { ReactNode } from "react";
import { METRICS } from "@/lib/metrics/definitions";

export function Card({ title, subtitle, action, children, className = "" }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-border bg-surface ${className}`}>
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-text">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A number with its definition one click away. Every KPI on screen goes through this. */
export function Stat({ metric, value, sub, tone = "neutral", subTone = "neutral" }: { metric: keyof typeof METRICS; value: ReactNode; sub?: ReactNode; tone?: "neutral" | "bad" | "good"; subTone?: "neutral" | "bad" }) {
  const def = METRICS[metric];
  const toneClass = tone === "bad" ? "text-bad" : tone === "good" ? "text-good" : "text-text";
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <details className="group">
        <summary className="flex items-center justify-between gap-2 text-xs font-medium text-muted">
          <span>{def.label}</span>
          <span aria-hidden className="rounded border border-border px-1 text-[10px] text-faint group-open:bg-surface-2">def</span>
          <span className="sr-only">Show definition</span>
        </summary>
        <div className="mt-2 space-y-1 rounded bg-surface-2 p-2 text-[11px] leading-snug text-muted">
          <p><span className="font-semibold text-text">Formula.</span> {def.formula}</p>
          <p><span className="font-semibold text-text">Source.</span> {def.sources}</p>
          <p><span className="font-semibold text-text">Caveat.</span> {def.caveat}</p>
        </div>
      </details>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {sub && <p className={`mt-1 text-xs ${subTone === "bad" ? "font-medium text-bad" : "text-muted"}`}>{sub}</p>}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "bad" | "warn" | "good" | "accent" }) {
  const map = {
    neutral: "bg-surface-2 text-muted",
    bad: "bg-bad-soft text-bad",
    warn: "bg-warn-soft text-warn",
    good: "bg-good-soft text-good",
    accent: "bg-accent-soft text-accent",
  };
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${map[tone]}`}>{children}</span>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <Badge tone={severity === "high" ? "bad" : severity === "medium" ? "warn" : "neutral"}>{severity}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={status === "open" ? "warn" : "good"}>{status}</Badge>;
}

export function Th({ children, align = "left" }: { children?: ReactNode; align?: "left" | "right" }) {
  return <th className={`whitespace-nowrap border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint ${align === "right" ? "text-right" : "text-left"}`}>{children}</th>;
}

export function Td({ children, align = "left", className = "" }: { children?: ReactNode; align?: "left" | "right"; className?: string }) {
  return <td className={`border-b border-border px-3 py-2 align-top text-sm ${align === "right" ? "text-right tabular-nums" : ""} ${className}`}>{children}</td>;
}

export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse">{children}</table>
    </div>
  );
}

export function PeriodTabs({ current, base, extra = "" }: { current: string; base: string; extra?: string }) {
  const tabs = [
    ["oct", "October"],
    ["sep", "September"],
    ["all", "Both months"],
  ];
  return (
    <nav aria-label="Period" className="inline-flex rounded-md border border-border bg-surface p-0.5 text-xs">
      {tabs.map(([key, label]) => (
        <Link
          key={key}
          href={`${base}?period=${key}${extra}`}
          aria-current={current === key ? "page" : undefined}
          className={`rounded px-2.5 py-1 ${current === key ? "bg-text text-white" : "text-muted hover:text-text"}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function Skeleton({ lines = 6 }: { lines?: number }) {
  return (
    <div className="animate-pulse space-y-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-10 rounded bg-surface-2" />
      ))}
    </div>
  );
}

export function Forbidden({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft p-6 text-sm text-bad">
      <p className="font-semibold">403 — not in your scope</p>
      <p className="mt-1">{message}</p>
    </div>
  );
}

export function KV({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-dashed border-border pb-1">
          <dt className="text-muted">{k}</dt>
          <dd className="text-right font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
