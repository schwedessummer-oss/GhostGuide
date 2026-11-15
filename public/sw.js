/*
 * Ghost Guide service worker: KILL SWITCH.
 *
 * Earlier versions registered a caching service worker for offline trip
 * downloads. The app no longer registers any worker; browsers that installed
 * the old one still fetch this file on their next update check. This version:
 *   1. takes over immediately (skipWaiting / clients.claim),
 *   2. deletes every cache whose name starts with "gg-",
 *   3. unregisters itself,
 *   4. reloads open Ghost Guide tabs so they load straight from the network.
 * It has no fetch handler, so it never serves a cached page.
 */
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await self.skipWaiting();
      await clearCaches();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await clearCaches();
      await self.clients.claim();
      await self.registration.unregister();
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      await Promise.all(
        windows.map((client) => (typeof client.navigate === "function" ? client.navigate(client.url).catch(() => undefined) : undefined)),
      );
    })(),
  );
});

async function clearCaches() {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("gg-")).map((key) => caches.delete(key)));
  } catch {
    /* nothing to clear */
  }
}
