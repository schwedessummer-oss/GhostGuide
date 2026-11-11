"use client";

import { useEffect } from "react";

const HIKE_PAGE_RE = /^\/trips\/([0-9a-f-]{36})\/hike\/?$/i;

/**
 * Registers the service worker (public/sw.js) that powers offline trip
 * downloads. Registration failures are non-fatal: the app works online and
 * the download screen reports offline support as unavailable.
 *
 * In `next dev` the worker is skipped (its cache-first app files would serve
 * stale code while editing) unless NEXT_PUBLIC_ENABLE_SW_IN_DEV=true; any
 * worker left over from an earlier session is unregistered.
 *
 * It also sends queued hike updates (a finish, "I'm okay", "Extend my trip",
 * location points recorded offline) on EVERY page load while online, when the
 * connection comes back and when the tab becomes visible again — so they do
 * not depend on the hiker reopening the hike screen. The hike screen of the
 * page being shown sends its own queue and is skipped here.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const enabled = process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_ENABLE_SW_IN_DEV === "true";
    if (!enabled) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .catch(() => undefined);
      return;
    }
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      /* offline features will report themselves unavailable */
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    const flush = () => {
      if (disposed || !navigator.onLine) return;
      const open = HIKE_PAGE_RE.exec(window.location.pathname)?.[1];
      void import("@/lib/offline/background-sync")
        .then((m) => m.flushPendingHikeUpdates({ skipTripIds: open ? [open] : [] }))
        .catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") flush();
    };
    // Let the page finish loading first.
    const first = setTimeout(flush, 1_500);
    window.addEventListener("online", flush);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      clearTimeout(first);
      window.removeEventListener("online", flush);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
