# End-to-end mock provider fixtures

Served by `tests/e2e/mock-providers.mjs`, which `tests/e2e/run.mjs` starts
in place of the real data providers. The e2e suite never touches the
network. Every file is a real, recorded provider answer. Nothing here is
invented, and the edits below are the only changes.

## Licences and attribution

| Folder | Source | Licence / attribution |
|---|---|---|
| `osm/` | Overpass API (`overpass-api.de`) | © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), <https://www.openstreetmap.org/copyright> |
| `nominatim/` | Nominatim (`nominatim.openstreetmap.org`) | © OpenStreetMap contributors, ODbL 1.0 |
| `metno/` | MET Norway Locationforecast 2.0 | Weather data from MET Norway, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `nws/` | US National Weather Service (`api.weather.gov`) | US Government work (public domain) |
| `terrain/` | AWS Open Data Terrain Tiles (Terrarium), <https://registry.opendata.aws/terrain-tiles/> | Mapzen/Tilezen "joerd" tiles; for these US tiles the data is USGS 3DEP / NED (public domain). Full attribution: <https://github.com/tilezen/joerd/blob/master/docs/attribution.md>. No OSM data. |

## Files

Copied unchanged from `tests/fixtures` (see the README in each of those
folders for how they were fetched). They are copied, not shared, so that a
refresh of the unit-test fixtures cannot silently change e2e expectations:

- `osm/table-rock-outdoor.json`: outdoor layer for Table Rock State Park, SC.
  Overpass bbox `[-82.76, 35.02, -82.68, 35.08]`, snapshot
  2026-11-12T01:33:19Z. The Foothills Trail relation was removed to keep the
  file small (see `tests/fixtures/osm/README.md`).
- `metno/complete-table-rock-sc.json`, `metno/complete-banff-ab.json`
- `nws/alerts-active-table-rock-sc.json`: no active alerts (an empty FeatureCollection).
- `nominatim/search-banff.json`

Recorded for the e2e suite on 2026-11-12, sequentially (at least 2 s between
Nominatim requests), with User-Agent `GhostGuide/0.1 (dev fixtures)` and the
production request parameters. The files are unedited.

- `nominatim/search-table-rock-state-park.json`: search `q=Table Rock State Park`
  (`/search?format=jsonv2&limit=6&addressdetails=1&accept-language=en`). The
  first result is the SC park (`boundary=protected_area`), the second a
  Missouri park.
- `nominatim/search-table-rock.json`: search `q=Table Rock`. The first result is
  a hamlet in Pennsylvania, and there are five more places.
- `nominatim/reverse-35.0_-82.7.json`, `reverse-35.0_-82.8.json`,
  `reverse-35.1_-82.7.json`: reverse geocoding
  (`/reverse?format=jsonv2&zoom=10&addressdetails=1&accept-language=en`) of the
  0.1° cell centres that ingestion asks about for the Table Rock trails. The
  first two return Pickens County, SC, and the third returns Transylvania
  County, NC. Cells without a recording get HTTP 503 from the mock, so the app
  stores no admin names for them; nothing is guessed.
- `terrain/terrarium-12-{1105..1107}-{1620..1622}.png`: the nine zoom-12
  Terrarium tiles around Table Rock State Park, downloaded from
  `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/12/{x}/{y}.png`. The
  files are byte-for-byte as served. They cover every trail in
  `osm/table-rock-outdoor.json`, including the neighbours needed for bilinear
  sampling at tile edges. The explore spec asserts that no generated (flat)
  tile was ever needed.

## How the mock adapts the recordings

- **Overpass:** the Table Rock response is returned for the 0.25° catalog tile
  that contains (-82.72, 35.05), key `0.25/389/500`. Every other tile, and the
  services layer, gets a valid answer with no elements. No services sample has
  been recorded, so the trail page honestly shows that no services are mapped.
- **MET Norway:** if "now" has moved past the first day of the recording, every
  `time` and `meta.updated_at` is moved forward by **whole days**, so the
  hourly part still covers the current hour. Values and the day/night symbol
  alignment are unchanged. On 2026-11-12 no shift is applied. `Expires` is set
  one hour ahead and `Last-Modified` is `meta.updated_at`.
- **Terrain:** a tile without a recording is answered with a generated flat
  tile at 0 m, and the mock logs it as `flat`.

## Refreshing

Follow the "Refreshing" sections of the READMEs in `tests/fixtures/*`. Keep
requests rare and sequential with an identifying User-Agent, keep files
unedited, and record any change here. If a refresh changes the Table Rock
trails, check `tests/e2e/specs/explore.spec.mjs` and `trail.spec.mjs`. They
assert named facts, such as "Table Rock Trail" being an out & back hike with a
known climb, rather than exact counts.
