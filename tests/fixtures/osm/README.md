# OpenStreetMap / Overpass test fixtures

Used by `tests/unit/trails/osm-*.test.ts`. Tests never touch the network.

## License and attribution

The `*.json` files are real responses from the public Overpass API
(`https://overpass-api.de/api/interpreter`), containing data
© OpenStreetMap contributors, available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
See <https://www.openstreetmap.org/copyright>.

`synthetic.ts` builds made-up responses for edge cases; its coordinates and
tags are invented test data, not OSM data.

## Samples

All samples were fetched on 2026-11-12 with the production query from
`buildOverpassQuery(layer, bbox, { timeoutSec: 120 })`
(`src/server/trails/providers/osm/query.ts`), with the User-Agent
`GhostGuide/0.1 (dev fixtures)`. Bboxes are `[west, south, east, north]`.

| File | Layer | Bbox | OSM snapshot (`timestamp_osm_base`) | What it shows |
|---|---|---|---|---|
| `table-rock-outdoor.json` | outdoor | `[-82.76, 35.02, -82.68, 35.08]` (Table Rock State Park, SC) | 2026-11-12T01:33:19Z | hiking route relations with member geometry, member-way tags, standalone named trails, outdoor POIs |
| `greenville-falls-park-outdoor.json` | outdoor | `[-82.404, 34.844, -82.396, 34.85]` (Falls Park, downtown Greenville, SC) | 2026-11-12T01:37:16Z | urban area: no sidewalks/crossings come back, parking dominates the POIs |

### Pending: services sample

`services-travelers-rest.json` (services layer, bbox
`[-82.47, 34.94, -82.42, 34.99]`, Travelers Rest, SC: restaurants, fuel,
lodging, pharmacies along US 25) could not be fetched yet: from 01:54Z to
03:30Z on 2026-11-12 every connection to overpass-api.de (~45 attempts,
including a plain `GET /api/status`) was reset during the TLS handshake,
while other hosts worked. No substitute data was made up. The query is
`buildOverpassQuery("services", [-82.47, 34.94, -82.42, 34.99], { timeoutSec: 120 })`;
fetch it with the command under "Refreshing", minify it, record its
`timestamp_osm_base` in the table above, and the `services` block in
`osm-fixtures.test.ts` (skipped while the file is missing) runs against it.
Until then, the services layer is covered by synthetic tests
(`osm-parse`, `osm-tags`, `osm-provider`, `osm-query`).

### Edits made to the raw responses

- All files are minified (whitespace only; values unchanged).
- `table-rock-outdoor.json`: the raw response was 745 KB, 299 KB of it the
  full geometry of relation 4572989 (Foothills Trail, 77 mi). To keep the
  fixture under 300 KB, that relation and the 159 tags-only member ways that
  belong only to it were removed. Every other element is unchanged, so the
  file is still a consistent response (the query had already left the
  Foothills Trail's member ways out of the standalone trail ways).

## Refreshing

OSM changes constantly. `osm-fixtures.test.ts` asserts invariants and
named facts (specific routes, POIs, categories) rather than exact element
counts, but a refresh can still change a named fact: check the failures
against the new data before editing a test. To refresh, write the query to a
file (for example with a one-off script that prints
`buildOverpassQuery(...)`), then run:

```sh
curl -sS -A "GhostGuide/0.1 (dev fixtures)" --data-urlencode "data@query.overpassql" \
  https://overpass-api.de/api/interpreter -o raw.json
```

The public instance is slow (~30 s) and sometimes resets connections, so
retry patiently and keep requests sequential. Keep each fixture under 300 KB
and record every edit in this README.
