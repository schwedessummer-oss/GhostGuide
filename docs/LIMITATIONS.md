# Known mobile, offline & platform limitations

Ghost Guide's customer app is an installable **Progressive Web App**. A PWA runs inside the mobile
browser's sandbox, so several capabilities a hiking companion would ideally have are **not reliably
available**. The product says this to customers on the pre-hike screen and on `/how-it-works`, and
never presents these as guaranteed.

## Trail data (Phase 1, real data)
- **Coverage depends on OpenStreetMap.** Ghost Guide shows *named* hiking routes and named paths;
  unnamed paths are not listed as trails. Data quality varies by country and area, so every trail
  page shows its source, license and last sync time, and links to the OSM feature to fix it there.
- **First search of an area takes time.** Areas load on demand from the public Overpass API, which
  can take 30–90 s or be temporarily unavailable. The UI says "Loading trails for this area…" or
  "could not be loaded right now"; it never shows placeholder trails. Very large areas must be
  zoomed into before they load (more than 16 tiles of about 28 km each).
- **Route shape is inferred.** Loop / one-way / network comes from the mapped geometry. One-way
  routes are measured from the trailhead and shown as out-and-back totals, the usual way they are
  hiked. Trails split across tile edges are merged by name and proximity, which is rarely imperfect.
- **Elevation is an estimate** from terrain tiles (about 30 m grid; the underlying DEM is 10–90 m
  depending on region), smoothed with a 3 m threshold. Short, steep climbs can be under-counted.
- **Times are moving-time estimates** (Tobler's hiking function on the elevation profile, average
  pace, no breaks). **Difficulty** comes from the OSM SAC grade when mapped, otherwise from distance
  and climb (marked "estimated").
- **Trailheads** come from OSM trailhead nodes, else the nearest mapped parking within 300 m of a
  route end, else the route start (labeled).
- **Nearby services** are OSM points of interest. Distances are straight-line, ratings are not
  available, and opening hours are as mapped by volunteers.
- **Weather:** forecasts are model output from MET Norway. Official alerts are shown only in the US
  (NWS); elsewhere the page says alerts are not available. Sun times assume a flat horizon.
- **Fees and permits** are shown only when the source says so. Otherwise the page says "unknown —
  check with the land manager".
- **Region names** come from reverse geocoding on a ~11 km grid, so near borders the region or
  nearest town can be the neighbouring one.

## Location (GPS)
- **Foreground only.** Browsers deliver `watchPosition` updates while the page is visible. When the
  screen locks or another app is in front, iOS Safari and Android Chrome may pause or throttle
  location updates. There is no web API for dependable background location.
- **Accuracy varies** (canopy, canyons, cold starts). The app filters poor-accuracy fixes, requires
  persistence before deviation prompts, and gates geofences on accuracy, but it cannot make a weak
  fix accurate.
- **Wake Lock** (keep screen on) is requested during an active hike where supported; support and
  battery cost vary, and the OS can still release it.

## Audio
- Narration plays while the page is in the foreground. **Screen-locked/background audio is not
  guaranteed**, especially on iOS. Device text-to-speech voices vary and may be missing offline.
- Every narration has a visible transcript; audio is never the only channel.

## Offline
- After "Download trip", the bundle (route geometry, POIs, approved narration, emergency info) is in
  IndexedDB and the hike/help pages are in the service-worker cache. The download screen verifies
  completeness (presence + checksums) and offers retry.
- **Storage can be evicted** by the browser under storage pressure (persistent storage is requested
  but may be denied). Re-check the download on the morning of the hike.
- **No offline basemap.** The offline view draws the route and POIs without map tiles. Basemap tiles
  are not cached (tile terms); offline maps need a licensed offline package or a self-hosted
  vector extract (e.g. Protomaps PMTiles) — planned with Phase 4 offline packages.
- Location points and events recorded offline are **queued and synced** when connectivity returns.
  Until then, the server (and therefore check-in notices) only knows the last location it received.
- **Offline notifications are not guaranteed.** Reminders are shown in-app while the page is open;
  web push needs connectivity and OS permission and is not used for safety-critical delivery.

## Check-ins
- Overdue detection runs on the server and needs the per-minute job trigger (see DEPLOYMENT.md).
- A notice to the emergency contact includes the **last location the server received** with its
  timestamp and accuracy, and is labeled stale when old. If the hiker was offline, it may be far
  from their current position.
- SMS/email delivery depends on carriers and providers; failures are retried and shown to staff.

## What a native client would add (deferred)
- Dependable background location (iOS Core Location background modes / Android foreground service).
- Background and lock-screen audio sessions.
- Local notifications for reminders without connectivity.
- Licensed offline map packs.
- Satellite-messenger integrations via vendor SDKs, if and when partner access is approved.

The API surface (`/api/trips/[id]/bundle`, `/api/hike/start|sync|finish`, idempotent client event IDs,
outbox semantics) is designed so a native client can reuse it unchanged.
