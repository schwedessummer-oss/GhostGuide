"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RotateCw } from "lucide-react";

/** Unexpected failure while rendering Explore: say so plainly and offer a retry. Never shows stale or invented trails. */
export default function ExploreError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined;
  useEffect(() => {
    console.error("explore.page_error", digest ?? "");
  }, [digest]);
  return (
    <div data-app-fullscreen className="flex min-h-0 flex-1 items-center justify-center bg-sand-100 px-4 py-10">
      <div role="alert" className="w-full max-w-md rounded-2xl bg-surface p-6 text-center shadow-[0_2px_12px_rgba(15,35,24,0.12)] ring-1 ring-sand-200">
        <h1 className="text-xl font-bold text-ink">Explore couldn’t load</h1>
        <p className="mt-2 text-muted">
          Trail search or the map ran into a problem on our side. Nothing is shown rather than old or made-up results.
          {digest ? ` (reference ${digest})` : ""}
        </p>
        <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
          <button type="button" onClick={() => retry()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-forest-700 px-5 font-semibold text-white hover:bg-forest-800">
            <RotateCw aria-hidden className="size-4" /> Try again
          </button>
          <Link href="/explore" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-forest-200 px-5 font-semibold text-forest-800 hover:bg-forest-50">
            Start a new search
          </Link>
        </div>
      </div>
    </div>
  );
}
