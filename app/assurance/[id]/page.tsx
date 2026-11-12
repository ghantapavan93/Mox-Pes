import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { VerdictBadge } from "@/components/shadow/VerdictBadge";
import { ButtonLink, Callout, Card, KV, PageHeader, Skeleton } from "@/components/ui";
import { dateTime } from "@/lib/format";
import { exactDollars } from "@/lib/lineage/trace";
import { getPool, getViewer } from "@/lib/server";
import type { AnswerCheck, AnswerInput } from "@/lib/shadow/answer";
import type { Snapshot, SnapshotCheck } from "@/lib/shadow/snapshot";
import { getShadowCheck, type ShadowCheckRow } from "@/lib/shadow/store";

export const metadata = { title: "Check result" };

export default function ShadowCheckPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <Result params={params} />
    </Suspense>
  );
}

/**
 * One recorded check: the other system's figure or answer as it was entered, beside what the
 * product's evidence says. The conclusion first, then what disagrees, then the proof, then the
 * next step (docs/agent-work/SHADOW-MODE.md).
 */
async function Result({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = Number(id);
  const viewer = await getViewer();
  const check = Number.isSafeInteger(n) && n > 0 ? await getShadowCheck(getPool(), viewer, n) : null;
  if (!check) notFound();
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`Answer check #${check.id} · ${check.system}`}
        title={check.kind === "answer" ? "Is this answer supported by the records?" : "Does this figure match the records?"}
        description={<p className="text-sm">Checked {dateTime(check.checkedAt)} by {check.actor}. Input fingerprint <span className="font-mono text-xs">{check.inputHash.slice(0, 12)}</span>. Nothing in either system was changed.</p>}
        crumbs={[{ href: "/assurance", label: "Answer check" }, { label: `#${check.id}` }]}
      />
      {check.kind === "answer" ? <AnswerResult check={check} /> : <SnapshotResult check={check} />}
    </div>
  );
}

const value = (v: number | null, unit: "usd_cents" | "count") => (v === null ? "undefined" : unit === "usd_cents" ? exactDollars(v) : String(v));

function SnapshotResult({ check }: { check: ShadowCheckRow }) {
  const r = check.result as SnapshotCheck;
  const input = check.input as Snapshot;
  const d = r.theirs.definition;
  return (
    <>
      <Card title="Conclusion" action={<VerdictBadge verdict={r.verdict} />}>
        <ul className="space-y-1 text-sm" data-testid="shadow-findings">
          {r.findings.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <p className="mt-3 text-sm font-medium" data-testid="shadow-next">
          Next: {r.nextStep}
        </p>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`As reported by ${check.system}`} subtitle="Exactly as entered">
          <KV
            columns={1}
            items={[
              ["Value", <strong key="v">{r.theirs.value ?? "—"}</strong>],
              ["Scope", r.scope.label],
              ["Days (UTC, inclusive)", `${input.period.from} to ${input.period.to}`],
              ["Currency", r.theirs.currency ?? "not stated"],
              ["Refreshed", dateTime(r.theirs.asOf)],
              ["Definition", d ? `${d.id} v${d.version} · ${d.family}` : "not stated"],
              ...(d ? ([["Attributes", [d.numerator, d.population, d.cashBasis, d.periodBasis, d.branchBasis].filter(Boolean).join(" · ")]] as Array<[string, string]>) : []),
              ...(r.theirs.numerator !== null ? ([["Numerator", r.theirs.numerator]] as Array<[string, string]>) : []),
              ...(r.theirs.denominator !== null ? ([["Denominator", String(r.theirs.denominator)]] as Array<[string, string]>) : []),
            ]}
          />
        </Card>
        <Card title="What the records say" subtitle={r.ours ? `${r.ours.label} · definition ${r.ours.definitionVersion}` : "Not computed: the figure could not be framed"}>
          {r.ours ? (
            <KV
              columns={1}
              items={[
                ["Value", <strong key="v" data-testid="shadow-ours">{value(r.ours.value, r.ours.unit)}</strong>],
                ["Window", r.window ? `${r.window.fromInstant} to ${r.window.toInstant} (end excluded)` : "—"],
                ...(r.ours.numerator !== null ? ([["Paid spend", exactDollars(r.ours.numerator)]] as Array<[string, string]>) : []),
                ...(r.ours.denominator !== null ? ([["Paid customers", String(r.ours.denominator)]] as Array<[string, string]>) : []),
              ]}
            />
          ) : (
            <p className="text-sm text-muted">The product did not compute a figure because the comparison could not be framed.</p>
          )}
          {r.proof.href && (
            <div className="mt-3">
              <ButtonLink href={r.proof.href} testId="shadow-trace">
                Open the trace: every record behind this figure
              </ButtonLink>
            </div>
          )}
        </Card>
      </div>
      {r.limitations.length > 0 && (
        <Callout tone="info" title="Limits of this check">
          <ul className="list-disc space-y-1 pl-5">
            {r.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Callout>
      )}
    </>
  );
}

function AnswerResult({ check }: { check: ShadowCheckRow }) {
  const r = check.result as AnswerCheck;
  const input = check.input as AnswerInput;
  return (
    <>
      <Card title="Conclusion" action={<VerdictBadge verdict={r.overall} />}>
        <p className="text-sm">
          {r.claims.filter((c) => c.verdict === "SUPPORTED").length} of {r.claims.length} claim(s) follow from the records. Each claim below is judged on its own: a
          correct figure does not make the sentence around it true, and a cause is never certified by a figure.
        </p>
        {r.entities.branches.length > 0 && (
          <p className="mt-2 text-xs text-muted">
            Read for {r.entities.branches.map((b, i) => (
              <span key={b}>
                {i > 0 && ", "}
                <Link href={`/branches/${b}?period=oct`} className="text-accent hover:underline">
                  {b}
                </Link>
              </span>
            ))}{" "}
            · {r.facts} fact(s) from the read-only tools.
          </p>
        )}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Original answer from ${check.system}`} subtitle="Untrusted text: read, never followed">
          {input.question && <p className="mb-2 text-xs text-muted">Question: {input.question}</p>}
          <blockquote className="whitespace-pre-wrap border-l-2 border-border pl-3 text-sm" data-testid="shadow-original">
            {input.answer}
          </blockquote>
        </Card>
        <Card title="Verified result, claim by claim">
          <ol className="space-y-3 text-sm" data-testid="shadow-claims">
            {r.claims.map((c, i) => (
              <li key={i} data-verdict={c.verdict} className="space-y-1">
                <div className="flex flex-wrap items-start gap-2">
                  <VerdictBadge verdict={c.verdict} />
                  <span>“{c.text}”</span>
                </div>
                <p className="text-xs text-muted">{c.reason}</p>
                {c.propositions.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-xs text-accent">How it was checked ({c.propositions.length})</summary>
                    <ul className="mt-1 space-y-1 text-xs">
                      {c.propositions.map((p, k) => (
                        <li key={k}>
                          <span className="font-mono">{p.formula || "—"}</span> · {p.verdict.toLowerCase()}
                          {p.gap ? ` (${p.gap})` : ""}: {p.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </Card>
      </div>
      {r.limitations.length > 0 && (
        <Callout tone="info" title="Limits of this check">
          <ul className="list-disc space-y-1 pl-5">
            {r.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Callout>
      )}
    </>
  );
}
