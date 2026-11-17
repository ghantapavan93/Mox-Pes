import Link from "next/link";
import type { ReactNode } from "react";

/**
 * A reference to an incident that holds a decision: a link when the viewer may open the incident,
 * otherwise its number and why not. A company-level incident (no branch of its own: unmapped spend
 * counted where its customers are) holds a branch's budget signal, but only company-wide roles may
 * open it; a branch- or brand-scoped viewer was sent to a "not found" page (book gap N27, seen as
 * the brand lead's hold on B44 → incident #970). The incident page's own refusal is unchanged.
 */
export function IncidentRef({
  href,
  companyLevel,
  scoped,
  className,
  testId,
  children,
}: {
  href: string;
  companyLevel: boolean;
  /** The viewer's scope is limited to some branches (viewer.branchIds !== null). */
  scoped: boolean;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  if (!(companyLevel && scoped)) {
    return (
      <Link href={href} className={className} data-testid={testId}>
        {children}
      </Link>
    );
  }
  return (
    <span className="text-muted" data-testid={testId ? `${testId}-unavailable` : "incident-unavailable"}>
      {children} <span className="text-xs">(company-wide, outside your scope; an analyst resolves it)</span>
    </span>
  );
}
