"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * An investigation opened while it is still running (another tab, a lost stream) polls by
 * re-rendering the server page every two seconds until its status leaves "running".
 */
export function RefreshWhileRunning({ running }: { running: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => router.refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [running, router]);
  return running ? (
    <p role="status" className="rounded bg-accent-soft p-2 text-sm text-accent">
      Still running — this page refreshes as steps are recorded.
    </p>
  ) : null;
}
