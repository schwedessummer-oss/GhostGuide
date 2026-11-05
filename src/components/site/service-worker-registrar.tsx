"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (public/sw.js) that powers offline trip
 * downloads. Registration failures are non-fatal: the app works online and
 * the download screen reports offline support as unavailable.
 *
 * In `next dev` the worker is skipped (its cache-first app files would serve
 * stale code while editing) unless NEXT_PUBLIC_ENABLE_SW_IN_DEV=true; any
 * worker left over from an earlier session is unregistered.
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
  return null;
}
