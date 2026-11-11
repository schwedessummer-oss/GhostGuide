"use client";

import { useEffect, useRef, useState } from "react";
import { Flag, HeartPulse, LifeBuoy, Pause, Play, ThumbsUp } from "lucide-react";
import clsx from "clsx";
import { Button } from "@/components/ui";
import type { HikeEngine, HikeSnapshot } from "./engine/hike-engine";
import { formatClockShort } from "./format";

/**
 * Large, thumb-reachable controls pinned to the bottom of the screen:
 * Pause/Resume, "I'm okay", Help and Finish (with confirmation).
 */
export function HikeControls({ snap, engine, helpHref }: { snap: HikeSnapshot; engine: HikeEngine; helpHref: string }) {
  const [confirming, setConfirming] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (confirming && !d.open) d.showModal();
    if (!confirming && d.open) d.close();
  }, [confirming]);

  if (snap.phase !== "active" && snap.phase !== "paused") return null;
  const big = "min-h-16 flex-col gap-1 px-2 py-2 text-sm";
  const ok = snap.okTap;

  return (
    <>
      <div className="sticky bottom-0 z-30 -mx-4 border-t border-sand-200 bg-surface/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border">
        <div className="grid grid-cols-4 gap-2">
          {snap.phase === "active" ? (
            <Button variant="secondary" className={big} onClick={() => engine.pause()} data-testid="hike-pause">
              <Pause aria-hidden className="size-6" /> Pause
            </Button>
          ) : (
            <Button className={big} onClick={() => engine.resume()} data-testid="hike-resume">
              <Play aria-hidden className="size-6" /> Resume
            </Button>
          )}
          <Button variant="secondary" className={big} onClick={() => engine.imOkay()} data-testid="hike-ok">
            <ThumbsUp aria-hidden className="size-6" /> I&apos;m okay
          </Button>
          <a href={helpHref} className={clsx("inline-flex items-center justify-center rounded-xl font-semibold", big, "bg-red-bg text-red-ink border border-[#f5c6c1]")}>
            <LifeBuoy aria-hidden className="size-6" /> Help
          </a>
          <Button variant="secondary" className={big} onClick={() => setConfirming(true)} data-testid="hike-finish">
            <Flag aria-hidden className="size-6" /> Finish
          </Button>
        </div>
        {ok ? (
          <p className="mt-2 flex items-start gap-1.5 text-sm" role="status" data-testid="hike-ok-status">
            <HeartPulse aria-hidden className="mt-0.5 size-4 shrink-0 text-forest-700" />
            <span>
              {ok.sent
                ? `"I'm okay" from ${formatClockShort(ok.at)} was sent.`
                : snap.sync.online
                  ? `"I'm okay" from ${formatClockShort(ok.at)} is being sent…`
                  : `"I'm okay" from ${formatClockShort(ok.at)} is saved and will be sent when you're back online.`}{" "}
              <span className="text-muted">Only matters if you set up a check-in.</span>
            </span>
          </p>
        ) : null}
      </div>

      <dialog
        ref={dialogRef}
        onClose={() => setConfirming(false)}
        aria-labelledby="finish-title"
        className="m-auto w-[min(92vw,28rem)] rounded-2xl border border-sand-200 bg-surface p-5 text-ink backdrop:bg-black/40"
      >
        <h2 id="finish-title" className="text-xl font-bold">
          Finish your hike?
        </h2>
        <p className="mt-2 text-muted">
          This stops location recording, narration and reminders, and tells Ghost Guide your trip is complete — any check-in reminders for this trip
          stop too.
        </p>
        {!snap.sync.online ? (
          <p className="mt-2 rounded-lg bg-amber-bg p-2 text-sm text-amber-ink">
            You&apos;re offline. Your finish is saved on this device and sent when you reconnect. Until then our servers still consider you on the
            trail — if you set up a check-in, tell your contact you&apos;re back if you can.
          </p>
        ) : null}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setConfirming(false)} autoFocus>
            Keep hiking
          </Button>
          <Button
            onClick={() => {
              setConfirming(false);
              engine.finish();
            }}
            data-testid="hike-finish-confirm"
          >
            Finish hike
          </Button>
        </div>
      </dialog>
    </>
  );
}
