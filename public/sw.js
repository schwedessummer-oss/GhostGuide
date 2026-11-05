/*
 * Ghost Guide service worker (hand-written, no build step).
 *
 * Caches
 *   gg-static-<version>  /_next/static/* app files, cache-first (versioned; cleaned on activate)
 *   gg-shell-<version>   the /offline fallback page, web manifest and icons (versioned)
 *   gg-trip-v1-<tripId>  one cache per downloaded trip: hike + help pages, their app files,
 *                        the trip bundle and narration audio. Written ONLY when the page asks
 *                        (CACHE_TRIP) so a download can be verified (VERIFY_TRIP) and removed
 *                        (DELETE_TRIP). Trip caches survive service-worker updates.
 *
 * Never cached: Mapbox (api.mapbox.com, *.tiles.mapbox.com, any *.mapbox.com) and every /api/
 * response other than the trip bundle / narration audio the page explicitly stores.
 */
const SW_VERSION = "2026-11-05.1";
const STATIC_CACHE = `gg-static-${SW_VERSION}`;
const SHELL_CACHE = `gg-shell-${SW_VERSION}`;
const TRIP_CACHE_PREFIX = "gg-trip-v1-";
const SHELL_URLS = ["/offline", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png"];
const STATIC_CACHE_MAX_ENTRIES = 400;
const NAVIGATION_TIMEOUT_MS = 6000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_RE = /(?:\/_next\/)?static\/(?:chunks|css|media)\/[^"'\\\s<>()]+?\.(?:js|css|woff2?|ttf|otf|png|svg|jpe?g|webp|avif|ico)(?:\?[^"'\\\s<>()]*)?/g;

const tripCacheName = (tripId) => TRIP_CACHE_PREFIX + tripId;
const isMapbox = (url) => /(^|\.)mapbox\.com$/i.test(url.hostname);
const isSignedStorageUrl = (url) => url.protocol === "https:" && url.pathname.includes("/storage/v1/object/sign/");
const isTripPagePath = (path) => /^\/trips\/[0-9a-f-]{36}\/(hike|help)$/i.test(path);
const isTripBundlePath = (path) => /^\/api\/trips\/[0-9a-f-]{36}\/bundle$/i.test(path);
const isRscRequest = (request, url) => request.headers.get("RSC") === "1" || url.searchParams.has("_rsc");

/** Static app files referenced by a page's HTML (script/link tags and the inline RSC payload). */
function extractAssets(html) {
  const out = new Set();
  for (const m of html.match(ASSET_RE) || []) {
    const path = m.startsWith("/_next/") ? m : `/_next/${m}`;
    if (!path.endsWith(".map")) out.add(path);
  }
  return [...out];
}

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function tripCacheNames() {
  return (await caches.keys()).filter((n) => n.startsWith(TRIP_CACHE_PREFIX));
}

async function matchInTrips(request, options) {
  for (const name of await tripCacheNames()) {
    const hit = await (await caches.open(name)).match(request, options);
    if (hit) return hit;
  }
  return undefined;
}

async function putStatic(request, response) {
  const cache = await caches.open(STATIC_CACHE);
  await cache.put(request, response);
  await trimCache(STATIC_CACHE, STATIC_CACHE_MAX_ENTRIES);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      await Promise.all(
        SHELL_URLS.map(async (u) => {
          try {
            const res = await fetch(u, { credentials: "same-origin", cache: "no-store" });
            if (!res.ok || res.redirected) return;
            if (u === "/offline") {
              const html = await res.clone().text();
              await Promise.all(
                extractAssets(html).map(async (a) => {
                  try {
                    const r = await fetch(a);
                    if (r.ok) await putStatic(a, r);
                  } catch {
                    /* best effort */
                  }
                }),
              );
            }
            await shell.put(u, res);
          } catch {
            /* best effort: install must not fail because one URL is unavailable */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([STATIC_CACHE, SHELL_CACHE]);
      for (const name of await caches.keys()) {
        if (name.startsWith("gg-") && !keep.has(name) && !name.startsWith(TRIP_CACHE_PREFIX)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------------------
// Fetch routing
// ---------------------------------------------------------------------------
async function staticCacheFirst(request) {
  const hit = await caches.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === "basic") await putStatic(request, res.clone());
  return res;
}

async function tripCacheFirst(request) {
  const hit = await matchInTrips(request);
  return hit || fetch(request);
}

async function bundleNetworkFirst(request) {
  try {
    return await fetch(request);
  } catch {
    const hit = await matchInTrips(request);
    if (hit) return hit;
    return new Response(JSON.stringify({ error: "You're offline and this trip isn't downloaded on this device." }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline · Ghost Guide</title></head><body style="font-family:system-ui,sans-serif;background:#faf7f1;color:#1d2420;padding:24px;line-height:1.5">
<h1 style="color:#1f4630">You're offline</h1><p>This page isn't saved on this device. Downloaded trips open from <a href="/trips">My trips</a> once you reconnect, or directly from their hike screen.</p>
<p><strong>In an emergency call 911</strong> if you have any signal. Ghost Guide cannot contact help for you.</p></body></html>`;

async function navigationNetworkFirst(request) {
  const url = new URL(request.url);
  const cached = isTripPagePath(url.pathname) ? await matchInTrips(url.origin + url.pathname, { ignoreSearch: true }) : undefined;
  try {
    // Downloaded trip pages: do not leave a hiker staring at a spinner on a weak signal.
    const res = cached ? await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS) : await fetch(request);
    // A downloaded trip page must stay usable even if the session expired (redirect to
    // sign-in) or the server errors: the page runs from on-device data anyway.
    if (cached && (res.type === "opaqueredirect" || res.redirected || res.status >= 400)) return cached;
    return res;
  } catch {
    if (cached) return cached;
    const offline = await caches.match("/offline");
    return offline || new Response(OFFLINE_HTML, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (isMapbox(url)) return; // never intercept or cache Mapbox tiles/APIs
  if (url.origin !== self.location.origin) {
    if (isSignedStorageUrl(url)) event.respondWith(tripCacheFirst(request)); // narration audio stored for a trip
    return;
  }
  if (isRscRequest(request, url)) return; // never answer an RSC fetch with cached HTML; Next falls back to a full navigation
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(staticCacheFirst(request));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    if (isTripBundlePath(url.pathname)) event.respondWith(bundleNetworkFirst(request));
    else if (url.pathname.startsWith("/api/media/")) event.respondWith(tripCacheFirst(request));
    return; // every other API call: network only, never cached
  }
  if (request.mode === "navigate") {
    event.respondWith(navigationNetworkFirst(request));
    return;
  }
  if (url.pathname.startsWith("/icons/") || url.pathname === "/manifest.webmanifest") {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
  }
});

// ---------------------------------------------------------------------------
// Messages from the page: CACHE_TRIP / VERIFY_TRIP / DELETE_TRIP
// ---------------------------------------------------------------------------
function allowedForTrip(tripId, url) {
  if (isMapbox(url)) return false;
  if (url.origin !== self.location.origin) return isSignedStorageUrl(url);
  const p = url.pathname;
  return (
    p === `/trips/${tripId}/hike` ||
    p === `/trips/${tripId}/help` ||
    p === `/api/trips/${tripId}/bundle` ||
    p === "/offline" ||
    p.startsWith("/_next/static/") ||
    p.startsWith("/api/media/") ||
    p.startsWith("/icons/")
  );
}

async function fetchForCache(url) {
  const sameOrigin = url.origin === self.location.origin;
  return fetch(url.href, { credentials: sameOrigin ? "same-origin" : "omit", cache: "no-store", mode: sameOrigin ? "same-origin" : "cors" });
}

async function cacheTrip(data, reply) {
  const tripId = String(data.tripId || "");
  if (!UUID_RE.test(tripId) || !Array.isArray(data.urls) || data.urls.length > 1000) {
    reply({ type: "ERROR", error: "Invalid CACHE_TRIP request" });
    return;
  }
  const cache = await caches.open(tripCacheName(tripId));
  const results = [];
  const assets = new Set();
  const items = data.urls.map((u) => String(u));
  let done = 0;
  const total = () => items.length + assets.size;

  const store = async (raw, isAsset) => {
    let url;
    try {
      url = new URL(raw, self.location.origin);
    } catch {
      results.push({ url: raw, ok: false, status: 0, error: "invalid url" });
      return;
    }
    if (!allowedForTrip(tripId, url)) {
      results.push({ url: raw, ok: false, status: 0, error: "not allowed" });
      return;
    }
    try {
      const res = await fetchForCache(url);
      if (!res.ok || res.redirected) {
        if (isAsset && res.status === 404) assets.delete(raw); // not a real app file reference
        else results.push({ url: raw, ok: false, status: res.status, error: res.redirected ? "redirected (signed out?)" : "http error" });
        return;
      }
      if (isTripPagePath(url.pathname)) {
        const html = await res.text();
        for (const a of extractAssets(html)) assets.add(a);
        await cache.put(url.href, new Response(html, { status: 200, headers: { "content-type": res.headers.get("content-type") || "text/html; charset=utf-8" } }));
      } else {
        await cache.put(url.href, res);
      }
      results.push({ url: raw, ok: true, status: res.status });
    } catch (err) {
      results.push({ url: raw, ok: false, status: 0, error: String((err && err.message) || err) });
    } finally {
      done++;
      reply({ type: "CACHE_TRIP_PROGRESS", done, total: total() });
    }
  };

  // Pages first (they tell us which app files to store), then everything else, 4 at a time.
  const pages = items.filter((u) => isTripPagePath(new URL(u, self.location.origin).pathname));
  for (const p of pages) await store(p, false);
  const rest = [...items.filter((u) => !pages.includes(u)), ...[...assets].filter((a) => !items.includes(a))];
  const assetSet = new Set(assets);
  for (let i = 0; i < rest.length; i += 4) {
    await Promise.all(rest.slice(i, i + 4).map((u) => store(u, assetSet.has(u))));
  }
  reply({ type: "CACHE_TRIP_RESULT", tripId, results, assets: [...assets] });
}

async function verifyTrip(data, reply) {
  const tripId = String(data.tripId || "");
  const urls = Array.isArray(data.urls) ? data.urls.map((u) => String(u)) : [];
  const present = {};
  const name = tripCacheName(tripId);
  if (UUID_RE.test(tripId) && (await caches.has(name))) {
    const cache = await caches.open(name);
    for (const u of urls) {
      try {
        present[u] = !!(await cache.match(new URL(u, self.location.origin).href));
      } catch {
        present[u] = false;
      }
    }
  } else {
    for (const u of urls) present[u] = false;
  }
  reply({ type: "VERIFY_TRIP_RESULT", tripId, present });
}

async function deleteTrip(data, reply) {
  const tripId = String(data.tripId || "");
  const deleted = UUID_RE.test(tripId) ? await caches.delete(tripCacheName(tripId)) : false;
  reply({ type: "DELETE_TRIP_RESULT", tripId, deleted });
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  const reply = (msg) => {
    if (port) port.postMessage(msg);
    else if (event.source) event.source.postMessage(msg);
  };
  const run = (fn) =>
    event.waitUntil(
      fn(data, reply).catch((err) => reply({ type: "ERROR", error: String((err && err.message) || err) })),
    );
  if (data.type === "CACHE_TRIP") run(cacheTrip);
  else if (data.type === "VERIFY_TRIP") run(verifyTrip);
  else if (data.type === "DELETE_TRIP") run(deleteTrip);
  else if (data.type === "SKIP_WAITING") self.skipWaiting();
});
