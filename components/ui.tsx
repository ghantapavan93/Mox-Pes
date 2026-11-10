import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Info, XCircle } from "lucide-react";
import { METRICS } from "@/lib/metrics/definitions";

/**
 * The shared component library (docs/design-system.md). Pages compose these; they do not
 * style surfaces, tables, badges or headers themselves, so the whole product changes together.
 */

// ── Surfaces ────────────────────────────────────────────────────────────────

/** A titled panel. `flush` drops the body padding for edge-to-edge tables. */
export function Card({
  title,
  subtitle,
  action,
  children,
  className = "",
  id,
  flush = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  flush?: boolean;
}) {
  return (
    // min-w-0: as a grid or flex item a panel may shrink below its widest table, which then
    // scrolls inside the panel instead of widening the page.
    <section id={id} className={`min-w-0 scroll-mt-20 rounded-lg border border-border bg-surface shadow-raised ${className}`}>
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-[13px] font-semibold leading-5 text-text">{title}</h2>}
            {subtitle && <p className="mt-0.5 max-w-3xl text-xs leading-5 text-muted">{subtitle}</p>}
          </div>
          {action && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}

/** Page title block: breadcrumbs, eyebrow, title, one-line description, actions, toolbar. */
export function PageHeader({
  crumbs,
  eyebrow,
  title,
  description,
  badges,
  actions,
  toolbar,
}: {
  crumbs?: Array<{ href?: string; label: ReactNode }>;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-muted">
            {crumbs.map((c, i) => (
              <li key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight aria-hidden className="size-3 text-faint" />}
                {c.href ? (
                  <Link href={c.href} className="hover:text-text hover:underline">{c.label}</Link>
                ) : (
                  <span aria-current="page" className="text-text">{c.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 max-w-4xl">
          {eyebrow && <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">{eyebrow}</p>}
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <h1 className="text-[22px] font-semibold leading-8 tracking-tight text-text">{title}</h1>
            {badges}
          </div>
          {description && <div className="mt-1 text-sm leading-6 text-muted">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {toolbar && <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">{toolbar}</div>}
    </div>
  );
}

// ── Controls ────────────────────────────────────────────────────────────────

/** Link-based segmented control: the choice lives in the URL, so it is shareable and back-able. */
export function Segmented({ label, items, testId }: { label: string; items: Array<{ href: string; label: ReactNode; current: boolean }>; testId?: string }) {
  return (
    <nav aria-label={label} data-testid={testId} className="inline-flex max-w-full items-center overflow-x-auto rounded-md border border-border bg-surface p-0.5 text-xs shadow-raised">
      <span className="sr-only">{label}:</span>
      {items.map((it, i) => (
        <Link
          key={i}
          href={it.href}
          aria-current={it.current ? "page" : undefined}
          className={`whitespace-nowrap rounded px-2.5 py-1 font-medium ${it.current ? "bg-text text-white" : "text-muted hover:bg-surface-2 hover:text-text"}`}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}

export function PeriodTabs({ current, base, extra = "" }: { current: string; base: string; extra?: string }) {
  const tabs = [
    ["oct", "October"],
    ["sep", "September"],
    ["all", "Both months"],
  ];
  return <Segmented label="Period" items={tabs.map(([key, label]) => ({ href: `${base}?period=${key}${extra}`, label, current: current === key }))} />;
}

/** Primary / secondary / ghost link-buttons, one style everywhere. */
export function ButtonLink({ href, children, variant = "secondary", testId, icon }: { href: string; children: ReactNode; variant?: "primary" | "secondary" | "ghost"; testId?: string; icon?: ReactNode }) {
  const styles = {
    primary: "bg-accent text-white hover:bg-accent-hover border-transparent",
    secondary: "bg-surface text-text border-border hover:bg-surface-2",
    ghost: "border-transparent text-accent hover:bg-accent-soft",
  }[variant];
  return (
    <Link href={href} data-testid={testId} className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium shadow-raised ${styles}`}>
      {icon}
      {children}
    </Link>
  );
}

// ── Data display ────────────────────────────────────────────────────────────

/** A KPI with its definition one click away. Every headline number goes through this. */
export function Stat({
  metric,
  value,
  sub,
  tone = "neutral",
  subTone = "neutral",
  delta,
}: {
  metric: keyof typeof METRICS;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "neutral" | "bad" | "good";
  subTone?: "neutral" | "bad";
  /** Change against a comparison period; `good` says which direction is better for this metric. */
  delta?: { label: string; direction: "up" | "down" | "flat"; good: boolean | null };
}) {
  const def = METRICS[metric];
  const toneClass = tone === "bad" ? "text-bad" : tone === "good" ? "text-good" : "text-text";
  return (
    <div className="flex flex-col rounded-lg border border-border bg-surface p-4 shadow-raised">
      <details className="group">
        <summary className="flex items-start justify-between gap-2 text-xs font-medium leading-4 text-muted">
          <span>{def.label}</span>
          <Info aria-hidden className="size-3.5 shrink-0 text-faint group-open:text-accent" />
          <span className="sr-only">Show definition</span>
        </summary>
        <div className="mt-2 space-y-1 rounded bg-surface-2 p-2 text-[11px] leading-snug text-muted">
          <p><span className="font-semibold text-text">Formula.</span> {def.formula}</p>
          <p><span className="font-semibold text-text">Source.</span> {def.sources}</p>
          <p><span className="font-semibold text-text">Caveat.</span> {def.caveat}</p>
        </div>
      </details>
      <p className={`mt-2 text-[26px] font-semibold leading-8 tracking-tight tabular-nums ${toneClass}`}>{value}</p>
      {delta && (
        <p className={`mt-0.5 text-xs font-medium tabular-nums ${delta.good === null ? "text-muted" : delta.good ? "text-good" : "text-bad"}`}>
          <span aria-hidden>{delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "■"}</span> {delta.label}
        </p>
      )}
      {sub && <p className={`mt-1 text-xs leading-4 ${subTone === "bad" ? "font-medium text-bad" : "text-muted"}`}>{sub}</p>}
    </div>
  );
}

export function Badge({ children, tone = "neutral", dot = false }: { children: ReactNode; tone?: "neutral" | "bad" | "warn" | "good" | "accent"; dot?: boolean }) {
  const map = {
    neutral: "bg-surface-2 text-muted ring-border",
    bad: "bg-bad-soft text-bad ring-bad/20",
    warn: "bg-warn-soft text-warn ring-warn/20",
    good: "bg-good-soft text-good ring-good/20",
    accent: "bg-accent-soft text-accent ring-accent/20",
  };
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${map[tone]}`}>
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <Badge dot tone={severity === "high" ? "bad" : severity === "medium" ? "warn" : "neutral"}>{severity}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={status === "open" ? "warn" : status === "acknowledged" ? "neutral" : "good"}>{status}</Badge>;
}

export function Th({ children, align = "left" }: { children?: ReactNode; align?: "left" | "right" }) {
  return (
    <th scope="col" className={`sticky top-0 whitespace-nowrap border-b border-border bg-surface-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

export function Td({ children, align = "left", className = "" }: { children?: ReactNode; align?: "left" | "right"; className?: string }) {
  return <td className={`border-b border-border px-3 py-2 align-top text-sm leading-5 ${align === "right" ? "text-right tabular-nums" : ""} ${className}`}>{children}</td>;
}

/** A horizontally scrollable table. Inside a padded Card it bleeds to the card edges. */
export function TableWrap({ children, flush = false, minWidth = 640 }: { children: ReactNode; flush?: boolean; minWidth?: number }) {
  return (
    <div className={`${flush ? "" : "-mx-4"} overflow-x-auto`}>
      <table className="w-full border-collapse [&_tbody_tr:hover]:bg-surface-2/60" style={{ minWidth }}>{children}</table>
    </div>
  );
}

/** Label/value pairs. `columns={1}` for a narrow rail. */
export function KV({ items, columns = 2 }: { items: Array<[string, ReactNode]>; columns?: 1 | 2 }) {
  return (
    <dl className={`grid grid-cols-1 gap-x-6 gap-y-2 text-sm ${columns === 2 ? "sm:grid-cols-2" : ""}`}>
      {items.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-dashed border-border pb-1">
          <dt className="text-muted">{k}</dt>
          <dd className="text-right font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Feedback ────────────────────────────────────────────────────────────────

const CALLOUT = {
  info: { icon: Info, box: "border-accent/25 bg-accent-soft", text: "text-text", iconClass: "text-accent" },
  warn: { icon: AlertTriangle, box: "border-warn/30 bg-warn-soft", text: "text-text", iconClass: "text-warn" },
  bad: { icon: XCircle, box: "border-bad/30 bg-bad-soft", text: "text-text", iconClass: "text-bad" },
  good: { icon: CheckCircle2, box: "border-good/30 bg-good-soft", text: "text-text", iconClass: "text-good" },
} as const;

/** A status message with an icon: why something is blocked, stale, or done. */
export function Callout({ tone = "info", title, children, action, testId }: { tone?: keyof typeof CALLOUT; title?: ReactNode; children?: ReactNode; action?: ReactNode; testId?: string }) {
  const c = CALLOUT[tone];
  const Icon = c.icon;
  return (
    <div className={`flex gap-3 rounded-lg border px-4 py-3 text-sm ${c.box}`} data-testid={testId}>
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${c.iconClass}`} />
      <div className={`min-w-0 flex-1 ${c.text}`}>
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5 text-muted" : ""}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function EmptyState({ title, children, testId }: { title: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-surface px-6 py-8 text-center" data-testid={testId}>
      <p className="text-sm font-medium text-text">{title}</p>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Skeleton({ lines = 6 }: { lines?: number }) {
  return (
    <div className="animate-pulse space-y-3" role="status" aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} aria-hidden className="h-10 rounded-md bg-sunken" />
      ))}
      {/* Last child: space-y margins then leave the placeholder bars where they were. */}
      <span className="sr-only">Loading…</span>
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

// ── Charts ──────────────────────────────────────────────────────────────────

/** A tiny trend line for a KPI tile; decorative (the number beside it is the content). */
export function Sparkline({ values, tone = "neutral" }: { values: Array<number | null>; tone?: "neutral" | "bad" | "good" }) {
  const v = values.map((x) => x ?? 0);
  const max = Math.max(...v, 1);
  const min = Math.min(...v, 0);
  const step = v.length > 1 ? 100 / (v.length - 1) : 100;
  const y = (x: number) => 22 - ((x - min) / (max - min || 1)) * 20;
  const d = v.map((x, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)},${y(x).toFixed(2)}`).join(" ");
  const stroke = tone === "bad" ? "var(--bad)" : tone === "good" ? "var(--good)" : "var(--chart-paid)";
  return (
    <svg aria-hidden viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full">
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
