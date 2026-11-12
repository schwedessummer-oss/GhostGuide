"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Share2 } from "lucide-react";
import { buttonClass } from "@/components/ui";

/**
 * Share the trail page: the system share sheet when the browser has one
 * (navigator.share), otherwise copy the link with a visible confirmation.
 */
export function ShareButton({ url, title, className }: { url: string; title: string; className?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function flash(next: "copied" | "failed") {
    setStatus(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), 4000);
  }

  async function share() {
    // Share the address the visitor is on (same page), falling back to the canonical URL.
    const href = typeof window !== "undefined" ? window.location.href.split("#")[0] : url;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title, url: href });
        return;
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        // Fall through to copying.
      }
    }
    try {
      await navigator.clipboard.writeText(href);
      flash("copied");
    } catch {
      flash("failed");
    }
  }

  return (
    <>
      <button type="button" onClick={share} className={buttonClass("secondary", "md", className)}>
        {status === "copied" ? <Check aria-hidden className="size-5" /> : <Share2 aria-hidden className="size-5" />}
        {status === "copied" ? "Link copied" : "Share"}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {status === "copied"
          ? "Link to this trail copied to the clipboard."
          : status === "failed"
            ? "Couldn't copy the link. Copy it from the address bar instead."
            : ""}
      </span>
      {status === "failed" ? (
        <p className="col-span-full basis-full text-sm text-red-ink">Couldn&apos;t copy the link — copy it from the address bar instead.</p>
      ) : null}
    </>
  );
}
