"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import clsx from "clsx";
import { UNITS_ATTRIBUTE, UNITS_COOKIE } from "./measure";
import { unitsForLanguage, type Units } from "./format";

const EVENT = "gg-trail-units-change";
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365;

function readCookie(): Units | null {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${UNITS_COOKIE}=(imperial|metric)(?:;|$)`));
    return m ? (m[1] as Units) : null;
  } catch {
    return null;
  }
}

function current(): Units {
  return document.documentElement.getAttribute(UNITS_ATTRIBUTE) === "metric" ? "metric" : "imperial";
}

function apply(units: Units) {
  if (current() === units && document.documentElement.hasAttribute(UNITS_ATTRIBUTE)) return;
  document.documentElement.setAttribute(UNITS_ATTRIBUTE, units);
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

/** Applies the visitor's units (cookie, else browser language) and follows changes made elsewhere. */
function useUnitsSync() {
  useEffect(() => {
    apply(readCookie() ?? unitsForLanguage(navigator.language));
    // Follow a units switch made elsewhere on the page (e.g. the site footer) where the
    // browser reports cookie changes (Cookie Store API); otherwise on the next load.
    const store = (window as unknown as { cookieStore?: EventTarget }).cookieStore;
    const onChange = () => {
      const c = readCookie();
      if (c) apply(c);
    };
    store?.addEventListener("change", onChange);
    return () => store?.removeEventListener("change", onChange);
  }, []);
}

/** Renders nothing: for pages that show <Measure> values without their own toggle. */
export function UnitsSync() {
  useUnitsSync();
  return null;
}

/**
 * Imperial / metric switch for every <Measure> on the page.
 *
 * The choice is kept in the site-wide `gg_units` cookie (a display
 * preference, not personal data), so it follows the visitor across pages;
 * without one, the browser language decides (imperial for US English).
 * Values are switched in CSS (see measure.tsx), so the cached page HTML is
 * the same for everyone.
 */
export function UnitsToggle({ className }: { className?: string }) {
  const units = useSyncExternalStore(subscribe, current, () => "imperial" as Units);
  useUnitsSync();

  const choose = useCallback((u: Units) => {
    try {
      document.cookie = `${UNITS_COOKIE}=${u}; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}; SameSite=Lax`;
    } catch {
      /* cookies blocked: the choice lasts for this page only */
    }
    apply(u);
  }, []);

  return (
    <div
      role="group"
      aria-label="Units"
      className={clsx("inline-flex rounded-xl border border-sand-300 bg-surface p-0.5 text-sm", className)}
    >
      {(["imperial", "metric"] as const).map((u) => (
        <button
          key={u}
          type="button"
          aria-pressed={units === u}
          onClick={() => choose(u)}
          className={clsx(
            "min-h-10 min-w-12 rounded-[0.6rem] px-3 font-semibold transition-colors",
            units === u ? "bg-forest-800 text-white" : "text-muted hover:bg-sand-100 hover:text-ink",
          )}
        >
          {u === "imperial" ? "mi" : "km"}
          <span className="sr-only">{u === "imperial" ? " (miles and feet)" : " (kilometres and metres)"}</span>
        </button>
      ))}
    </div>
  );
}
