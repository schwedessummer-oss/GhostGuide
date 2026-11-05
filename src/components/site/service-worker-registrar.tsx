"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (public/sw.js) that powers offline trip
 * downloads. Registration failures are non-fatal: the app works online.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* offline features will report themselves unavailable */
    });
  }, []);
  return null;
}
