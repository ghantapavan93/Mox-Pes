import "react";

declare module "react" {
  // A merged interface must declare React's own type parameter, used or not.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLAttributes<T> {
    /**
     * The Element Timing API's marker: the browser records when this element first painted, and
     * the measurement harness reads it (docs/agent-work/release/RELEASE-DESIGN.md §10).
     */
    elementtiming?: string;
  }
}
