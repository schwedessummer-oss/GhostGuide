"use client";

import Link from "next/link";
import { useEffect, useOptimistic, useState, useTransition } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { getTrailSaveState, setTrailSaved, type SaveState } from "@/app/saved/actions";
import { buttonClass } from "@/components/ui";

/**
 * Save toggle for a catalog trail.
 *
 * The trail page HTML is shared by every visitor, so this button asks for
 * the visitor's own state after it mounts. Before that (and without
 * JavaScript) it is a link to sign in, which is right for signed-out
 * visitors. Toggling is optimistic (useOptimistic) and rolls back with a
 * message if the server refuses.
 */
export function SaveTrailButton({
  trailId,
  trailName,
  path,
  className,
}: {
  trailId: string;
  trailName: string;
  path: string;
  className?: string;
}) {
  const [state, setState] = useState<SaveState | null>(null);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const saved = state?.signedIn ? state.saved : false;
  const [optimisticSaved, setOptimisticSaved] = useOptimistic(saved);

  useEffect(() => {
    let cancelled = false;
    getTrailSaveState(trailId)
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => {
        // Unknown: keep the sign-in link, which still works.
        if (!cancelled) setState({ signedIn: false });
      });
    return () => {
      cancelled = true;
    };
  }, [trailId]);

  const loginHref = `/login?next=${encodeURIComponent(path)}`;
  const base = buttonClass("secondary", "md", className);

  if (!state || !state.signedIn) {
    // rel=nofollow: each trail page has its own /login?next=… URL; crawlers should not queue them (the login page is noindex too).
    return (
      <Link href={loginHref} rel="nofollow" className={base} aria-busy={!state || undefined}>
        <Bookmark aria-hidden className="size-5" />
        Save
        <span className="sr-only"> {trailName} (sign in to save trails)</span>
      </Link>
    );
  }

  function toggle() {
    const next = !optimisticSaved;
    setError(null);
    startTransition(async () => {
      setOptimisticSaved(next);
      try {
        const res = await setTrailSaved(trailId, next);
        if (res.ok) {
          startTransition(() => setState({ signedIn: true, saved: res.saved }));
          setMessage(res.saved ? `${trailName} saved. Find it on your Saved page.` : `${trailName} removed from your saved trails.`);
        } else if (!res.signedIn) {
          startTransition(() => setState({ signedIn: false }));
          setMessage("You're signed out. Sign in to save trails.");
        } else {
          setError(res.error);
        }
      } catch {
        setError("Couldn't reach Ghost Guide. Check your connection and try again.");
      }
    });
  }

  return (
    <div className="contents">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={optimisticSaved}
        aria-describedby={error ? `save-error-${trailId}` : undefined}
        className={
          optimisticSaved ? buttonClass("secondary", "md", `${className ?? ""} border-forest-700 bg-forest-50 text-forest-900`) : base
        }
        data-pending={pending || undefined}
      >
        {optimisticSaved ? <BookmarkCheck aria-hidden className="size-5" /> : <Bookmark aria-hidden className="size-5" />}
        {optimisticSaved ? "Saved" : "Save"}
        <span className="sr-only"> {trailName}</span>
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {message}
      </span>
      {error ? (
        <p id={`save-error-${trailId}`} role="alert" className="col-span-full basis-full text-sm font-semibold text-red-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}
