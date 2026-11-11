/*
 * Ghost Guide service worker (hand-written, no build step).
 *
 * Caches
 *   gg-static-<version>  /_next/static/* app files, cache-first (versioned; cleaned on activate)
 *   gg-shell-<version>   the /offline fallback page, web manifest and icons (versioned)
 *   gg-trip-v1-<tripId>  one cache per downloaded trip: hike + help pages, their app files,
 *                        the trip bundle and narration audio, plus an owner tag (the account's
 *                        non-secret owner hint). Written ONLY when the page asks (CACHE_TRIP) so a
 *                        download can be verified (VERIFY_TRIP) and removed (DELETE_TRIP); sign-out
 *                        removes them all (CLEAR_ALL). Trip caches survive service-worker updates.
 *                        Narration audio is stored under a STABLE key, /__gg/audio/<narrationId>/v<n>
 *                        (the signed URL it was fetched from changes with every bundle), and served
 *                        from there; older downloads keyed by signed URL still match ignoring the query.
 *
 * Background Sync (best effort, Chromium-based browsers only): when the page queues hike data it
 * registers the "gg-outbox" sync tag; when connectivity returns the browser may wake this worker,
 * which sends queued hike updates (start, location points, events incl. "I'm okay" / extend, then
 * finish) from IndexedDB `ghostguide` with the signed-in cookies. Nothing is deleted unless the
 * server accepted it. Browsers can delay or skip this; the pages also send on every load.
 *
 * Shared devices: a cached trip page is only a stand-in when the network fails, the session
 * expired (sign-in redirect) or the server errors — never for a 404 (another account) — and,
 * where the browser lets the worker read cookies, only while the `gg_owner` cookie matches the
 * trip's owner tag. The pages themselves also refuse to show another account's on-device data.
 *
 * Never cached: Mapbox (api.mapbox.com, *.tiles.mapbox.com, any *.mapbox.com) and every /api/
 * response other than the trip bundle / narration audio the page explicitly stores.
 */
