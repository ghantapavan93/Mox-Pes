import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { JobActions } from "@/components/integrations/JobActions";
import { Badge, Card, Forbidden, KV, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { count, dateTime } from "@/lib/format";
import { getJobDetail } from "@/lib/connectors/studio";
import { fmtDuration, jobTone } from "@/lib/connectors/views";
import { getPool, getViewer } from "@/lib/server";
import { resolveScope } from "@/lib/viewer";

type Props = { params: Promise<{ id: string }> };

export default function SyncJobPage(props: Props) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <SyncJob {...props} />
    </Suspense>
  );
}

const STATUS_TONE = (status: number | null): "good" | "warn" | "bad" | "neutral" =>
  status === null ? "bad" : status < 300 ? "good" : status === 429 ? "warn" : "bad";

async function SyncJob({ params }: Props) {
  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) notFound();
  const viewer = await getViewer();
  if (viewer.branchIds) {
    return <Forbidden message="Sync jobs span offices and credentials, so they are limited to company-wide roles." />;
  }
  const detail = await getJobDetail(getPool(), jobId, resolveScope(viewer));
  if (!detail) notFound();
  const { job, calls, audit, retries } = detail;
  const retrying = job.state === "queued" && job.lastErrorKind !== null;
  const attempts = [...new Set(calls.map((c) => c.attempt))];

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-faint">
          <Link href="/integrations" className="hover:underline">Integrations</Link> / sync job #{job.id}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {job.entity} · {detail.branchId} {detail.branchName} <span className="font-mono text-base text-muted">office {job.officeId}</span>
          </h1>
          <Badge tone={jobTone(job.state, retrying)}>{retrying ? "retrying" : job.cancelRequested && job.state === "running" ? "cancelling" : job.state}</Badge>
          <Badge tone="accent">synthetic</Badge>
        </div>
        <p className="mt-1 text-sm text-muted">
          Connector <span className="font-mono">{detail.connectorSlug}</span> · requested by {job.requestedBy} at {dateTime(job.requestedAt)}
          {job.retryOf && <> · retry of <Link href={`/integrations/jobs/${job.retryOf}`} className="text-accent hover:underline">#{job.retryOf}</Link></>}
          {retries.map((r) => (
            <span key={r.id}> · retried as <Link href={`/integrations/jobs/${r.id}`} className="text-accent hover:underline">#{r.id}</Link> ({r.state})</span>
          ))}
        </p>
      </div>

      <JobActions jobId={job.id} state={job.state} canAct={viewer.can.sync} />

      {job.lastError && (
        <div role={job.state === "failed" ? "alert" : "status"} className={`rounded-lg border p-4 text-sm ${job.state === "failed" ? "border-bad/30 bg-bad-soft text-bad" : "border-warn/30 bg-warn-soft text-warn"}`}>
          <p className="font-semibold">{job.state === "failed" ? "Failed" : retrying ? `Retrying — ${job.lastErrorKind}` : "Note"}</p>
          <p className="mt-1">{job.lastError}</p>
          {retrying && <p className="mt-1 text-xs">Next attempt {dateTime(job.nextAttemptAt)} (attempt {job.attempts + 1} of {job.maxAttempts}).</p>}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Window and progress" subtitle="Fixed on the first attempt; a retry resumes after the last committed id">
          <KV
            items={[
              ["Window (business clock)", job.windowStart && job.windowEnd ? `${dateTime(job.windowStart)} → ${dateTime(job.windowEnd)}` : "not started"],
              ["Window length", job.windowStart && job.windowEnd ? fmtDuration(job.windowEnd.getTime() - job.windowStart.getTime()) : "—"],
              ["Resume after id", job.resumeAfterId ?? "—"],
              ["Attempts", `${job.attempts} of ${job.maxAttempts}`],
              ["Started", dateTime(job.startedAt)],
              ["Finished", dateTime(job.finishedAt)],
              ["Last heartbeat", dateTime(job.heartbeatAt)],
            ]}
          />
        </Card>
        <Card title="Records" subtitle="Accumulated over every attempt">
          <KV
            items={[
              ["Ids found by search", count(job.stats.searched)],
              ["Records read", count(job.stats.fetched)],
              ["New versions stored", count(job.stats.inserted)],
              ["Duplicates absorbed", count(job.stats.duplicates)],
              ["Payload conflicts", count(job.stats.conflicts)],
              ["Projected", count(job.stats.projected)],
              ["Quarantined", job.stats.quarantined > 0 ? <span className="text-bad">{count(job.stats.quarantined)}</span> : 0],
              ["Rejected (wrong office)", job.stats.rejected > 0 ? <span className="text-bad">{count(job.stats.rejected)}</span> : 0],
              ["Requested but not returned", count(job.stats.missing)],
              ["Batches committed", count(job.stats.batches)],
            ]}
          />
        </Card>
      </div>

      <Card title="API call trace" subtitle="Every HTTP exchange, per attempt. Credentials travel in headers and are never recorded">
        {calls.length === 0 ? (
          <p className="text-sm text-muted">{job.state === "queued" ? "No calls yet — waiting for a worker." : "No API calls were made."}</p>
        ) : (
          <TableWrap>
            <thead>
              <tr><Th>Attempt</Th><Th>At</Th><Th>Call</Th><Th>Status</Th><Th align="right">ms</Th><Th align="right">Ids</Th><Th>Sample ids</Th><Th>Error</Th></tr>
            </thead>
            <tbody>
              {attempts.flatMap((attempt) =>
                calls
                  .filter((c) => c.attempt === attempt)
                  .map((c, i) => (
                    <tr key={c.id}>
                      <Td className="text-xs">{i === 0 ? `#${attempt}` : ""}</Td>
                      <Td className="whitespace-nowrap text-xs">{dateTime(c.at)}</Td>
                      <Td className="font-mono text-xs">{c.method} {c.path}</Td>
                      <Td><Badge tone={STATUS_TONE(c.status)}>{c.status ?? c.errorKind ?? "no response"}</Badge></Td>
                      <Td align="right">{count(c.ms)}</Td>
                      <Td align="right">{count(c.idCount)}</Td>
                      <Td className="font-mono text-[11px] text-muted">{c.ids.slice(0, 4).join(", ")}{c.idCount > 4 ? ", …" : ""}</Td>
                      <Td className="text-xs text-bad">{c.error ?? ""}</Td>
                    </tr>
                  )),
              )}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <Card title="Audit trail" subtitle="Every state change of this job">
        {audit.length === 0 ? (
          <p className="text-sm text-muted">No state changes recorded.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {audit.map((a) => (
              <li key={a.id} className="border-b border-dashed border-border pb-2">
                <span className="font-medium">{a.actor}</span> · <span className="font-mono text-xs">{a.action}</span>
                <div className="text-xs text-muted">{dateTime(a.at)} · {JSON.stringify(a.detail)}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
