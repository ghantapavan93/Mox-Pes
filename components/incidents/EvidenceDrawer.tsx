"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import type { ChangedLead } from "@/lib/changeguard/review";
import { Drawer } from "@/components/Drawer";
import { utcDateTime } from "@/components/customers/clientFormat";

/**
 * The two stored versions of one changed lead, compared field by field, in a drawer over the case
 * (the case stays where it was: closing returns focus to the button that opened it). Changed
 * fields first, each marked in words as well as colour; unchanged fields one click away. The
 * decision stays on the case, not in here.
 */
export function EvidenceDrawer({ lead }: { lead: ChangedLead }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="inline-flex min-h-9 items-center rounded-md border border-border bg-surface px-3 text-sm font-medium text-accent shadow-raised hover:bg-accent-soft"
        data-testid="compare-versions"
      >
        Compare stored versions<span className="sr-only"> of {lead.noun} {lead.sourceLeadId}</span>
      </button>
      <VersionsDrawer open={open} lead={lead} onClose={close} />
    </>
  );
}

function VersionsDrawer({ open, lead, onClose }: { open: boolean; lead: ChangedLead; onClose: () => void }) {
  const changed = lead.fields.filter((f) => f.changed);
  const same = lead.fields.filter((f) => !f.changed);
  const titleId = `versions-${lead.latest.rawEventId}`;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="2xl"
      testId="versions-drawer"
      title={
        <>
          {lead.noun} {lead.sourceLeadId}
        </>
      }
      subtitle={
        lead.atReleaseWithheld ? (
          <>
            Latest <span className="font-semibold text-text">{lead.branchNow}</span>. The version at release is at a branch outside your scope, so it is withheld.
          </>
        ) : lead.atRelease ? (
          <>
            At release <span className="font-semibold text-text">{lead.branchAtRelease ?? "no branch"}</span> · latest{" "}
            <span className="font-semibold text-text">{lead.branchNow}</span>
          </>
        ) : (
          <>
            First arrived after the release, at <span className="font-semibold text-text">{lead.branchNow}</span>
          </>
        )
      }
      footer={
        lead.recordHref ? (
          <>
            <Link href={lead.recordHref} className="font-medium text-accent underline">
              Open this lead&apos;s full record
            </Link>{" "}
            <span className="text-muted">(its customer journey, every stored version)</span>
          </>
        ) : undefined
      }
    >
        <table className="w-full table-fixed border-collapse text-sm" aria-describedby={`${titleId}-note`}>
          <colgroup>
            <col className="w-[30%]" />
            <col className="w-[35%]" />
            <col className="w-[35%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border align-bottom">
              <th scope="col" className="py-2 pr-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">Field</th>
              <th scope="col" className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
                At release
                <span className="block font-mono text-[11px] font-normal normal-case tracking-normal text-faint">
                  {lead.atRelease ? `raw #${lead.atRelease.rawEventId} · ${utcDateTime(lead.atRelease.receivedAt)}` : "no version yet"}
                </span>
              </th>
              <th scope="col" className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
                Latest
                <span className="block font-mono text-[11px] font-normal normal-case tracking-normal text-faint">
                  raw #{lead.latest.rawEventId} · {utcDateTime(lead.latest.receivedAt)}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {changed.map((f) => (
              <tr key={f.field} className="border-b border-border bg-warn-soft align-top" data-changed="true">
                <th scope="row" className="py-2 pr-2 text-left font-mono text-xs font-medium text-text">
                  <span className="break-all">{f.field}</span>
                  <span className="mt-0.5 block font-sans text-[11px] font-semibold text-warn">Changed</span>
                </th>
                <td className="break-all px-2 py-2 font-mono text-xs text-text">{f.before ?? <span className="text-faint">—</span>}</td>
                <td className="break-all px-2 py-2 font-mono text-xs font-semibold text-text">{f.after ?? <span className="text-faint">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {same.length > 0 && (
          <details className="rounded-md border border-border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-text">
              {same.length} unchanged {same.length === 1 ? "field" : "fields"}
            </summary>
            <table className="w-full table-fixed border-collapse text-sm">
              <colgroup>
                <col className="w-[30%]" />
                <col className="w-[70%]" />
              </colgroup>
              <tbody>
                {same.map((f) => (
                  <tr key={f.field} className="border-t border-border align-top">
                    <th scope="row" className="break-all py-1.5 pl-3 pr-2 text-left font-mono text-xs font-normal text-muted">{f.field}</th>
                    <td className="break-all px-2 py-1.5 font-mono text-xs text-text">{f.after ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
        <p id={`${titleId}-note`} className="text-xs text-muted">
          Payloads as stored, redacted at ingest: contact details are hash tokens. Mapper {lead.latest.adapterVersion}. Comparing them changes nothing.
        </p>
    </Drawer>
  );
}
