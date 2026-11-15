# Known data & platform limitations

Ghost Guide is a website for finding and planning hikes. It is **not an emergency service**: it
does not track or monitor hikers, works only with a connection, and cannot contact Search and
Rescue. The earlier GPS hike screen, offline downloads and
safety check-ins were removed (see `docs/PLAN.md` §2).

## Hike data
- There is no hike catalog yet. The home page says so. The curated catalog will be loaded by an offline
  ingestion pipeline and reviewed before publication (`docs/PLAN.md` §3 and §4); visitors never trigger
  calls to data providers.
- The earlier on-demand OpenStreetMap catalog, Explore, trail pages, saved trails and trail weather were
  removed. Old `/trail/...` URLs answer 410 Gone.

## Service worker
- Earlier versions installed an offline service worker. `public/sw.js` is now a kill switch: a
  browser that still has the old worker picks up the new file on its next update check, deletes the
  `gg-*` caches, unregisters it and reloads open tabs. Until that check happens (usually on the next
  visit), such a browser may show one stale page.
