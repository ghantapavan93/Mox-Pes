import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, CircleDashed, Info, LoaderCircle, Lock, Minus, Signature, TrendingDown, TrendingUp, XCircle } from "lucide-react";
import { METRICS } from "@/lib/metrics/definitions";

/**
 * The shared component library (docs/design-system.md). Pages compose these; they do not
 * style surfaces, tables, badges or headers themselves, so the whole product changes together.
 */

// ── Surfaces ────────────────────────────────────────────────────────────────

/**
 * A titled panel. `flush` drops the body padding for edge-to-edge tables. `size="sm"` is the
 * compact panel of a rail of single-job cards (12 px padding, 14 px title).
 */
export function Card({
  title,
  subtitle,
  action,
  children,
  className = "",
  id,
  flush = false,
  size = "default",
  testId,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  flush?: boolean;
  size?: "default" | "sm";
  testId?: string;
}) {
  const sm = size === "sm";
  return (
    // min-w-0: as a grid or flex item a panel may shrink below its widest table, which then
    // scrolls inside the panel instead of widening the page.
    // A hairline ring at 10% of the text colour, no shadow at rest: the frame recedes and the data
    // carries the colour (docs/design-system.md, "Surfaces"). Shadows are for overlays only.
    <section id={id} data-size={size} data-testid={testId} className={`min-w-0 scroll-mt-20 rounded-xl bg-surface ring-1 ring-text/10 ${className}`}>
      {(title || action) && (
        <header className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border ${sm ? "px-3 py-2.5" : "px-4 py-3"}`}>
          <div className="min-w-0">
            {title && <h2 className={`font-semibold tracking-tight text-text ${sm ? "text-sm leading-5" : "text-[15px] leading-6"}`}>{title}</h2>}
            {subtitle && <p className="mt-0.5 max-w-3xl text-xs leading-5 text-muted">{subtitle}</p>}
          </div>
          {action && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={flush ? "" : sm ? "p-3" : "p-4"}>{children}</div>
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
  quiet = false,
}: {
  crumbs?: Array<{ href?: string; label: ReactNode }>;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  /** Render the title as a quiet scope line, for a page whose verdict below is its strongest line. */
  quiet?: boolean;
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
            {/* `quiet`: the page's verdict sits below and is the strongest line; the title becomes its scope. */}
            <h1 className={quiet ? "text-sm font-medium leading-6 text-muted" : "text-[22px] font-semibold leading-8 tracking-tight text-text"}>{title}</h1>
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

/**
 * Link-based segmented control: the choice lives in the URL, so it is shareable and back-able.
 * A 32 px sunken track; the current item stays dark, the clearest selected state before any
 * interaction (docs/design-system.md, "Buttons and controls").
 */
export function Segmented({ label, items, testId }: { label: string; items: Array<{ href: string; label: ReactNode; current: boolean }>; testId?: string }) {
  return (
    <nav aria-label={label} data-testid={testId} className="inline-flex h-8 max-w-full items-center overflow-x-auto rounded-lg bg-sunken p-[3px] text-xs">
      <span className="sr-only">{label}:</span>
      {items.map((it, i) => (
        <Link
          key={i}
          href={it.href}
          aria-current={it.current ? "page" : undefined}
          className={`tap-target relative inline-flex h-full items-center whitespace-nowrap rounded-md px-2.5 font-medium transition-colors duration-100 ${it.current ? "bg-text text-white shadow-raised" : "text-muted hover:bg-surface hover:text-text"}`}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}

export function PeriodTabs({ current, base, extra = "" }: { current: string; base: string; extra?: string }) {
  // The tabs name their dates: "October" was read as the whole month, but the period ends Oct 30,
  // the last complete day before the data cut-off (lib/period.ts; panel audit Q12, R-56).
  const tabs = [
    ["oct", "Oct 1–30"],
    ["sep", "Sep 1–30"],
    ["all", "Sep 1 – Oct 30"],
  ];
  return <Segmented label="Period" items={tabs.map(([key, label]) => ({ href: `${base}?period=${key}${extra}`, label, current: current === key }))} />;
}

// ── Buttons ─────────────────────────────────────────────────────────────────

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  // The page's one main action for its current state.
  primary: "border-transparent bg-accent text-white shadow-raised hover:bg-accent-hover active:bg-accent-hover",
  secondary: "border-border bg-surface text-text shadow-raised hover:bg-surface-2 active:bg-sunken",
  ghost: "border-transparent text-accent hover:bg-accent-soft active:bg-accent-soft",
  // Reject, cancel, delete: an outline with red words, never a red fill.
  danger: "border-border bg-surface text-bad shadow-raised hover:bg-bad-soft active:bg-bad-soft",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  md: "h-8 gap-1.5 px-3 text-sm [&_svg]:size-4",
  sm: "h-7 gap-1 px-2.5 text-[13px] [&_svg]:size-3.5",
};

/**
 * One class list for every button and button-styled link (docs/design-system.md, "Buttons and
 * controls"): 32 px (`md`) or 28 px (`sm`) tall, 16 px icons (14 px at `sm`), an 8 px radius, a 1 px
 * press, and on coarse pointers an invisible hit area of at least 44 × 44 px (`.tap-target`,
 * app/globals.css) that leaves the visual size alone. Focus keeps the global outline.
 */
export function buttonClass({ variant = "secondary", size = "md", className = "" }: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return [
    "tap-target relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-lg border font-medium",
    "transition-colors duration-100 active:translate-y-px",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-busy:cursor-progress aria-busy:opacity-100 aria-busy:active:translate-y-0",
    BUTTON_SIZE[size],
    BUTTON_VARIANT[variant],
    className,
  ].join(" ");
}

/** A busy control's content: a spinner beside its working words. Under reduced motion the spinner holds still; the words say it. */
export function Working({ label }: { label: string }) {
  return (
    <>
      <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin" />
      {label}
    </>
  );
}

/**
 * A `<button>` in the shared style. `busy` keeps it focusable (`aria-disabled`, design rule 13),
 * ignores further presses, and shows `Working` with `busyLabel`; both labels share one grid cell,
 * so the button keeps the width of the wider one and nothing around it moves.
 */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  busy = false,
  busyLabel,
  testId,
  className,
  children,
  onClick,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode; busy?: boolean; busyLabel?: string; testId?: string }) {
  return (
    <button
      {...rest}
      type={type}
      data-testid={testId}
      data-variant={variant}
      aria-busy={busy || undefined}
      aria-disabled={busy || rest["aria-disabled"] ? true : undefined}
      onClick={busy ? (e) => e.preventDefault() : onClick}
      className={buttonClass({ variant, size, className })}
    >
      <span className="grid">
        <span className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-[inherit] ${busy && busyLabel ? "invisible" : ""}`}>
          {icon}
          {children}
        </span>
        {busyLabel && (
          <span className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-[inherit] ${busy ? "" : "invisible"}`}>
            <Working label={busyLabel} />
          </span>
        )}
      </span>
    </button>
  );
}

/** A link in the shared button style: the same variants and sizes as `Button`. */
export function ButtonLink({
  href,
  children,
  variant = "secondary",
  size = "md",
  testId,
  icon,
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  testId?: string;
  icon?: ReactNode;
}) {
  return (
    <Link href={href} data-testid={testId} data-variant={variant} className={buttonClass({ variant, size })}>
      {icon}
      {children}
    </Link>
  );
}

/**
 * Sticky in-page navigation for long pages (incident detail, Audit & Health). Every section is
 * linkable; sections set `scroll-mt` to clear it. Router links, not plain anchors: a plain `#`
 * anchor adds a history entry the router does not own, so Back from another page landed on it
 * with the other page still shown (B09-HANDOFF.md).
 */
export function SectionNav({ label, items, testId }: { label: string; items: Array<[href: string, label: string]>; testId?: string }) {
  return (
    <nav aria-label={label} className="sticky top-[49px] z-20 -mx-4 border-b border-border bg-bg/95 px-4 backdrop-blur lg:-mx-6 lg:px-6" data-testid={testId}>
      <ul className="flex gap-1 overflow-x-auto text-sm">
        {items.map(([href, text]) => (
          <li key={href}>
            <Link href={href} className="inline-block whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 font-medium text-muted hover:border-border-strong hover:text-text">
              {text}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ── Data display ────────────────────────────────────────────────────────────

/** Stable anchor of one metric's entry on /definitions, so any page can link straight to it. */
export function metricAnchor(key: string): string {
  return `metric-${key}`;
}

/** A KPI with its definition one click away. Every headline number goes through this. */
export function Stat({
  metric,
  value,
  sub,
  tone = "neutral",
  subTone = "neutral",
  delta,
  traceHref,
}: {
  metric: keyof typeof METRICS;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "neutral" | "bad" | "good";
  subTone?: "neutral" | "bad";
  /** Change against a comparison period; `good` says which direction is better for this metric. */
  delta?: { label: string; direction: "up" | "down" | "flat"; good: boolean | null };
  /** Where the number's evidence trace is (lib/lineage/trace.ts), for metrics that have one. */
  traceHref?: string;
}) {
  const def = METRICS[metric];
  const toneClass = tone === "bad" ? "text-bad" : tone === "good" ? "text-good" : "text-text";
  const TrendIcon = delta?.direction === "up" ? TrendingUp : delta?.direction === "down" ? TrendingDown : Minus;
  return (
    <div className="flex flex-col rounded-xl bg-surface p-4 ring-1 ring-text/10">
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
          <p>
            <Link href={`/definitions#${metricAnchor(String(metric))}`} className="font-medium text-accent hover:underline">
              Full definition
            </Link>
          </p>
        </div>
      </details>
      <p className={`mt-2 text-[26px] font-semibold leading-8 tracking-tight tabular-nums ${toneClass}`}>{value}</p>
      {delta && (
        // The sign and the words carry the change; the trend icon repeats it for the eye.
        <p className={`mt-1 inline-flex items-center gap-1 text-xs font-medium tabular-nums ${delta.good === null ? "text-muted" : delta.good ? "text-good" : "text-bad"}`}>
          <TrendIcon aria-hidden className="size-3.5 shrink-0" />
          {delta.label}
        </p>
      )}
      {sub && <p className={`mt-1 text-xs leading-4 ${subTone === "bad" ? "font-medium text-bad" : "text-muted"}`}>{sub}</p>}
      {traceHref && (
        <Link href={traceHref} className="mt-2 text-xs font-medium text-accent hover:underline" data-testid={`trace-link-${String(metric)}`}>
          Where does this come from?
        </Link>
      )}
    </div>
  );
}

/**
 * A headline count that is not a defined metric (queue sizes, feed counts). With `href` the whole
 * tile is a link to the filtered view behind the number. Defined metrics use `Stat` instead.
 */
export function KpiTile({
  label,
  value,
  sub,
  tone = "neutral",
  href,
  current = false,
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "neutral" | "bad" | "warn" | "good" | "accent";
  href?: string;
  current?: boolean;
  testId?: string;
}) {
  const toneClass = { neutral: "text-text", bad: "text-bad", warn: "text-warn", good: "text-good", accent: "text-accent" }[tone];
  const body = (
    <>
      <p className="text-xs font-medium leading-4 text-muted">{label}</p>
      <p className={`mt-2 text-[26px] font-semibold leading-8 tracking-tight tabular-nums ${toneClass}`}>{value}</p>
      {sub && <p className="mt-1 text-xs leading-4 text-muted">{sub}</p>}
    </>
  );
  // The panel's hairline ring; the active filter's tile is ringed in accent, 2 px, beside aria-current.
  const box = `block rounded-xl bg-surface p-4 ${current ? "ring-2 ring-accent" : "ring-1 ring-text/10"}`;
  return href ? (
    <Link href={href} aria-current={current ? "true" : undefined} data-testid={testId} className={`${box} transition-shadow duration-100 hover:ring-accent`}>
      {body}
    </Link>
  ) : (
    <div className={box} data-testid={testId}>
      {body}
    </div>
  );
}

/** Applied filters as removable chips; each chip links to the same view without that filter. */
export function FilterChips({ items, clearHref, testId }: { items: Array<{ label: ReactNode; removeHref: string }>; clearHref?: string; testId?: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Applied filters" data-testid={testId}>
      {items.map((it, i) => (
        <li key={i}>
          <Link href={it.removeHref} className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent-soft px-2 py-0.5 font-medium text-text hover:border-accent">
            {it.label}
            <span aria-hidden className="text-muted">×</span>
            <span className="sr-only">(remove filter)</span>
          </Link>
        </li>
      ))}
      {clearHref && items.length > 1 && (
        <li>
          <Link href={clearHref} className="px-1 font-medium text-accent hover:underline">Clear all</Link>
        </li>
      )}
    </ul>
  );
}

/** A labelled native select for GET filter forms (keyboard and screen-reader friendly by default). */
export function FilterSelect({ name, label, value, options }: { name: string; label: string; value: string; options: Array<[string, string]> }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium text-muted">{label}</span>
      <select name={name} defaultValue={value} className="h-8 max-w-full rounded-md border border-border-strong bg-surface px-2 text-sm text-text">
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Previous / next links with a "Showing a–b of n" summary. Disabled ends say so to assistive tech. */
export function Pager({ page, lastPage, first, last, total, hrefFor, label, testId }: { page: number; lastPage: number; first: number; last: number; total: number; hrefFor: (page: number) => string; label: string; testId?: string }) {
  const n = (x: number) => x.toLocaleString("en-US");
  const cls = "rounded-md border border-border px-2.5 py-1";
  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-muted" data-testid={testId}>
      <span>
        Showing {n(first)}–{n(last)} of {n(total)}
      </span>
      <span className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={hrefFor(page - 1)} className={`${cls} bg-surface font-medium text-accent hover:bg-surface-2`}>← Previous</Link>
        ) : (
          <span className={`${cls} text-faint`} aria-disabled="true">← Previous</span>
        )}
        <span>
          page {n(page)} of {n(lastPage)}
        </span>
        {page < lastPage ? (
          <Link href={hrefFor(page + 1)} className={`${cls} bg-surface font-medium text-accent hover:bg-surface-2`}>Next →</Link>
        ) : (
          <span className={`${cls} text-faint`} aria-disabled="true">Next →</span>
        )}
      </span>
    </nav>
  );
}

export type BadgeTone = "neutral" | "bad" | "warn" | "good" | "accent";

export function Badge({ children, tone = "neutral", dot = false, testId }: { children: ReactNode; tone?: BadgeTone; dot?: boolean; testId?: string }) {
  const map = {
    neutral: "bg-surface-2 text-muted ring-border",
    bad: "bg-bad-soft text-bad ring-bad/20",
    warn: "bg-warn-soft text-warn ring-warn/20",
    good: "bg-good-soft text-good ring-good/20",
    accent: "bg-accent-soft text-accent ring-accent/20",
  };
  return (
    <span data-testid={testId} className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${map[tone]}`}>
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** The five states a figure or a decision can be in. Each looks different and says its word (§5.8 of the release design). */
export type ProductState = "missing" | "held" | "zero" | "corrected" | "approved";

const PRODUCT_STATE: Record<ProductState, { tone: BadgeTone; word: string; icon: ReactNode }> = {
  missing: { tone: "neutral", word: "No record", icon: <CircleDashed aria-hidden className="size-3" /> },
  held: { tone: "warn", word: "Held", icon: <Lock aria-hidden className="size-3" /> },
  zero: { tone: "neutral", word: "$0.00 recorded", icon: <Minus aria-hidden className="size-3" /> },
  corrected: { tone: "good", word: "Corrected", icon: <CheckCircle2 aria-hidden className="size-3" /> },
  approved: { tone: "neutral", word: "Approved", icon: <Signature aria-hidden className="size-3" /> },
};

/**
 * A state in words, colour and icon, built on `Badge`. Amber and green are data states; blue stays
 * "you can act here", so no state is blue. `detail` adds the date or the approver.
 */
export function StateBadge({ state, detail, testId }: { state: ProductState; detail?: ReactNode; testId?: string }) {
  const s = PRODUCT_STATE[state];
  return (
    <span data-state={state} className="inline-flex">
      <Badge tone={s.tone} testId={testId}>
        {s.icon}
        {s.word}
        {detail ? <span className="font-normal">· {detail}</span> : null}
      </Badge>
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
    <th scope="col" className={`sticky top-0 whitespace-nowrap border-b border-border bg-surface-2 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-faint ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

export function Td({ children, align = "left", className = "" }: { children?: ReactNode; align?: "left" | "right"; className?: string }) {
  return <td className={`border-b border-border px-3 py-2 align-top text-sm leading-5 ${align === "right" ? "text-right tabular-nums" : ""} ${className}`}>{children}</td>;
}

/**
 * A horizontally scrollable table. Inside a padded Card it bleeds to the card edges. The scroll
 * box is a named, focusable region so keyboard users can scroll it (WCAG 2.1.1; axe
 * scrollable-region-focusable).
 */
/** Children are the table's sections (thead / tbody): TableWrap renders the <table> itself. */
export function TableWrap({ children, flush = false, minWidth = 640, label, testId }: { children: ReactNode; flush?: boolean; minWidth?: number; /** Unique on the page: names the scroll region. */ label: string; testId?: string }) {
  return (
    <div className={`${flush ? "" : "-mx-4"} overflow-x-auto`} role="region" aria-label={label} tabIndex={0}>
      <table className="w-full border-collapse [&_tbody_tr]:transition-colors [&_tbody_tr]:duration-100 [&_tbody_tr:hover]:bg-surface-2/60" style={{ minWidth }} data-testid={testId}>
        {children}
      </table>
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
      {/* Every page returns this in place of its own header, so it is the page's one h1. */}
      <h1 className="font-semibold">403 — not in your scope</h1>
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
