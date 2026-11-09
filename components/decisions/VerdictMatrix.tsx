import type { ReactNode } from "react";
import { Badge, TableWrap, Td, Th } from "@/components/ui";
import type { ChannelVerdicts, DecisionVerdicts, EffectivenessVerdict, IntegrityVerdict, ReadinessVerdict } from "@/lib/decision/verdicts";
import { ReasonList } from "./ReasonList";
import { customers, usd } from "./fmt";

const INTEGRITY: Record<IntegrityVerdict["status"], { tone: "good" | "warn" | "bad"; label: string }> = {
  pass: { tone: "good", label: "Pass" },
  warn: { tone: "warn", label: "Pass with caveats" },
  fail: { tone: "bad", label: "Fail" },
};
const READINESS: Record<ReadinessVerdict["status"], { tone: "good" | "bad"; label: string }> = {
  ready: { tone: "good", label: "Ready" },
  not_ready: { tone: "bad", label: "Not ready" },
};
const EFFECTIVENESS: Record<EffectivenessVerdict["status"], { tone: "neutral" | "accent"; label: string }> = {
  unknown: { tone: "neutral", label: "Unknown — no randomized experiment" },
  measured: { tone: "accent", label: "Measured (randomized)" },
};

/** One verdict: its badge, and the reasons one keyboard-reachable click away. */
function Verdict({ badge, summary, children, testId }: { badge: ReactNode; summary: string; children: ReactNode; testId: string }) {
  return (
    <div data-testid={testId}>
      {badge}
      <details className="mt-1.5">
        <summary className="text-[11px] text-accent hover:underline">{summary}</summary>
        <div className="mt-2 max-w-sm">{children}</div>
      </details>
    </div>
  );
}

function Row({ c }: { c: ChannelVerdicts }) {
  const failing = c.readiness.blockers.length;
  return (
    <tr data-testid={`verdict-row-${c.channelCode}`}>
      <Td>
        <div className="font-medium">{c.label}</div>
        <div className="mt-0.5 text-[11px] text-faint">
          {usd(c.spendCents)} · {customers(c.acquired, 0)} customers · {c.cacCents === null ? "no CAC" : `${usd(c.cacCents)} attributed CAC`}
        </div>
      </Td>
      <Td>
        <Verdict
          testId="verdict-integrity"
          badge={<Badge tone={INTEGRITY[c.integrity.status].tone}>{INTEGRITY[c.integrity.status].label}</Badge>}
          summary={`${c.integrity.reasons.length} checks`}
        >
          <ReasonList reasons={c.integrity.reasons} />
        </Verdict>
      </Td>
      <Td>
        <Verdict
          testId="verdict-readiness"
          badge={<Badge tone={READINESS[c.readiness.status].tone}>{READINESS[c.readiness.status].label}</Badge>}
          summary={failing > 0 ? `${failing} blocker${failing === 1 ? "" : "s"}` : `${c.readiness.reasons.length} checks`}
        >
          <ReasonList reasons={c.readiness.reasons} />
        </Verdict>
      </Td>
      <Td>
        <Verdict
          testId="verdict-effectiveness"
          badge={<Badge tone={EFFECTIVENESS[c.effectiveness.status].tone}>{EFFECTIVENESS[c.effectiveness.status].label}</Badge>}
          summary="why"
        >
          <ReasonList reasons={c.effectiveness.reasons} />
        </Verdict>
      </Td>
    </tr>
  );
}

/** The three-verdict matrix: one row per paid-media channel, three independent columns. */
export function VerdictMatrix({ verdicts }: { verdicts: DecisionVerdicts }) {
  if (verdicts.channels.length === 0) return <p className="text-sm text-muted">No paid-media channels are defined.</p>;
  return (
    <TableWrap>
      <thead>
        <tr>
          <Th>Paid channel</Th>
          <Th>1 · Data integrity</Th>
          <Th>2 · Decision readiness</Th>
          <Th>3 · Business effectiveness</Th>
        </tr>
      </thead>
      <tbody>
        {verdicts.channels.map((c) => (
          <Row key={c.channelCode} c={c} />
        ))}
      </tbody>
    </TableWrap>
  );
}
