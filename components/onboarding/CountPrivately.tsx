"use client";

import { useRouter } from "next/navigation";
import { useAction } from "@/components/actions/useAction";
import { Button } from "@/components/ui";

/**
 * "Show my dashboard with this file": the server counts the dry run's new rows in a private copy
 * (a transaction it always rolls back) and keeps the dashboard's figures before and after
 * (POST /api/onboarding/uploads/:id/preview, lib/onboarding/service.ts previewUpload). Then the
 * visitor's own dashboard opens. A refusal, such as "another private copy is being counted"
 * (503), is shown in the server's words.
 */
export function CountPrivately({ uploadId, variant = "primary", label = "Show my dashboard with this file" }: { uploadId: number; variant?: "primary" | "secondary"; label?: string }) {
  const router = useRouter();
  const { busy, message, run } = useAction();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant={variant}
        busy={busy !== null}
        busyLabel="Counting your file in a private copy…"
        testId="count-privately"
        onClick={async () => {
          if (await run("count", `/api/onboarding/uploads/${uploadId}/preview`, undefined)) router.push(`/onboarding/${uploadId}/dashboard`);
        }}
      >
        {label}
      </Button>
      {message && !message.ok && (
        <span role="alert" className="text-xs text-bad" data-testid="count-privately-error">
          {message.text}
        </span>
      )}
    </span>
  );
}
