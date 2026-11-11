"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

/**
 * Layout-level confirmation for admin actions.
 *
 * A successful admin action refreshes the page, and many forms render only
 * in the state they change (e.g. "End now" on an active closure), so the
 * form — and the result message inside it — unmounts in the same commit as
 * the result. This live region lives in the persistent admin layout, so the
 * confirmation (and any warnings) is still shown and announced.
 */
export interface AdminFlashMessage {
  message: string;
  warnings?: string[];
}

type Flash = AdminFlashMessage & { id: number; pathname: string };

const FlashContext = createContext<((m: AdminFlashMessage | null) => void) | null>(null);

/** The setter (null clears the toast), or null outside the admin layout (forms then announce locally). */
export function useAdminFlash() {
  return useContext(FlashContext);
}

export function AdminFlashProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [flash, setFlash] = useState<Flash | null>(null);
  const show = useCallback(
    (m: AdminFlashMessage | null) => setFlash((prev) => (m ? { id: (prev?.id ?? 0) + 1, message: m.message, warnings: m.warnings ?? [], pathname } : null)),
    [pathname],
  );
  // A confirmation belongs to the page it was given on (derived, no effect).
  const visible = flash && flash.pathname === pathname ? flash : null;

  return (
    <FlashContext.Provider value={show}>
      {children}
      {/* The toast never blocks the page underneath (pointer-events-none);
          only its Dismiss button takes clicks. */}
      <div
        className={
          visible
            ? "pointer-events-none fixed inset-x-4 bottom-4 z-50 rounded-xl border border-forest-200 bg-forest-50 p-3 text-forest-900 shadow-lg sm:left-auto sm:right-6 sm:w-[26rem]"
            : undefined
        }
      >
        {/* The live region is always in the DOM so screen readers pick up changes. */}
        <div role="status" aria-live="polite" aria-atomic="true" className={visible ? undefined : "sr-only"}>
          {visible ? (
            <div key={visible.id}>
              <p className="font-semibold">
                <span aria-hidden>✓ </span>
                {visible.message}
              </p>
              {visible.warnings?.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-ink">
                  {visible.warnings.map((w) => (
                    <li key={w}>
                      <span className="font-semibold">Warning:</span> {w}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
        {visible ? (
          <button
            type="button"
            onClick={() => setFlash(null)}
            className="pointer-events-auto mt-2 inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold underline underline-offset-2"
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </FlashContext.Provider>
  );
}
