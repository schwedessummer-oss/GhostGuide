"use client";

import { useEffect, useRef } from "react";
import { Droplet, Gauge, Map as MapIcon, MapPinOff, X } from "lucide-react";
import { Button } from "@/components/ui";
import { REMINDER_DISCLAIMER } from "@/domain/reminders";
import type { HikeEngine, HikeSnapshot } from "./engine/hike-engine";

/**
 * Off-route prompt. Navigation aid only — the wording never implies that
 * being on route means being safe.
 *
 * It must be seen wherever the hiker has scrolled (reading a story, the
 * settings or the simulator): it is rendered in a region that sticks to the
 * top of the viewport, it is an assertive live region (role="alert"), and
 * keyboard / screen-reader focus moves to it when it appears and returns to
 * where it was once it is dismissed.
 */
export function DeviationPrompt({ snap, engine, helpHref, onShowRoute }: { snap: HikeSnapshot; engine: HikeEngine; helpHref: string; onShowRoute: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const visible = snap.deviation.promptVisible && snap.phase === "active";
  const promptAt = snap.deviation.lastPromptAt;

  useEffect(() => {
    if (!visible) return;
    const el = ref.current;
    if (!el) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !el.contains(active) && active !== document.body) returnFocus.current = active;
    el.focus({ preventScroll: true });
    // Sticky positioning keeps it in view; this covers browsers without it.
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= window.innerHeight) {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    }
  }, [visible, promptAt]);

  useEffect(() => {
    if (visible) return;
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }, [visible]);

  if (!visible) return null;
  const d = snap.deviation.lastDistanceM;
  return (
    <section
      ref={ref}
      tabIndex={-1}
      role="alert"
      aria-live="assertive"
      aria-labelledby="deviation-title"
      className="max-h-[75dvh] overflow-y-auto rounded-2xl border-2 border-amber-ink bg-amber-bg p-4 text-amber-ink shadow-lg outline-none focus-visible:ring-4 focus-visible:ring-amber-ink/40"
      data-testid="deviation-prompt"
    >
      <h2 id="deviation-title" className="flex items-center gap-2 text-lg font-bold">
        <MapPinOff aria-hidden className="size-5 shrink-0" /> You may be off the route
      </h2>
      <p className="mt-1 text-ink">
        Your recent locations are {d != null ? `about ${Math.round(d)} m` : "some distance"} from the planned route. GPS can be wrong under trees or near
        cliffs — check the map and your surroundings.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Button variant="secondary" onClick={() => engine.dismissDeviation("fine")} data-testid="deviation-fine">
          I&apos;m fine
        </Button>
        <Button variant="secondary" onClick={() => engine.dismissDeviation("intentional")}>
          This is intentional
        </Button>
        <Button
          variant="secondary"
          className="col-span-2 sm:col-span-1"
          onClick={() => {
            onShowRoute();
          }}
        >
          <MapIcon aria-hidden className="size-4" /> Show route
        </Button>
      </div>
      <p className="mt-3 text-sm">
        Lost or hurt? <a href={helpHref} className="font-semibold underline">Open Help</a>. If you are lost, stay where you are.
      </p>
    </section>
  );
}

export function ReminderCard({ snap, engine }: { snap: HikeSnapshot; engine: HikeEngine }) {
  const r = snap.reminder;
  if (!r) return null;
  const Icon = r.kind === "hydration" ? Droplet : Gauge;
  return (
    <section aria-labelledby="reminder-title" className="rounded-2xl border border-blue-ink/30 bg-blue-bg p-4 text-blue-ink" data-testid="hike-reminder">
      <div className="flex items-start justify-between gap-2">
        <h2 id="reminder-title" className="flex items-center gap-2 font-bold">
          <Icon aria-hidden className="size-5" /> {r.title}
        </h2>
        <button type="button" onClick={() => engine.dismissReminder()} className="-m-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg" aria-label="Dismiss reminder">
          <X aria-hidden className="size-5" />
        </button>
      </div>
      <p className="mt-1 text-ink">{r.body}</p>
      <p className="mt-2 text-xs">{REMINDER_DISCLAIMER} Change or turn off reminders in Settings.</p>
    </section>
  );
}

export function GapWarning({ snap }: { snap: HikeSnapshot }) {
  if (!snap.gapWarning) return null;
  return (
    <p role="status" className="rounded-xl border border-[#f1d9b0] bg-amber-bg p-3 text-sm text-amber-ink">
      {snap.gapWarning}
    </p>
  );
}
