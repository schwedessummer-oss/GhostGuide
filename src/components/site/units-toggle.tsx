"use client";

import { useRouter } from "next/navigation";
import clsx from "clsx";
import { UNITS_COOKIE, UNITS_COOKIE_MAX_AGE_SEC, type Units } from "@/lib/units";

/** Remember the choice on this device (a preference cookie, not personal data). */
export function saveUnitsPreference(units: Units) {
  try {
    document.cookie = `${UNITS_COOKIE}=${units}; path=/; max-age=${UNITS_COOKIE_MAX_AGE_SEC}; samesite=lax`;
    // Pages that switch units in CSS (trail pages) read this attribute.
    document.documentElement.setAttribute("data-units", units);
  } catch {
    /* cookies disabled: the choice still applies to this page */
  }
}

/**
 * Miles / kilometres switch. With `onChange` the caller applies the new
 * units itself; without it the current page re-renders on the server.
 */
export function UnitsToggle({
  value,
  onChange,
  className,
  size = "md",
}: {
  value: Units;
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
