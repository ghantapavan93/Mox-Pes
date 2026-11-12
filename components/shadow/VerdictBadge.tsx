import { Badge } from "@/components/ui";

/** A Shadow Mode verdict in words a reader can act on; the code stays visible for reference. */
const VERDICT: Record<string, { label: string; tone: "good" | "bad" | "warn" | "neutral" }> = {
  MATCH: { label: "Matches", tone: "good" },
  MISMATCH: { label: "Does not match", tone: "bad" },
  INCOMPLETE_EVIDENCE: { label: "Our evidence is incomplete", tone: "warn" },
  INCOMPATIBLE_DEFINITION: { label: "Measures something else", tone: "neutral" },
  NOT_DETERMINABLE: { label: "Cannot be compared", tone: "neutral" },
  SUPPORTED: { label: "Supported", tone: "good" },
  PARTLY_SUPPORTED: { label: "Partly supported", tone: "warn" },
  NOT_SUPPORTED: { label: "Not supported", tone: "bad" },
  CONTRADICTED: { label: "Contradicted", tone: "bad" },
  UNSUPPORTED: { label: "Not proved", tone: "warn" },
  OUT_OF_SCOPE: { label: "Outside your scope", tone: "neutral" },
};

export function VerdictBadge({ verdict }: { verdict: string }) {
  const v = VERDICT[verdict] ?? { label: verdict, tone: "neutral" as const };
  return (
    <span className="inline-flex items-center gap-1.5" data-verdict={verdict}>
      <Badge tone={v.tone}>{v.label}</Badge>
      <span className="font-mono text-[10px] text-faint">{verdict}</span>
    </span>
  );
}
