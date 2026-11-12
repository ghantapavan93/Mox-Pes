import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { InquiryActions } from "@/components/investigator/InquiryActions";
import { Badge, Callout, Card, PageHeader, Skeleton } from "@/components/ui";
import { dateTime } from "@/lib/format";
import type { HypothesisResult, HypothesisStatus } from "@/lib/inquiry/cac-change";
import { getInquiry } from "@/lib/inquiry/store";
import { getPool, getViewer } from "@/lib/server";

const TONE: Record<HypothesisStatus, "good" | "bad" | "warn" | "neutral"> = { SUPPORTED: "good", CONTRADICTED: "bad", UNRESOLVED: "warn", NOT_TESTABLE: "neutral" };
const CONCLUSION: Record<string, { tone: "good" | "warn" | "neutral" | "bad"; label: string }> = {
  explained: { tone: "good", label: "explained" },
  partly_explained: { tone: "warn", label: "partly explained" },
  unexplained: { tone: "bad", label: "not explained" },
  premise_false: { tone: "neutral", label: "premise does not hold" },
  not_testable: { tone: "neutral", label: "not testable" },
};

export default function InquiryPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <Workspace params={params} />
    </Suspense>
  );
}

/**
 * An investigation workspace (lib/inquiry): the question, the conclusion first, then the six
 * hypotheses with their verdicts; each opens to how it was tested, the evidence, the
 * counterevidence searched for, and what would change it. Re-testing keeps the old version.
 */
async function Workspace({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = Number(id);
  const viewer = await getViewer();
  const inquiry = Number.isInteger(n) && n > 0 ? await getInquiry(getPool(), viewer, n) : null;
  if (!inquiry) notFound();
  const r = inquiry.result;
  const c = CONCLUSION[r.conclusion.status] ?? CONCLUSION.not_testable;
  const before = new Map((inquiry.previous ?? []).map((p) => [p.code, p.status]));
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`Investigation workspace · ${inquiry.branchId} · version ${inquiry.version}`}
        title={inquiry.question}
        description={<p className="max-w-3xl text-sm">Six hypotheses, tested by code against the stored records, September against October. Re-test when new records arrive; every version is kept.</p>}
      />
      <Card title="Conclusion" action={<Badge tone={c.tone}>{c.label}</Badge>}>
        <p className="text-sm" data-testid="inquiry-conclusion">
          {r.conclusion.text}
        </p>
        {r.decomposition && (
          <p className="mt-2 text-xs text-muted">
            On a log scale, about {(r.decomposition.spendShare * 100).toFixed(0)}% of the CAC change comes from spend and {(r.decomposition.customerShare * 100).toFixed(0)}% from paid customers (CAC = spend ÷ paid customers).
          </p>
        )}
        <p className="mt-2 text-xs text-faint">
          Tested {dateTime(inquiry.testedAt)} by {inquiry.testedBy} · {r.reads} bounded reads in one snapshot · definition {r.definitionVersion.split(" ")[0]}
        </p>
      </Card>

      <Card title="Hypotheses" subtitle="Each verdict opens to its test, its evidence, the counterevidence searched for, and what would change it.">
        <ul className="space-y-2" data-testid="inquiry-hypotheses">
          {r.hypotheses.map((h) => (
            <Hypothesis key={h.code} h={h} before={before.get(h.code) ?? null} />
          ))}
        </ul>
      </Card>

      <Card title="What would change the conclusion">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {r.whatWouldChange.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </Card>

      <Card title="Notes and re-tests">
        {inquiry.notes.length > 0 && (
          <ul className="mb-3 space-y-1 text-sm">
            {inquiry.notes.map((note) => (
              <li key={note.id} className="break-words">
                <span className="text-xs text-faint">
                  {dateTime(note.at)} · {note.author}
                </span>{" "}
                {note.text}
              </li>
            ))}
          </ul>
        )}
        <InquiryActions id={inquiry.id} canAct={viewer.can.investigate} />
      </Card>

      <Callout tone="info" title="What this is and is not">
        Every verdict is computed from stored records by fixed rules shown with it. A supported hypothesis says the records are consistent with it; it is not a measured cause. Attribution credits customers to channels; only an experiment measures what spend caused.{" "}
        <Link className="underline" href={`/branches/${inquiry.branchId}/trace`}>
          Open the paid-CAC trace
        </Link>
        .
      </Callout>
    </div>
  );
}

function Hypothesis({ h, before }: { h: HypothesisResult; before: string | null }) {
  return (
    <li className="rounded border border-border p-2 text-sm">
      <details>
        <summary className="flex cursor-pointer flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-faint">{h.code}</span>
          <Badge tone={TONE[h.status]}>{h.status.toLowerCase().replace("_", " ")}</Badge>
          {before && before !== h.status && <span className="text-xs text-accent">was {before.toLowerCase().replace("_", " ")}</span>}
          <span className="font-medium">{h.statement}</span>
        </summary>
        <div className="mt-2 space-y-2">
          <p>{h.summary}</p>
          <p className="text-xs text-muted">
            <span className="font-semibold">Test:</span> {h.test}
          </p>
          {h.evidence.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted">Evidence</p>
              <ul className="text-xs">
                {h.evidence.map((e, i) => (
                  <li key={i} className="break-words">
                    {e.label}: {e.value} <span className="font-mono text-faint">{e.evidenceIds.slice(0, 3).join(" ")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className="text-xs font-semibold text-muted">Counterevidence searched for</p>
            {h.counterevidence.length === 0 ? (
              <p className="text-xs text-muted">None found.</p>
            ) : (
              <ul className="text-xs">
                {h.counterevidence.map((e, i) => (
                  <li key={i} className="break-words">
                    {e.label}: {e.value}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-xs text-muted">
            <span className="font-semibold">Would change it:</span> {h.wouldChange}
          </p>
        </div>
      </details>
    </li>
  );
}
