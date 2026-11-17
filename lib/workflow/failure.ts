import type { Verification } from "./snapshot";

/**
 * What a reader is told when a dry run or an execution fails. A verification failure is authored
 * text ("Total ad spend changed from … to …") and is shown. Anything else is an unexpected error
 * whose raw text (a database constraint, a stack's message) would leak internals and read like a
 * bug report, so it is replaced by one plain sentence; the raw error stays stored with the proposal.
 * (Panel audit Q6: raw server errors reached the UI, shown as a success.)
 */
export function failureText(what: string, verification: Verification | null | undefined): string {
  const problems = verification?.problems ?? [];
  return problems.length > 0 ? `${what}: ${problems.join("; ")}` : `${what}: an unexpected error stopped it, and nothing was changed. The details are recorded with the proposal.`;
}
