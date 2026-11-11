"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CloudOff, Loader2, RefreshCw } from "lucide-react";
import type { PendingSummary } from "@/lib/offline/background-sync";

/**
 * CROSS-SLICE CONTRACT — implemented by the hike slice, wired into the site
 * header by the lead.
 *
 * Sign out deletes everything Ghost Guide stored on this device (offline
 * trips, hike state and the queue of hike updates not yet sent). Before
 * signing out, this button checks that queue: when updates are waiting it
 * tries to send them (if online); if some still remain it asks first, so an
 * unsent Finish or "I'm okay" is never wiped silently. Without JavaScript it
 * is a plain POST form to /auth/logout.
 */
const CHECK_TIMEOUT_MS = 4_000;
const SYNC_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

type Phase = "idle" | "checking" | "sending" | "confirm";

export function SignOutButton({ className, children }: { className?: string; children?: ReactNode }) {
  const formRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const allow = useRef(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pending, setPending] = useState<PendingSummary | null>(null);
  const [summary, setSummary] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (phase === "confirm" && !d.open) d.showModal();
    if (phase !== "confirm" && d.open) d.close();
  }, [phase]);

  const signOut = () => {
    allow.current = true;
    setPhase("idle");
    formRef.current?.submit(); // submit() does not re-run the guard
  };

  /** Try to send what is queued (when online); resolves with what is still unsent, or null when it can't be checked. */
  const sendAndCheck = async (fromDialog = false): Promise<PendingSummary | null> => {
    const lib = await import("@/lib/offline/background-sync");
    let p = await withTimeout(lib.pendingHikeUpdates().catch(() => null), CHECK_TIMEOUT_MS, null);
    if (!p || p.total === 0) return p;
    if (navigator.onLine) {
      if (!fromDialog) setPhase("sending");
      p = await withTimeout(lib.flushPendingHikeUpdates().catch(() => p), SYNC_TIMEOUT_MS, p);
      p = (await withTimeout(lib.pendingHikeUpdates().catch(() => p), CHECK_TIMEOUT_MS, p)) ?? p;
    }
    if (p && p.total > 0) setSummary(lib.describePending(p));
    return p;
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    if (allow.current) return;
    e.preventDefault();
    if (phase !== "idle") return;
    setPhase("checking");
    setStatus(null);
    const p = await sendAndCheck().catch(() => null);
    setOnline(navigator.onLine);
    if (!p || p.total === 0) {
      // Nothing waiting (or this browser can't store data offline): sign out.
      signOut();
      return;
    }
    setPending(p);
    setPhase("confirm");
  };

  const retry = async () => {
    setStatus("Sending…");
    const p = await sendAndCheck(true).catch(() => pending);
    setOnline(navigator.onLine);
    if (!p || p.total === 0) {
      setStatus("Everything was sent. Signing you out…");
      signOut();
      return;
    }
    setPending(p);
    setPhase("confirm");
    setStatus(navigator.onLine ? "Some updates still couldn't be sent. Try again in a moment." : "You're offline. Connect to the internet and try again.");
  };

  const n = pending?.total ?? 0;
  const safety = !!pending && pending.finishes + pending.okTaps + pending.extensions > 0;
  const busy = phase === "checking" || phase === "sending";

  return (
    <>
      <form ref={formRef} action="/auth/logout" method="post" onSubmit={onSubmit}>
        <button className={className} aria-busy={busy || undefined} disabled={busy} data-testid="sign-out">
          {busy ? (
            <>
              <Loader2 aria-hidden className="mr-1.5 size-4 motion-safe:animate-spin" />
              {phase === "sending" ? "Sending hike updates…" : "Signing out…"}
            </>
          ) : (
            (children ?? "Sign out")
          )}
        </button>
      </form>

      <dialog
        ref={dialogRef}
        onClose={() => setPhase((p) => (p === "confirm" ? "idle" : p))}
        aria-labelledby="signout-guard-title"
        aria-describedby="signout-guard-body"
        className="m-auto w-[min(92vw,30rem)] rounded-2xl border border-sand-200 bg-surface p-5 text-ink backdrop:bg-black/40"
        data-testid="sign-out-guard"
      >
        <h2 id="signout-guard-title" className="flex items-center gap-2 text-xl font-bold">
          <CloudOff aria-hidden className="size-5 shrink-0 text-amber-ink" /> Unsent hike updates
        </h2>
        <div id="signout-guard-body" className="mt-2 space-y-2">
          <p>
            <strong>
              {n} hike {n === 1 ? "update" : "updates"} (e.g. Finish, I&apos;m okay) {n === 1 ? "hasn't" : "haven't"} reached Ghost Guide yet and will be
              deleted from this device if you sign out.
            </strong>
          </p>
          {summary ? <p className="text-sm text-muted">Waiting to send: {summary}.</p> : null}
          {safety ? (
            <p className="rounded-lg bg-amber-bg p-2 text-sm text-amber-ink">
              Until they reach Ghost Guide, we may still consider you on the trail — if you set up a check-in, your contact could be told we
              haven&apos;t heard from you.
            </p>
          ) : null}
          {!online ? <p className="text-sm">You&apos;re offline. Connect to the internet, then choose &quot;Try sync again&quot;.</p> : null}
          <p aria-live="polite" className="min-h-5 text-sm font-semibold" data-testid="sign-out-guard-status">
            {status}
          </p>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => void retry()}
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-forest-700 px-3 font-semibold text-white hover:bg-forest-800"
            data-testid="sign-out-retry"
          >
            <RefreshCw aria-hidden className="size-4" /> Try sync again
          </button>
          <button
            type="button"
            onClick={signOut}
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#f5c6c1] bg-red-bg px-3 font-semibold text-red-ink"
            data-testid="sign-out-anyway"
          >
            Sign out anyway
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => setPhase("idle")}
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-sand-300 px-3 font-semibold text-ink hover:bg-sand-100"
            data-testid="sign-out-stay"
          >
            Stay signed in
          </button>
        </div>
      </dialog>
    </>
  );
}
