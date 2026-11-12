"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ExternalLink, Navigation } from "lucide-react";
import { buttonClass } from "@/components/ui";
import { directionsLinks } from "./format";

/**
 * "Directions" menu: opens driving directions to the trailhead in Google
 * Maps or Apple Maps (the person's own app does the routing). Escape and
 * clicks outside close it; focus returns to the button.
 */
export function DirectionsMenu({ lat, lng, className }: { lat: number; lng: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const links = directionsLinks({ lat, lng });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item =
    "flex min-h-11 items-center justify-between gap-3 rounded-lg px-3 font-medium text-ink hover:bg-forest-50 focus-visible:bg-forest-50";

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        className={buttonClass("secondary", "md", className)}
      >
        <Navigation aria-hidden className="size-5" />
        Directions
        <ChevronDown aria-hidden className={`size-4 transition-transform max-sm:hidden ${open ? "rotate-180" : ""}`} />
      </button>
      <div
        id={menuId}
        hidden={!open}
        className="absolute left-1/2 z-30 mt-2 w-64 -translate-x-1/2 rounded-xl border border-sand-200 bg-surface p-1.5 shadow-lg sm:left-0 sm:translate-x-0"
      >
        <p className="px-3 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Drive to the trailhead</p>
        <ul>
          <li>
            <a href={links.google} target="_blank" rel="noopener noreferrer" className={item} onClick={() => setOpen(false)}>
              Google Maps <ExternalLink aria-hidden className="size-4 text-muted" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </li>
          <li>
            <a href={links.apple} target="_blank" rel="noopener noreferrer" className={item} onClick={() => setOpen(false)}>
              Apple Maps <ExternalLink aria-hidden className="size-4 text-muted" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}