const SW_VERSION = "2026-11-11.2";
const STATIC_CACHE = `gg-static-${SW_VERSION}`;
const SHELL_CACHE = `gg-shell-${SW_VERSION}`;
const TRIP_CACHE_PREFIX = "gg-trip-v1-";
const SHELL_URLS = ["/offline", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png"];
const STATIC_CACHE_MAX_ENTRIES = 400;
const NAVIGATION_TIMEOUT_MS = 6000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_COOKIE = "gg_owner"; // src/server/auth/owner-hint.ts
const OWNER_HINT_RE = /^[A-Za-z0-9_-]{8,128}$/;
const OWNER_MARKER_PATH = "/__gg/trip-owner"; // stored inside each trip cache; never requested by pages
const AUDIO_KEY_RE = /^\/__gg\/audio\/[0-9a-f-]{36}\/v\d{1,9}$/i; // src/domain/offline-manifest.ts audioCacheKey
const OUTBOX_SYNC_TAG = "gg-outbox";
const ASSET_RE = /(?:\/_next\/)?static\/(?:chunks|css|media)\/[^"'\\\s<>()]+?\.(?:js|css|woff2?|ttf|otf|png|svg|jpe?g|webp|avif|ico)(?:\?[^"'\\\s<>()]*)?/g;

const tripCacheName = (tripId) => TRIP_CACHE_PREFIX + tripId;
const isMapbox = (url) => /(^|\.)mapbox\.com$/i.test(url.hostname);
const isSignedStorageUrl = (url) => url.protocol === "https:" && url.pathname.includes("/storage/v1/object/sign/");
const isTripPagePath = (path) => /^\/trips\/[0-9a-f-]{36}\/(hike|help)$/i.test(path);
const isTripBundlePath = (path) => /^\/api\/trips\/[0-9a-f-]{36}\/bundle$/i.test(path);
const tripIdOf = (path) => (path.match(/^\/(?:api\/)?trips\/([0-9a-f-]{36})\//i) || [])[1] || null;
const ownerMarkerUrl = () => new URL(OWNER_MARKER_PATH, self.location.origin).href;
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

/**
 * May the person signed in on this browser use this trip's cached copy?
 * true / false when the worker can read the `gg_owner` cookie (Cookie Store API) and the
 * trip cache has an owner tag; null when it can't tell (the page then checks for itself).
 */
async function ownerMayUse(tripId) {
  const store = self.cookieStore;
  if (!tripId || !store || typeof store.get !== "function") return null;
  let value = null;
  try {
    const c = await store.get(OWNER_COOKIE);
    value = c && c.value ? decodeURIComponent(c.value) : null;
  } catch {
    return null;
  }
  if (!value) return false; // signed out on this browser
  try {
    const marker = await (await caches.open(tripCacheName(tripId))).match(ownerMarkerUrl());
    if (!marker) return null; // downloaded before owner tags existed
    return (await marker.text()) === value;
  } catch {
    return null;
  }
}

async function putStatic(request, response) {
  const cache = await caches.open(STATIC_CACHE);
  await cache.put(request, response);
  await trimCache(STATIC_CACHE, STATIC_CACHE_MAX_ENTRIES);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
/** The public offline fallback, manifest and icons (fetched signed-out: nothing personal is stored). */
async function precacheShell() {
  const shell = await caches.open(SHELL_CACHE);
  await Promise.all(
    SHELL_URLS.map(async (u) => {
      try {
        const res = await fetch(u, { credentials: "omit", cache: "no-store" });
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
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await precacheShell();
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
  // Signed URLs change with every bundle: an exact match first, then the same file ignoring the signature.
  const hit = (await matchInTrips(request)) || (await matchInTrips(request, { ignoreSearch: true }));
  return hit || fetch(request);
}

/** Narration audio by its stable key: only ever from a trip cache (404 → the page falls back to the signed URL). */
async function stableAudio(request) {
  const hit = await matchInTrips(request, { ignoreSearch: true });
  return hit || new Response("Not downloaded", { status: 404, headers: { "content-type": "text/plain", "x-gg-offline": "1" } });
}

/** A cached answer, marked so the page knows it did not come from the server just now. */
function markedFromCache(res) {
  const headers = new Headers(res.headers);
  headers.set("x-gg-source", "cache");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function bundleNetworkFirst(request) {
  try {
    return await fetch(request);
  } catch {
    const hit = await matchInTrips(request);
    if (hit && (await ownerMayUse(tripIdOf(new URL(request.url).pathname))) !== false) return markedFromCache(hit);
    return new Response(JSON.stringify({ error: "You're offline and this trip isn't downloaded on this device." }), {
      status: 503,
      headers: { "content-type": "application/json", "x-gg-offline": "1" },
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

async function offlineFallback() {
  const offline = await caches.match("/offline");
  return offline || new Response(OFFLINE_HTML, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function navigationNetworkFirst(request) {
  const url = new URL(request.url);
  const tripId = isTripPagePath(url.pathname) ? tripIdOf(url.pathname) : null;
  const cached = tripId ? await matchInTrips(url.origin + url.pathname, { ignoreSearch: true }) : undefined;
  let res;
  try {
    // Downloaded trip pages: do not leave a hiker staring at a spinner on a weak signal.
    res = cached ? await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS) : await fetch(request);
  } catch {
    // No connection (or too slow): the downloaded page runs from on-device data — for its owner.
    if (cached && (await ownerMayUse(tripId)) !== false) return cached;
    return offlineFallback();
  }
  if (!cached) return res;
  // The session expired on the trail (sign-in redirect) or the server errors: keep the downloaded
  // page usable for the same person. Never for a 404 (a different signed-in account), and not
  // after an explicit sign-out (no owner cookie): then the network's answer (sign-in) is shown.
  const authRedirect = res.type === "opaqueredirect" || res.redirected;
  if ((authRedirect || res.status >= 500) && (await ownerMayUse(tripId)) !== false) return cached;
  return res;
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
  if (url.pathname.startsWith("/__gg/")) {
    if (AUDIO_KEY_RE.test(url.pathname)) event.respondWith(stableAudio(request));
    else event.respondWith(new Response("Not found", { status: 404 }));
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
// Messages from the page: CACHE_TRIP / VERIFY_TRIP / DELETE_TRIP / CLEAR_ALL
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
  if (typeof data.ownerHint === "string" && OWNER_HINT_RE.test(data.ownerHint)) {
    await cache.put(ownerMarkerUrl(), new Response(data.ownerHint, { headers: { "content-type": "text/plain" } }));
  }
  const results = [];
  const assets = new Set();
  // Items are URLs, or { url, as } to store a response under a stable key (narration audio).
  const storeAs = new Map();
  const items = data.urls.map((u) => {
    if (u && typeof u === "object") {
      const raw = String(u.url);
      if (typeof u.as === "string" && AUDIO_KEY_RE.test(u.as)) storeAs.set(raw, u.as);
      return raw;
    }
    return String(u);
  });
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
      } else if (storeAs.has(raw)) {
        // Narration audio under its stable key (a plain 200 with the content type).
        const body = await res.blob();
        await cache.put(new URL(storeAs.get(raw), self.location.origin).href, new Response(body, { status: 200, headers: { "content-type": res.headers.get("content-type") || "audio/mpeg" } }));
      } else {
        await cache.put(url.href, res);
      }
      results.push({ url: raw, ok: true, status: res.status, as: storeAs.get(raw) });
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

/**
 * Sign-out (src/app/auth/logout/route.ts): remove every downloaded trip — pages, bundle with the
 * itinerary and check-in details, narration audio. The static app files and the public offline
 * page hold nothing personal; the offline page is re-stored in case the page already cleared it.
 */
async function clearAll(_data, reply) {
  let deleted = 0;
  for (const name of await tripCacheNames()) if (await caches.delete(name)) deleted++;
  await precacheShell().catch(() => undefined);
  reply({ type: "CLEAR_ALL_RESULT", deleted });
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
  else if (data.type === "CLEAR_ALL") run(clearAll);
  else if (data.type === "SKIP_WAITING") self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Background Sync (best effort): send queued hike updates when connectivity returns,
// even if no Ghost Guide page is open. Mirrors src/lib/offline/outbox.ts (start → points/events
// in recording order, ≤ 500 points / ≤ 200 events per request → finish). Conservative: entries
// are deleted only when the server acknowledged them; any error leaves everything queued for the
// pages (which also send on every load and report problems to the hiker).
// ---------------------------------------------------------------------------
const IDB_NAME = "ghostguide"; // src/lib/offline/idb.ts
const IDB_VERSION = 1;
const SYNC_MAX_POINTS = 500;
const SYNC_MAX_EVENTS = 200;
const SYNC_MAX_BATCHES = 10;

/** Open the pages' database only if it already exists with the expected schema (never create it here). */
function idbOpenExisting() {
  return new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(IDB_NAME, IDB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      try {
        req.transaction.abort(); // no database yet: the pages own its schema
      } catch {
        /* ignore */
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

const idbReq = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const idbDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

const tripRange = (tripId) => IDBKeyRange.bound([tripId, -Infinity], [tripId, Infinity]);

/** The signed-in account's owner hint; null = signed out; undefined = this browser can't tell. */
async function swOwnerHint() {
  const store = self.cookieStore;
  if (!store || typeof store.get !== "function") return undefined;
  try {
    const c = await store.get(OWNER_COOKIE);
    return c && c.value ? decodeURIComponent(c.value) : null;
  } catch {
    return undefined;
  }
}

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, ok: res.ok, data };
  } catch {
    return { status: 0, ok: false, data: null };
  }
}

const retryable = (status) => status === 0 || status === 408 || status === 429 || status >= 500;

/** Patch the stored hike state (sync bookkeeping only). `updatedAt` is left alone so a newer on-page copy still wins. */
async function patchHikeState(db, tripId, patchFn) {
  const tx = db.transaction("hikeState", "readwrite");
  const store = tx.objectStore("hikeState");
  const cur = await idbReq(store.get(tripId));
  if (cur && cur.version === 1) store.put({ ...cur, ...patchFn(cur) });
  await idbDone(tx);
}

async function flushTripFromWorker(db, state) {
  const tripId = state.tripId;
  const sentAt = () => new Date().toISOString();
  let sessionId = state.serverSessionId;
  let outcome = "done";
  const patch = {};
  let dropped = 0;
  if (!state.startSynced) {
    const r = await postJson("/api/hike/start", {
      tripId,
      clientSessionId: state.localSessionId || undefined,
      startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : undefined,
      demoStartAnyway: state.demoStartAnyway || undefined,
      sentAt: sentAt(),
    });
    if (!r.ok || !r.data || !r.data.session) return retryable(r.status) ? "retry" : "stop";
    sessionId = r.data.session.id;
    Object.assign(patch, { serverSessionId: sessionId, startSynced: true, startError: null });
  }
  if (!sessionId) return "stop";

  for (let i = 0; i < SYNC_MAX_BATCHES; i++) {
    const entries = await idbReq(db.transaction("outbox", "readonly").objectStore("outbox").index("byTripSeq").getAll(tripRange(tripId), 800));
    if (!entries.length) break;
    entries.sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1));
    const points = [];
    const events = [];
    const ids = [];
    for (const e of entries) {
      if (e.kind === "point") {
        if (points.length >= SYNC_MAX_POINTS) break;
        points.push({ id: e.id, ...e.payload });
      } else {
        if (events.length >= SYNC_MAX_EVENTS) break;
        events.push({ id: e.id, ...e.payload });
      }
      ids.push(e.id);
    }
    const progressM = Math.round((state.progress && state.progress.alongM) || 0);
    const r = await postJson("/api/hike/sync", { sessionId, points, events, progressM, sentAt: sentAt() });
    if (!r.ok || !r.data) {
      outcome = retryable(r.status) ? "retry" : "stop";
      break;
    }
    const rejected = Array.isArray(r.data.rejected) ? r.data.rejected.map((x) => x.id) : [];
    const acked = new Set([...(r.data.acceptedPointIds || []), ...(r.data.acceptedEventIds || []), ...rejected]);
    const tx = db.transaction("outbox", "readwrite");
    const store = tx.objectStore("outbox");
    for (const id of acked) store.delete(id);
    await idbDone(tx);
    dropped += rejected.length;
    patch.lastSyncAt = Date.now();
    if (ids.some((id) => !acked.has(id))) {
      outcome = "stop";
      break;
    }
  }

  if (outcome === "done" && state.finishPending) {
    const left = await idbReq(db.transaction("outbox", "readonly").objectStore("outbox").index("byTripSeq").count(tripRange(tripId)));
    if (left === 0) {
      const r = await postJson("/api/hike/finish", {
        tripId,
        sessionId,
        finishedAt: state.finishedAt ? new Date(state.finishedAt).toISOString() : undefined,
        distanceCompletedM: Math.round((state.progress && state.progress.alongM) || 0),
        sentAt: sentAt(),
      });
      if (r.ok) Object.assign(patch, { finishPending: false, finishSynced: true });
      else outcome = retryable(r.status) ? "retry" : "stop";
    }
  }
  if (Object.keys(patch).length || dropped) {
    await patchHikeState(db, tripId, (cur) => ({
      ...patch,
      ...(dropped ? { droppedCount: (cur.droppedCount || 0) + dropped, droppedAt: Date.now() } : {}),
    })).catch(() => undefined);
  }
  return outcome;
}

async function flushOutboxFromWorker() {
  const owner = await swOwnerHint();
  if (owner === null) return; // signed out on this browser: nothing can be sent
  const db = await idbOpenExisting();
  if (!db) return;
  let retry = false;
  try {
    if (!db.objectStoreNames.contains("hikeState") || !db.objectStoreNames.contains("outbox")) return;
    const states = await idbReq(db.transaction("hikeState", "readonly").objectStore("hikeState").getAll());
    for (const state of states) {
      if (!state || state.version !== 1 || !state.tripId || state.status === "not_started") continue;
      // Only the signed-in account's hikes (when the worker can read the owner cookie).
      if (owner !== undefined && state.ownerHint !== owner) continue;
      const run = () => flushTripFromWorker(db, state);
      const locks = self.navigator && self.navigator.locks;
      const outcome =
        locks && typeof locks.request === "function"
          ? await locks.request(`gg-outbox-${state.tripId}`, { ifAvailable: true }, (lock) => (lock ? run() : "busy"))
          : await run();
      if (outcome === "retry") retry = true;
    }
  } finally {
    db.close();
  }
  // Ask the browser to try again later (it applies its own backoff and limits).
  if (retry) throw new Error("Some hike updates could not be sent yet");
}

self.addEventListener("sync", (event) => {
  if (event.tag === OUTBOX_SYNC_TAG) event.waitUntil(flushOutboxFromWorker());
});
