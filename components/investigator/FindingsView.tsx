"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui";
import type { InvestigationResult, Observation } from "@/lib/ai/contract";
import type { EvidenceView } from "@/lib/ai/queries";

/**
 * Findings with citations. Every observation lists the evidence ids it cites; each id is a
 * button that opens the evidence drawer, which loads the stored record behind it from
 * /api/investigations/:id/evidence (re-read through the same scoped tool). Grouped the way the
 * analyst classifies: verified findings, strong hypotheses, weak hypotheses, missing information.
 */

type Load = { state: "loading" } | { state: "ready"; view: EvidenceView } | { state: "error"; message: string };

export function FindingsView({ investigationId, result, returnedIds }: { investigationId: number; result: InvestigationResult; returnedIds: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const show = useCallback((ref: string, from: HTMLElement) => {
    returnFocus.current = from;
    setOpen(ref);
  }, []);
  const close = useCallback(() => {
    setOpen(null);
    returnFocus.current?.focus();
  }, []);

  const verified = result.observations.filter((o) => o.status === "verified");
  const strong = result.observations.filter((o) => o.status === "hypothesis" && o.strength === "strong");
  const weak = result.observations.filter((o) => o.status === "hypothesis" && o.strength !== "strong");

  return (
    <div className="space-y-5" data-testid="findings">
      <p className="text-sm leading-relaxed text-text">{result.summary}</p>
      <Group title="Verified findings" tone="good" items={verified} empty="No verified finding." onCite={show} />
      {strong.length > 0 && <Group title="Strong hypotheses" tone="accent" items={strong} onCite={show} />}
      {weak.length > 0 && <Group title="Weak hypotheses" tone="neutral" items={weak} onCite={show} />}
      {result.suspectedCause && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">Suspected cause</h3>
          <p className="mt-1 text-sm">{result.suspectedCause.text}</p>
          <Citations ids={result.suspectedCause.evidenceIds} onCite={show} />
        </section>
      )}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">Missing information</h3>
        {result.missingInformation.length === 0 ? (
          <p className="mt-1 text-sm text-muted">Nothing the tools could not answer was noted.</p>
        ) : (
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
            {result.missingInformation.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
      </section>
      {result.claims && result.claims.length > 0 && <ClaimCheck claims={result.claims} />}
      {/* Keyed by the id: picking a related record remounts the drawer in its loading state. */}
      {open && <EvidenceDrawer key={open} investigationId={investigationId} evidenceId={open} returned={returnedIds} onClose={close} onPick={setOpen} />}
    </div>
  );
}

const STATUS_TONE = { SUPPORTED: "good", PARTIALLY_SUPPORTED: "accent", CONFLICTED: "bad", UNSUPPORTED: "bad", NOT_DETERMINABLE: "neutral" } as const;
const STATUS_LABEL = { SUPPORTED: "supported", PARTIALLY_SUPPORTED: "partly supported", CONFLICTED: "conflicted", UNSUPPORTED: "unsupported", NOT_DETERMINABLE: "not determinable" } as const;

/**
 * The claim check, decided outside the model (lib/ai/analyst.ts): every statement, its type,
 * whether its evidence and each figure it states were found in this run's tool outputs, and
 * why anything was rejected. Collapsed to one line of counts by default.
 */
function ClaimCheck({ claims }: { claims: NonNullable<InvestigationResult["claims"]> }) {
  const tally = (s: keyof typeof STATUS_TONE) => claims.filter((c) => c.status === s).length;
  return (
    <section data-testid="claim-check">
      <details>
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-faint">
          Claim check · {tally("SUPPORTED")} supported · {tally("PARTIALLY_SUPPORTED")} partly · {tally("UNSUPPORTED") + tally("CONFLICTED")} rejected or conflicted · {tally("NOT_DETERMINABLE")} not determinable
        </summary>
        <p className="mt-2 text-xs text-muted">
          Checked by code, not by the model. Every cited id must have been returned by a tool in this run. Every figure must follow from the facts the claim cites: the right metric, branch or channel, period, direction, arithmetic and unit, and money whose currency is established. A number that merely appears in a tool&apos;s output proves nothing. A cause of a business outcome is never accepted without a measured experiment. Open a claim&apos;s proof to see each calculation and the facts it used.
        </p>
        <ul className="mt-2 space-y-2 text-sm">
          {claims.map((c) => (
            <li key={c.id} className="rounded border border-border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                <span className="text-[11px] uppercase tracking-wide text-faint">{c.type.toLowerCase()}</span>
                {c.origin && <span className="text-[11px] text-faint">{c.origin === "template" ? "written from a calculation" : "model-written"}</span>}
                {c.numbers.map((n, i) => (
                  <span key={`${i}-${n.text}`} className={`font-mono text-[11px] ${n.supported ? "text-good" : "text-bad"}`}>
                    {n.supported ? "✓" : "✗"} {n.text}
                  </span>
                ))}
              </div>
              <p className={`mt-1 break-words ${c.status === "UNSUPPORTED" ? "text-muted line-through decoration-bad/50" : ""}`}>{c.text}</p>
              <p className="mt-0.5 text-xs text-muted">{c.reason}</p>
              {c.proofs && c.proofs.length > 0 && <ProofList proofs={c.proofs} />}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

type ProofItem = NonNullable<NonNullable<InvestigationResult["claims"]>[number]["proofs"]>[number];

const VERDICT = { VERIFIED: { mark: "✓", tone: "text-good", label: "follows" }, CONTRADICTED: { mark: "✗", tone: "text-bad", label: "contradicted" }, UNRESOLVED: { mark: "?", tone: "text-muted", label: "not proved" } } as const;

/** A fact's value as a reader would write it: dollars, percent or a count. */
function factValue(value: number | null, unit: ProofItem["inputs"][number]["unit"]): string {
  if (value === null) return "n/a";
  if (unit === "usd_cents") return `${value < 0 ? "−" : ""}$${(Math.abs(value) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (unit === "ratio") return `${(value * 100).toFixed(1)}%`;
  return value.toLocaleString("en-US");
}

/**
 * The proof of a claim, one line per proposition (level 3), each opening to the facts it used
 * with their definition version, currency status, tool and evidence ids (level 4).
 */
function ProofList({ proofs }: { proofs: ProofItem[] }) {
  const verified = proofs.filter((p) => p.verdict === "VERIFIED").length;
  return (
    <details className="mt-1" data-testid="claim-proof">
      <summary className="cursor-pointer text-xs text-faint">
        Proof · {verified} of {proofs.length} proposition{proofs.length === 1 ? "" : "s"} follow{verified === 1 ? "s" : ""}
      </summary>
      <ol className="mt-1 space-y-1">
        {proofs.map((p, i) => {
          const v = VERDICT[p.verdict];
          return (
            <li key={i} className="rounded bg-surface-2 px-2 py-1 text-xs">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={`font-mono ${v.tone}`} aria-label={v.label}>
                  {v.mark}
                </span>
                {p.figure && <span className="font-mono">{p.figure}</span>}
                <span className="text-faint">{p.relation.replace(/_/g, " ")}</span>
                {p.formula && <code className="break-all text-[11px] text-muted">{p.formula}</code>}
                {p.computed !== null && p.relation !== "status" && p.relation !== "membership" && <span className="text-muted">= {Number.isInteger(p.computed) ? p.computed : p.computed.toFixed(2)}</span>}
              </div>
              <p className="text-muted">
                {v.label}: {p.reason}
                {p.qualifier !== "exact" ? ` (${p.rounding})` : ""}
              </p>
              {p.inputs.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-faint">Facts used ({p.inputs.length})</summary>
                  <ul className="mt-0.5 space-y-0.5">
                    {p.inputs.map((f, j) => (
                      <li key={j} className="break-words text-muted">
                        <span className="font-mono">{f.metric}</span> · {f.entity} · {f.period} = <span className="font-mono">{factValue(f.value, f.unit)}</span>
                        {f.unit === "usd_cents" && !f.currencyResolved ? " · currency not established" : ""}
                        {f.incompleteReason ? ` · incomplete: ${f.incompleteReason}` : ""}
                        {f.definitionVersion ? ` · definition ${f.definitionVersion.split(" ")[0]}` : ""} · from {f.tool} · <span className="font-mono">{f.evidenceIds.slice(0, 2).join(", ")}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function Group({
  title,
  tone,
  items,
  empty,
  onCite,
}: {
  title: string;
  tone: "good" | "accent" | "neutral";
  items: Observation[];
  empty?: string;
  onCite: (ref: string, from: HTMLElement) => void;
}) {
  return (
    <section>
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-faint">
        {title} <Badge tone={tone}>{items.length}</Badge>
      </h3>
      {items.length === 0 ? (
        <p className="mt-1 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-3">
          {items.map((o, i) => (
            <li key={`${i}-${o.text.slice(0, 20)}`} className="border-l-2 border-border pl-3">
              <p className="text-sm">{o.text}</p>
              <Citations ids={o.evidenceIds} onCite={onCite} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Citations({ ids, onCite }: { ids: string[]; onCite: (ref: string, from: HTMLElement) => void }) {
  return (
    <p className="mt-1 flex flex-wrap gap-1" aria-label="Evidence">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          onClick={(e) => onCite(id, e.currentTarget)}
          className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-accent hover:border-accent focus:outline-none focus:ring-2 focus:ring-accent"
          data-testid="citation"
        >
          {id}
        </button>
      ))}
    </p>
  );
}

function EvidenceDrawer({
  investigationId,
  evidenceId,
  returned,
  onClose,
  onPick,
}: {
  investigationId: number;
  evidenceId: string;
  /** Evidence ids this investigation's tools returned: the only ones the API will serve. */
  returned: string[];
  onClose: () => void;
  onPick: (ref: string) => void;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/investigations/${investigationId}/evidence?ref=${encodeURIComponent(evidenceId)}`, { signal: controller.signal })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setLoad({ state: "ready", view: body as EvidenceView });
      })
      .catch((error: Error) => {
        if (error.name !== "AbortError") setLoad({ state: "error", message: error.message });
      });
    return () => controller.abort();
  }, [investigationId, evidenceId]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-text/30" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="evidence-drawer-title"
        className="flex h-full w-full max-w-xl flex-col border-l border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 id="evidence-drawer-title" className="text-sm font-semibold">
              Evidence · {load.state === "ready" ? load.view.title : evidenceId}
            </h2>
            <p className="mt-0.5 font-mono text-[11px] text-muted">{evidenceId}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-2">
            Close <span className="text-faint">Esc</span>
          </button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm" aria-live="polite">
          {load.state === "loading" && (
            <div className="animate-pulse space-y-2" aria-busy="true" aria-label="Loading evidence">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="h-5 rounded bg-surface-2" />
              ))}
            </div>
          )}
          {load.state === "error" && (
            <p role="alert" className="rounded bg-bad-soft p-2 text-bad">
              Could not load this evidence: {load.message}
            </p>
          )}
          {load.state === "ready" && <EvidenceBody view={load.view} returned={returned} onPick={onPick} />}
        </div>
      </aside>
    </div>
  );
}

