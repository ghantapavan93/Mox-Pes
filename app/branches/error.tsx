"use client";

import { RouteError } from "@/components/RouteError";

/**
 * Unexpected failures on /branches/[id] (database unreachable, a bug). A branch outside the
 * viewer's scope is not an error: the page renders a 403 panel, and an unknown id is a 404.
 */
export default function BranchError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError title="The branch scorecard could not be loaded." error={error} retry={retry} />;
}
