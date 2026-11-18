import Link from "next/link";
import { Suspense } from "react";
import { ShadowForm } from "@/components/shadow/ShadowForm";
import { VerdictBadge } from "@/components/shadow/VerdictBadge";
import { Card, EmptyState, PageHeader, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { dateTime } from "@/lib/format";
import { BRANCHES } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";
import { listShadowChecks } from "@/lib/shadow/store";
import { canSeeBranch } from "@/lib/viewer";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata = { title: "Answer check" };

export default function AssurancePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operate · reads data, never changes another system"
        title="Check another system's figure or answer"
        description={
          <p className="max-w-3xl">
            Enter a figure from another report, or an answer someone was given. It is checked against this product&apos;s own records and definitions: first whether
            the two measure the same thing, then whether the evidence is complete, then whether the numbers agree to the cent.
          </p>
        }
      />
      <Suspense fallback={<Skeleton lines={10} />}>
        <Assurance searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Assurance({ searchParams }: { searchParams: SearchParams }) {
  const [sp, viewer] = await Promise.all([searchParams, getViewer()]);
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined)) ?? null;
  const branches = BRANCHES.filter((b) => canSeeBranch(viewer, b.id)).map((b) => ({ id: b.id, label: `${b.id} ${b.name}` }));
  const branchParam = one("branch");
  const initial = { branch: branchParam && branches.some((b) => b.id === branchParam) ? branchParam : null, preset: one("measure"), kind: one("kind") === "answer" ? ("answer" as const) : ("snapshot" as const) };
  const checks = await listShadowChecks(getPool(), viewer);
  return (
    <>
      {viewer.can.investigate ? (
        <Card title="What to check">
          <ShadowForm branches={branches} initial={initial} />
        </Card>
      ) : (
        <Card title="What to check">
          <p className="text-sm text-muted">{viewer.label} can read recorded checks but not run new ones.</p>
        </Card>
      )}
      <Card title="Recent checks" subtitle="Every check is recorded with what was entered, who ran it and the result. Only checks within your scope are listed.">
        {checks.length === 0 ? (
          <EmptyState title="No checks yet">{viewer.can.investigate ? "Enter a figure or an answer above." : "None has been run in your scope."}</EmptyState>
        ) : (
          <TableWrap label="Recent checks" testId="shadow-checks">
            <thead>
              <tr>
                <Th>Checked</Th>
                <Th>From</Th>
                <Th>What</Th>
                <Th>Result</Th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id}>
                  <Td>{dateTime(c.checkedAt)}</Td>
                  <Td>{c.system}</Td>
                  <Td>
                    <Link href={`/assurance/${c.id}`} className="text-accent hover:underline">
                      {c.kind === "answer" ? "An answer" : summary(c.input as { scope?: { branch?: string; brand?: string }; definition?: { family?: string } })}
                    </Link>
                  </Td>
                  <Td>
                    <VerdictBadge verdict={c.verdict} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </>
  );
}

function summary(input: { scope?: { branch?: string; brand?: string }; definition?: { family?: string } }): string {
  const where = input.scope?.branch ?? input.scope?.brand ?? "All branches";
  return `${input.definition?.family ?? "A figure"} · ${where}`;
}