/** Evidence ids that appear inside a record (e.g. a raw event's other versions) are clickable too. */
const NESTED_ID = /^(raw_event|exception|campaign|lead|customer):\d+$/;

function EvidenceBody({ view, returned, onPick }: { view: EvidenceView; returned: string[]; onPick: (ref: string) => void }) {
  const json = JSON.stringify(view.record, null, 2);
  const related = relatedIds(view.record).filter((id) => id !== view.evidenceId && returned.includes(id)).slice(0, 12);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={view.source === "live" ? "good" : "neutral"}>{view.source === "live" ? "re-read now, in your scope" : "as the tool returned it"}</Badge>
        {view.href && (
          <Link href={view.href} className="text-accent hover:underline">
            Open in the product
          </Link>
        )}
      </div>
      <div>
        <p className="text-xs font-medium text-muted">Returned by</p>
        <ul className="mt-1 space-y-1 text-xs">
          {view.returnedBy.map((r) => (
            <li key={r.seq}>
              <span className="font-mono text-faint">#{r.seq}</span> <span className="font-mono">{r.tool ?? "—"}</span> — {r.summary}
            </li>
          ))}
        </ul>
      </div>
      {related.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted">Related records in this evidence</p>
          <p className="mt-1 flex flex-wrap gap-1">
            {related.map((id) => (
              <button key={id} type="button" onClick={() => onPick(id)} className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-accent hover:border-accent">
                {id}
              </button>
            ))}
          </p>
        </div>
      )}
      <div>
        <p className="text-xs font-medium text-muted">Stored record (contact details are hash tokens; free text is third-party data)</p>
        <pre role="region" aria-label="Tool output" tabIndex={0} className="mt-1 max-h-[60vh] overflow-auto rounded bg-surface-2 p-3 font-mono text-[11px] leading-snug">{json}</pre>
      </div>
    </>
  );
}

/**
 * Record ids mentioned inside a record (other versions, lineage, the credited lead). The caller
 * offers only those this investigation returned — the only ones the API serves.
 */
function relatedIds(record: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 5 || found.size > 40) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key, depth + 1));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, depth + 1);
      return;
    }
    if (typeof v === "number" && Number.isInteger(v)) {
      const kind = key === "rawEventId" || key === "latestRawEventId" ? "raw_event" : key === "campaignId" ? "campaign" : key === "leadId" || key === "creditedLeadId" ? "lead" : key === "customerId" ? "customer" : key === "exceptionId" ? "exception" : null;
      if (kind) found.add(`${kind}:${v}`);
    }
  };
  walk(record, "", 0);
  return [...found].filter((id) => NESTED_ID.test(id));
}
