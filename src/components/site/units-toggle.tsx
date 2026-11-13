"use client";

import { useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { UNITS_COOKIE, UNITS_COOKIE_MAX_AGE_SEC, parseUnits, unitsForLocale, type Units } from "@/lib/units";

/**
 * Fired on window when the units choice changes on this page. The same event
 * name as the trail page's toggle (src/components/trail/units-toggle.tsx), so
 * a switch in the footer also updates the trail page's toggle, and back.
 */
export const UNITS_CHANGE_EVENT = "gg-trail-units-change";
const UNITS_ATTRIBUTE = "data-units";

/** The saved choice in a Cookie header / document.cookie string, or null. */
export function unitsFromCookie(cookie: string | null | undefined): Units | null {
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i >= 0 && part.slice(0, i).trim() === UNITS_COOKIE) return parseUnits(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * The visitor's units in the browser: the saved choice (cookie), else what
 * this page shows (<html data-units>, set by the trail page), else a default
 * from the browser language (imperial for US English).
 */
export function browserUnits(cookie: string | null | undefined, pageUnits: string | null | undefined, language: string | null | undefined): Units {
  return unitsFromCookie(cookie) ?? parseUnits(pageUnits) ?? unitsForLocale(language);
}

function readBrowserUnits(): Units {
  try {
    return browserUnits(document.cookie, document.documentElement.getAttribute(UNITS_ATTRIBUTE), navigator.language);
  } catch {
    return "imperial";
  }
}

function subscribeUnits(onChange: () => void) {
  window.addEventListener(UNITS_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(UNITS_CHANGE_EVENT, onChange);
}

/**
 * The visitor's units, read in the browser; null in the server HTML and
 * during hydration. Shared chrome (the footer) uses this instead of reading
 * the cookie on the server, which would make every page dynamic.
 */
export function useBrowserUnits(): Units | null {
  return useSyncExternalStore(subscribeUnits, readBrowserUnits, () => null);
}

/** Remember the choice on this device (a preference cookie, not personal data). */
export function saveUnitsPreference(units: Units) {
  try {
    document.cookie = `${UNITS_COOKIE}=${units}; path=/; max-age=${UNITS_COOKIE_MAX_AGE_SEC}; samesite=lax`;
    // Pages that switch units in CSS (trail pages) read this attribute.
    document.documentElement.setAttribute(UNITS_ATTRIBUTE, units);
    window.dispatchEvent(new Event(UNITS_CHANGE_EVENT));
  } catch {
    /* cookies disabled: the choice still applies to this page */
  }
}

/**
 * Miles / kilometres switch. With `onChange` the caller applies the new
 * units itself; without it the current page re-renders on the server.
 * `value` null (not known yet, e.g. before hydration) checks neither.
 */
export function UnitsToggle({
  value,
  onChange,
  className,
  size = "md",
}: {
  value: Units | null;
  onChange?: (units: Units) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  const router = useRouter();
  const choose = (units: Units) => {
    if (units === value) return;
    saveUnitsPreference(units);
    if (onChange) onChange(units);
    else router.refresh();
  };
  const option = (units: Units, label: string, long: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === units}
      aria-label={long}
      onClick={() => choose(units)}
      className={clsx(
        "inline-flex items-center justify-center rounded-lg px-2.5 font-semibold transition-colors",
        size === "sm" ? "min-h-9 min-w-10 text-sm" : "min-h-11 min-w-12 text-[0.95rem]",
        value === units ? "bg-forest-700 text-white" : "text-forest-800 hover:bg-forest-50",
      )}
    >
      {label}
    </button>
  );
  return (
    <div role="radiogroup" aria-label="Units" className={clsx("inline-flex shrink-0 rounded-xl border border-sand-200 bg-surface p-0.5", className)}>
      {option("imperial", "mi", "Miles and feet")}
      {option("metric", "km", "Kilometres and metres")}
    </div>
  );
}

/** The site-wide switch (footer): follows the visitor's units in the browser. */
export function SiteUnitsToggle({ className, size }: { className?: string; size?: "sm" | "md" }) {
  return <UnitsToggle value={useBrowserUnits()} className={className} size={size} />;
}
