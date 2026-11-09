"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, TableWrap, Td, Th } from "@/components/ui";
import { ACTIVE_STATES, JOBS_CHANGED_EVENT, fmtTime, jobTone, type JobView } from "@/lib/connectors/views";

const POLL_MS = 2_000;

/**
 * The jobs table, live. Polls while any job is queued or running (or right after a control
 * says jobs changed), stops when everything is terminal, and refreshes the server-rendered
 * cards once when activity ends so health, checkpoints and the office grid catch up.
 */
export function JobsLive({ connectorId, initialJobs, officeLabels }: { connectorId: number; initialJobs: JobView[]; officeLabels: Record<number, string> }) {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobView[]>(initialJobs);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(() => initialJobs.some((j) => ACTIVE_STATES.includes(j.state)));
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const wasActive = useRef(polling);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/connectors/${connectorId}/jobs?limit=40`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const next = body.jobs as JobView[];
      setJobs(next);
      setError(null);
      setUpdatedAt(new Date().toISOString());
      const active = next.some((j) => ACTIVE_STATES.includes(j.state));
      if (wasActive.current && !active) router.refresh();
      wasActive.current = active;
      setPolling(active);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [connectorId, router]);

  useEffect(() => {
    const onChange = () => {
      wasActive.current = true;
      setPolling(true);
      void load();
    };
    window.addEventListener(JOBS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(JOBS_CHANGED_EVENT, onChange);
  }, [load]);

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, load]);

  return (
    <div className="space-y-2" data-testid="jobs-live">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted" aria-live="polite">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${polling ? "animate-pulse bg-accent" : "bg-border"}`} />
          {polling ? "Live — refreshing every 2 s" : "Idle — nothing queued or running"}
        </span>
        {updatedAt && <span>Updated {fmtTime(updatedAt)}</span>}
        <button type="button" onClick={() => void load()} className="text-accent hover:underline">Refresh now</button>
      </div>
      {error && <p role="alert" className="text-xs text-bad">Could not refresh jobs: {error}</p>}
      {jobs.length === 0 ? (
        <p className="text-sm text-muted">No sync jobs yet. Run a sync to queue one per office and entity.</p>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>Job</Th><Th>Office</Th><Th>Entity</Th><Th>State</Th><Th align="right">Attempt</Th><Th align="right">Read</Th>
              <Th align="right">Changed</Th><Th align="right">Dupes</Th><Th align="right">Quarantined</Th><Th>Detail</Th><Th>Requested</Th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const retrying = j.state === "queued" && j.lastErrorKind !== null;
              return (
                <tr key={j.id}>
                  <Td className="font-mono text-xs">
                    <Link href={`/integrations/jobs/${j.id}`} className="text-accent hover:underline">#{j.id}</Link>
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{officeLabels[j.officeId] ?? j.officeId}</Td>
                  <Td className="font-mono text-xs">{j.entity}</Td>
                  <Td>
                    <Badge tone={jobTone(j.state, retrying)}>
                      {retrying ? "retrying" : j.cancelRequested && j.state === "running" ? "cancelling" : j.state}
                    </Badge>
                  </Td>
                  <Td align="right">{j.attempts}/{j.maxAttempts}</Td>
                  <Td align="right">{j.stats.fetched.toLocaleString("en-US")}</Td>
                  <Td align="right">{j.stats.inserted.toLocaleString("en-US")}</Td>
                  <Td align="right">{j.stats.duplicates.toLocaleString("en-US")}</Td>
                  <Td align="right" className={j.stats.quarantined > 0 ? "text-bad" : ""}>{j.stats.quarantined}</Td>
                  <Td className="max-w-[22rem] text-xs">
                    {retrying ? (
                      <span className="text-warn">{j.lastErrorKind}: next attempt {fmtTime(j.nextAttemptAt)}</span>
                    ) : j.lastError ? (
                      <span className={j.state === "failed" ? "text-bad" : "text-muted"} title={j.lastError}>
                        {j.lastError.length > 110 ? `${j.lastError.slice(0, 110)}…` : j.lastError}
                      </span>
                    ) : j.retryOf ? (
                      <span className="text-muted">retry of #{j.retryOf}</span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-muted">{fmtTime(j.requestedAt)}</Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
