"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-render the (server) page every few seconds while a status is pending,
 * e.g. waiting for the payment webhook. Stops after `maxSeconds`.
 */
export function AutoRefresh({ intervalMs = 2000, maxSeconds = 60 }: { intervalMs?: number; maxSeconds?: number }) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);
  const done = elapsed >= maxSeconds * 1000;
  useEffect(() => {
    if (done) return;
    const t = setTimeout(() => {
      setElapsed((e) => e + intervalMs);
      router.refresh();
    }, intervalMs);
    return () => clearTimeout(t);
  }, [elapsed, done, intervalMs, router]);
  return (
    <p role="status" aria-live="polite" className="text-sm text-muted">
      {done ? "Still waiting. Confirmation can take a minute; refresh this page or check My trips." : "Checking for confirmation automatically…"}
    </p>
  );
}
