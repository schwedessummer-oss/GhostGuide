"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui";

export default function AdminError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined;
  useEffect(() => {
    console.error("admin.page_error", digest ?? "");
  }, [digest]);
  return (
    <div role="alert" className="rounded-xl border border-[#f5c6c1] bg-red-bg p-6 text-red-ink">
      <h1 className="text-xl font-bold">This admin page could not load</h1>
      <p className="mt-2">Nothing was changed. Try again; if it keeps failing, check the server logs{digest ? ` (reference ${digest})` : ""}.</p>
      <Button className="mt-4" onClick={() => retry()}>
        Try again
      </Button>
    </div>
  );
}
