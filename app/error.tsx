"use client";

import { RouteError } from "@/components/RouteError";

/**
 * Fallback for every page without a closer error boundary: the Overview, Definitions and
 * Google feedback. Module pages (Action Center, customers, …) keep their own wording.
 * Errors in the root layout itself are handled by app/global-error.tsx.
 */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError title="This page could not be loaded." error={error} retry={retry} />;
}
