import { money } from "@/lib/format";

/**
 * The tail of the Overview headline after "N open exceptions involve $X of collected revenue".
 * It says what that revenue is, in the two parts `totals()` returns, so the sentence never
 * claims that disputed credit (a branch mismatch, a D2D / paid conflict: tied, but contested)
 * is revenue that cannot be tied at all. A part that is zero is not mentioned.
 */
export function AtRiskSplit({ untiedCents, creditDisputedCents }: { untiedCents: number; creditDisputedCents: number }) {
  const untied = <strong className="text-text">{money(untiedCents)}</strong>;
  const disputed = <strong className="text-text">{money(creditDisputedCents)}</strong>;
  if (untiedCents > 0 && creditDisputedCents > 0) {
    return (
      <span data-testid="at-risk-split">
        : {untied} cannot yet be tied to a lead, branch or channel, and {disputed} is tied but its branch or channel credit is
        disputed
      </span>
    );
  }
  if (untiedCents > 0) return <span data-testid="at-risk-split"> that cannot yet be tied to a lead, branch or channel</span>;
  if (creditDisputedCents > 0) return <span data-testid="at-risk-split"> that is tied, but whose branch or channel credit is disputed</span>;
  return null;
}
