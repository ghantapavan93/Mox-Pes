"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui";
import { usd, utcDateTime } from "./clientFormat";
import type { RawEventView, TimelineItem } from "@/lib/identity/journey";
import { RULE_LABEL } from "@/lib/identity/types";

const KIND_LABEL: Record<TimelineItem["kind"], string> = {
  lead: "Lead",
  customer_created: "CRM",
  subscription_sold: "Sold",
  subscription_cancelled: "Cancelled",
  appointment: "Service",
  ticket: "Invoice",
  payment: "Payment",
  refund: "Refund",
};

const SOURCE_LABEL: Record<string, string> = { crm: "CRM", calls: "Calls", web: "Web", d2d: "D2D" };

/**
 * The single chronological timeline. Every row names its projection table, row id and raw
 * event; "Source" opens a drawer with the stored (redacted) payload and its mapper version,
 * fetched on demand so the page does not ship every payload up front.
 */
export function JourneyTimeline({ items, journeyId }: { items: TimelineItem[]; journeyId: string }) {
  const [open, setOpen] = useState<TimelineItem | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen(null);
    returnFocus.current?.focus();
  }, []);

  if (items.length === 0) return <p className="text-sm text-muted">No source records are attached to this identity yet.</p>;

  return (
    <>
      <ol className="relative space-y-0 border-l border-border pl-0" data-testid="journey-timeline">
        {items.map((item) => (
          <li key={item.key} className={`grid grid-cols-[7.5rem_1fr_auto] items-start gap-3 border-b border-border py-2 pl-4 text-sm last:border-b-0 ${item.credited ? "bg-accent-soft" : ""}`}>
            <time dateTime={item.at} className="pt-0.5 text-xs tabular-nums text-muted">{utcDateTime(item.at)}</time>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={item.tone}>{KIND_LABEL[item.kind]}</Badge>
                <span className="font-medium text-text">{item.title}</span>
                {item.credited && <Badge tone="accent">credited touch</Badge>}
              </div>
              <p className="mt-0.5 text-xs text-muted">{item.detail}</p>
              <p className="mt-0.5 font-mono text-[10px] text-faint">
                {SOURCE_LABEL[item.source]} {item.sourceRecordId} · {item.sourceTable}#{item.sourceId}
                {item.linkRule ? ` · identity rule: ${RULE_LABEL[item.linkRule]}` : ""}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              {item.amountCents !== null && (
                <span className={`tabular-nums ${item.amountCents < 0 ? "text-warn" : item.kind === "ticket" || item.kind === "subscription_sold" ? "text-muted" : "text-text"}`}>
                  {usd(item.amountCents)}
                </span>
              )}
              <button
                type="button"
                onClick={(e) => {
                  returnFocus.current = e.currentTarget;
                  setOpen(item);
                }}
                className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-accent hover:bg-surface-2"
                aria-label={`Show source payload for ${KIND_LABEL[item.kind]} ${item.sourceRecordId} (raw event ${item.rawEventId})`}
              >
                raw #{item.rawEventId} · {item.adapterVersion}
              </button>
            </div>
          </li>
        ))}
      </ol>
      {open && <SourceDrawer item={open} journeyId={journeyId} onClose={close} />}
    </>
  );
}

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; raw: RawEventView };

function SourceDrawer({ item, journeyId, onClose }: { item: TimelineItem; journeyId: string; onClose: () => void }) {
  const [rawEventId, setRawEventId] = useState(item.rawEventId);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/customers/${encodeURIComponent(journeyId)}/raw-events/${rawEventId}`, { signal: controller.signal })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setLoad({ state: "ready", raw: body as RawEventView });
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setLoad({ state: "error", message: e.message });
      });
    return () => controller.abort();
  }, [journeyId, rawEventId]);

  const pick = (id: number) => {
    setLoad({ state: "loading" });
    setRawEventId(id);
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-text/30" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-drawer-title"
        className="flex h-full w-full max-w-xl flex-col border-l border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 id="source-drawer-title" className="text-sm font-semibold">
              Source record · {item.title}
            </h2>
            <p className="mt-0.5 font-mono text-[11px] text-muted">
              {item.sourceTable}#{item.sourceId} · {SOURCE_LABEL[item.source]} id {item.sourceRecordId}
            </p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-2">
            Close <span className="text-faint">Esc</span>
          </button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm" aria-live="polite">
          {load.state === "loading" && (
            <div className="animate-pulse space-y-2" aria-busy="true" aria-label="Loading source payload">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="h-5 rounded bg-surface-2" />
              ))}
            </div>
          )}
          {load.state === "error" && <p role="alert" className="rounded bg-bad-soft p-2 text-bad">Could not load the payload: {load.message}</p>}
          {load.state === "ready" && <RawEventDetail raw={load.raw} onPick={pick} />}
        </div>
      </aside>
    </div>
  );
}

function RawEventDetail({ raw, onPick }: { raw: RawEventView; onPick: (id: number) => void }) {
  const rows: Array<[string, string]> = [
    ["Raw event", `#${raw.id}`],
    ["Source / entity", `${raw.source} / ${raw.entity} ${raw.entityId}`],
    ["Mapper version", raw.adapterVersion],
    ["Status", raw.errorCode ? `${raw.status} · ${raw.errorCode}` : raw.status],
    ["Source time", utcDateTime(raw.occurredAt)],
    ["Received (our clock)", utcDateTime(raw.receivedAt)],
    ["Projected", raw.projectedAt ? utcDateTime(raw.projectedAt) : "not projected"],
    ["Deliveries absorbed", String(raw.deliveryCount)],
  ];
  return (
    <>
      <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="font-mono">{v}</dd>
          </div>
        ))}
      </dl>
      {raw.errorDetail && <p className="rounded bg-warn-soft p-2 text-xs text-warn">{raw.errorDetail}</p>}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">Stored versions of this record ({raw.versions.length})</h3>
        <ul className="mt-1 space-y-1">
          {raw.versions.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => onPick(v.id)}
                aria-current={v.id === raw.id ? "true" : undefined}
                className={`flex w-full flex-wrap items-center gap-2 rounded border px-2 py-1 text-left font-mono text-[11px] ${v.id === raw.id ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2"}`}
              >
                <span>#{v.id}</span>
                <span className="text-muted">{utcDateTime(v.receivedAt)}</span>
                <span>{v.adapterVersion}</span>
                <Badge tone={v.status === "quarantined" ? "bad" : "good"}>{v.status}</Badge>
                {v.current && <Badge tone="accent">current projection</Badge>}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">Payload as stored (redacted at ingest)</h3>
        <pre className="mt-1 max-h-[50vh] overflow-auto rounded bg-surface-2 p-3 text-[11px] leading-relaxed">{JSON.stringify(raw.payload, null, 2)}</pre>
        <p className="mt-1 text-[11px] text-faint">Contact details were replaced by hash tokens (h:phone:…, h:email:…) before the payload was stored.</p>
      </div>
    </>
  );
}
