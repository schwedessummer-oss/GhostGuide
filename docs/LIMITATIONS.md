# Known data & platform limitations

Ghost Guide is a website for finding and planning hikes. It is **not an emergency service**: it
does not track or monitor hikers, works only with a connection, and cannot contact Search and
Rescue. The site says so on `/how-it-works`. The earlier GPS hike screen, offline downloads and
safety check-ins were removed (see `docs/PLAN.md` §2).

## Trail data (Phase 1, real data)
- **Coverage depends on OpenStreetMap.** Ghost Guide shows *named* hiking routes and named paths;
  unnamed paths are not listed as trails. Data quality varies by country and area, so every trail
  page shows its source, license and last sync time, and links to the OSM feature to fix it there.
- **First search of an area takes time.** Areas load on demand from the public Overpass API, which
  can take 30–90 s or be temporarily unavailable. The UI says "Loading trails for this area…" or
  "could not be loaded right now"; it never shows placeholder trails. Very large areas must be
  zoomed into before they load (more than 16 tiles of about 28 km each); until then only trails
  already loaded near the middle of the area are listed, and the UI says so.
- **Loading is rationed** to protect the free providers: each search queues at most 4 new tiles
  (nearest the middle first, so an area fills in as you watch), one visitor (IP, IPv6 /64) can start
  at most 32 tile loads per 10 minutes, searches stop queuing new loads once 150 loads that people
  asked for are waiting or running (background refreshes only use room left below that), and a
  load nobody has asked about for 20 minutes is dropped. Past a limit, already-loaded trails are
  still shown with an explanation.
- **Route shape is inferred.** Loop / one-way / network comes from the mapped geometry. One-way
  routes are measured from the trailhead and shown as out-and-back totals, the usual way they are
  hiked. Trails split across tile edges are merged by name and proximity, which is rarely imperfect.
- **Elevation is an estimate** from terrain tiles, sampled on a ~30 m grid (the source data's own
  resolution varies by region), smoothed with a 3 m threshold. Short, steep climbs can be
  under-counted.
- **Times are moving-time estimates** (Tobler's hiking function on the elevation profile, average
  pace, no breaks). Without elevation data, moving time is distance at a flat 4.5 km/h with no time
  for climbing, and the trail page, Explore and the daylight planning say "distance only".
- **Difficulty** comes from the OSM SAC grade when mapped, otherwise from distance and climb
  (marked "estimated"). Trails without climb data stay unrated unless the SAC grade or the distance
  alone decides.
- **Trailheads** come from OSM trailhead nodes, else the nearest mapped parking within 300 m of a
  route end, else the route start (labeled).
- **Nearby services** are OSM points of interest. Distances are straight-line, ratings are not
  available, and opening hours are as mapped by volunteers.
- **Weather:** forecasts are model output from MET Norway. Official alerts are shown only in the US
  (NWS); elsewhere the page says alerts are not available. Sun times assume a flat horizon.
- **Fees and permits** are shown only when the source says so. Otherwise the page says "unknown —
  check with the land manager".
- **Country** comes from the trail's exact point with offline, generalised borders, so it can be
  wrong within a few hundred metres of a land border. **Region and nearest place** come from reverse
  geocoding on a ~11 km grid and are left blank when that grid cell lies in another country. A
  trail's page path uses "unknown" for the region while names are still loading, and keeps it when
  the region is left blank (for example near a border, or where the geocoder gives no region); once
  a region is named, the old path permanently redirects to the new one.
- **Maps:** terrain shading is drawn only on wide maps (768 px or more) from zoom 10, never on
  Explore or when the browser asks to save data.
- **Caching:** trail pages are cached and rebuilt at most once an hour, and only when
  someone visits: the first visit after the hour still gets the older copy (for a rarely viewed
  trail it can be days old) and starts the rebuild. Live parts (forecast, daylight, nearby services,
  Save) load in the browser and are never part of the cached page, and the page shows the sync time
  as a date, not "… ago". A trail hidden by moderation leaves its page at once and search results
  within about 2 minutes; a trail whose path moves redirects at once.

## Service worker
- Earlier versions installed an offline service worker. `public/sw.js` is now a kill switch: a
  browser that still has the old worker picks up the new file on its next update check, deletes the
  `gg-*` caches, unregisters it and reloads open tabs. Until that check happens (usually on the next
  visit), such a browser may show one stale page.
