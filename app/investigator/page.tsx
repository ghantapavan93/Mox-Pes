import Link from "next/link";
import { Suspense } from "react";
import { InvestigateForm } from "@/components/investigator/InvestigateForm";
import { OpenInquiry } from "@/components/investigator/OpenInquiry";
import { ModeBadge } from "@/components/investigator/TraceTable";
import { Badge, Callout, Card, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { MODE_LABEL, modelModeLabel } from "@/lib/ai/contract";
import { configuredProfile, type ModelProfile } from "@/lib/ai/model";
import { listInvestigations, suggestedQuestions } from "@/lib/ai/queries";
import { dateTime } from "@/lib/format";
import { listInquiries } from "@/lib/inquiry/store";
import { getException } from "@/lib/queries";
import { BRANCHES } from "@/lib/reference";
import { demoModeEnabled } from "@/lib/demo-mode";
import { tourPlace, tourQuery } from "@/lib/demo/b20-tour";
import { getPool, getViewer } from "@/lib/server";
import { canSeeBranch, type Viewer } from "@/lib/viewer";
import { availabilitySentence, deleteExpiredWorkspace } from "@/lib/workspace";

/** The configured model, or null; a misconfigured one (a refused Ollama host) reads as none here and fails loudly on the run. */
function modelProfile(): ModelProfile | null {
  try {
    return configuredProfile();
  } catch {
    return null;
  }
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export const metadata = { title: "AI Investigator" };

export default function InvestigatorPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operate · reads data, never applies changes"
        title="AI Investigator"
        description={
          <p className="max-w-3xl">
            Ask why a number looks wrong. The investigator reads stored records through a fixed set of read-only tools, with your role and branch scope,
            cites the evidence behind every finding, and proposes fixes to the Action Center, where a person dry-runs them and a different role approves.
          </p>
        }
      />
      <Suspense fallback={<Skeleton lines={8} />}>
        <Investigator searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Investigator({ searchParams }: { searchParams: SearchParams }) {
  const [sp, viewer] = await Promise.all([searchParams, getViewer()]);
  const pool = getPool();
  await deleteExpiredWorkspace(pool);
  // A workspace guest asks on the deterministic evidence path only (release design §5.9).
  const workspace = !viewer.can.investigate && viewer.can.workspace;
  const profile = workspace ? null : modelProfile();
  const mode = profile ? "model" : "deterministic";
  const canAsk = viewer.can.investigate || workspace;
  const suggestions = canAsk ? await suggestedQuestions(pool, viewer) : [];

  // Entry point from the Action Center: /investigator?exception=<id> pre-fills the question.
  let initialQuestion = (one(sp.q) ?? "").slice(0, 2000);
  let initialBranch: string | null = null;
  let incident: { id: number; branchId: string | null; summary: string } | null = null;
  const exceptionParam = one(sp.exception);
  if (exceptionParam && /^\d{1,12}$/.test(exceptionParam)) {
    const exception = await getException(pool, Number(exceptionParam));
    if (exception && canSeeBranch(viewer, exception.branchId)) {
      initialQuestion = `Investigate exception #${exception.id}: ${exception.summary}`;
      initialBranch = exception.branchId;
      incident = { id: exception.id, branchId: exception.branchId, summary: exception.summary };
    }
  }
  const branchParam = one(sp.branch);
  if (!initialBranch && branchParam && /^B\d{2}$/.test(branchParam) && canSeeBranch(viewer, branchParam)) initialBranch = branchParam;

  const branches = BRANCHES.filter((b) => canSeeBranch(viewer, b.id)).map((b) => ({ id: b.id, label: `${b.id} ${b.name}` }));
  // On the visitor tour (lib/demo/b20-tour.ts) the answer opens on the tour's same step, bar and all.
  const tour = tourPlace({ guide: one(sp.guide), step: one(sp.step), incident: one(sp.incident) });
  return (
    <div className="space-y-4">
      {workspace ? (
        <Callout title="Your questions on the public demo" testId="investigator-mode-note">
          Answered by the deterministic evidence path: fixed, rule-based plans over the same read-only tools, with every finding citing a record. No model reads
          your question or the records, and nothing is changed or proposed. Only your browser can open your investigations; each lasts{" "}
          24 hours, and you can delete it sooner.
        </Callout>
      ) : (
        mode === "deterministic" && (
          <Callout tone="warn" title="Deterministic investigator: no model is configured" testId="investigator-mode-note">
            No model is configured. Investigations run on fixed, rule-based tool plans over the same tools and are labelled as such; nothing here is generated
            by a model.
          </Callout>
        )
      )}
      {incident && (
        <div data-testid="investigation-scope">
          <Callout tone="info" title={`Scoped to incident #${incident.id}${incident.branchId ? ` at ${incident.branchId}` : ""}`}>
            The question below is pre-filled from{" "}
            <Link href={`/exceptions/${incident.id}`} className="font-medium text-accent hover:underline">
              incident #{incident.id}
            </Link>
            ; press Investigate to run the tools.
          </Callout>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-5">
        <Card
          className="lg:col-span-3"
          title="Ask"
          subtitle={viewer.label}
          action={<ModeBadge mode={mode} label={profile ? modelModeLabel(profile) : MODE_LABEL.deterministic} />}
        >
          <InvestigateForm
            key={`${initialQuestion}|${initialBranch ?? ""}`}
            branches={branches}
            suggestions={suggestions}
            initialQuestion={initialQuestion}
            initialBranch={initialBranch}
            resultQuery={tour ? tourQuery(tour.step.n, tour.incidentId) : ""}
            canInvestigate={canAsk}
            help={workspace ? "Reads the stored records with the same read-only tools and cites each one. On the public demo it answers by the deterministic evidence path and drafts no fix." : undefined}
            denyReason={
              demoModeEnabled()
                ? `${viewer.label} cannot run investigations. Switch role in the header (any role except guest can).`
                : `${viewer.label} cannot run investigations on this deployment.`
            }
          />
        </Card>
        <Card className="lg:col-span-2" title="Recent investigations" subtitle="Visible in your scope; open one for its tool trace, citations and proposals" flush>
          <Suspense fallback={<Skeleton lines={5} />}>
            <Recent viewer={viewer} />
          </Suspense>
        </Card>
      </div>
      {viewer.can.investigate && (
        <Card title="Investigation workspaces" subtitle="A question kept open: six competing explanations tested against the records, each with its evidence, counterevidence and what would change it. Re-test as records arrive.">
          <div className="space-y-3">
            <OpenInquiry branches={branches} initial={initialBranch ?? undefined} />
            <Suspense fallback={<Skeleton lines={3} />}>
              <Workspaces viewer={viewer} />
            </Suspense>
          </div>
        </Card>
      )}
    </div>
  );
}

async function Workspaces({ viewer }: { viewer: Viewer }) {
  const rows = await listInquiries(getPool(), viewer);
  if (rows.length === 0) return <p className="text-sm text-muted">No open workspaces yet.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {rows.slice(0, 10).map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-2">
          <Link href={`/investigator/inquiries/${r.id}`} className="font-medium text-accent hover:underline">
            {r.question}
          </Link>
          <Badge tone={r.conclusion === "explained" ? "good" : r.conclusion === "unexplained" ? "bad" : "neutral"}>{r.conclusion.replace("_", " ")}</Badge>
          <span className="text-xs text-faint">
            v{r.version} · {dateTime(r.testedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

async function Recent({ viewer }: { viewer: Viewer }) {
  const rows = await listInvestigations(getPool(), viewer, 15);
  if (rows.length === 0)
    return (
      <div className="p-4">
        <EmptyState title="No investigations yet in your scope.">Ask the first question.</EmptyState>
      </div>
    );
  return (
    <ul className="divide-y divide-border" data-testid="recent-investigations">
      {rows.map((r) => (
        <li key={r.id} className="px-4 py-3 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <Link href={`/investigator/${r.id}`} className="min-w-0 font-medium text-accent hover:underline">
              #{r.id} <span className="text-text">{r.question.length > 90 ? `${r.question.slice(0, 90)}…` : r.question}</span>
            </Link>
            <span className="shrink-0 whitespace-nowrap text-xs text-muted">{dateTime(r.createdAt)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted">
              {r.workspaceStartedAt ? "yours" : r.actor} · {r.mode}
              {r.branchId ? ` · ${r.branchId}` : ""}
              {r.workspaceStartedAt ? ` · ${availabilitySentence(r.workspaceStartedAt)}` : ""}
            </span>
            {r.status === "completed" ? (
              <>
                <Badge tone={r.confidence === "high" ? "good" : r.confidence === "medium" ? "accent" : "neutral"}>{r.confidence ?? "—"} confidence</Badge>
                {r.proposals > 0 && <Badge tone="accent">{r.proposals} proposal(s)</Badge>}
                {r.claimsDropped > 0 && <Badge tone="warn">{r.claimsDropped} dropped</Badge>}
              </>
            ) : (
              <Badge tone={r.status === "failed" ? "bad" : "accent"}>{r.status}</Badge>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
