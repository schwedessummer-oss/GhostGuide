import { signOut } from "@/server/auth";

/**
 * Sign out and wipe this device's offline Ghost Guide data.
 *
 * Downloaded trips (IndexedDB "ghostguide", Cache Storage "gg-*") can hold
 * the itinerary, check-in details, the last device location and queued
 * location points. On a shared device the next person must not see them, so
 * the response (a) sends Clear-Site-Data for supporting browsers and (b) runs
 * a small script that deletes the caches and the database explicitly (Safari
 * and older browsers ignore parts of Clear-Site-Data), then goes home.
 */
const CLEANUP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signing out · Ghost Guide</title>
<noscript><meta http-equiv="refresh" content="0;url=/"></noscript>
<style>body{font-family:system-ui,sans-serif;background:#faf7f1;color:#1d2420;display:grid;place-items:center;min-height:100vh;margin:0}</style>
</head><body><p role="status">Signing you out and removing trip data saved on this device…</p>
<script>
(async function () {
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter(function (k) { return k.indexOf("gg-") === 0; }).map(function (k) { return caches.delete(k); }));
    }
  } catch (e) {}
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: "CLEAR_ALL" });
  } catch (e) {}
  try {
    await new Promise(function (resolve) {
      var req = indexedDB.deleteDatabase("ghostguide");
      req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
      setTimeout(resolve, 1500);
    });
  } catch (e) {}
  try {
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var k = localStorage.key(i);
      if (k && (k.indexOf("gg") === 0 || k.indexOf("ghostguide") === 0)) localStorage.removeItem(k);
    }
  } catch (e) {}
  location.replace("/");
})();
</script></body></html>`;

export async function POST(request: Request) {
  // Same-origin check: logout is state-changing.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return new Response("Forbidden", { status: 403 });
  }
  await signOut();
  return new Response(CLEANUP_PAGE, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Clear-Site-Data": '"cache", "storage"',
    },
  });
}
