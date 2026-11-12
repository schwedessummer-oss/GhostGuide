# Nominatim test fixtures

Used by `tests/unit/geo/geocode*.test.ts` and
`tests/integration/trails/{search-geocode,api}.test.ts` (served through a
stubbed `fetch`). Tests never touch the network.

## License and attribution

These files are real, unedited responses from the public Nominatim instance
(`https://nominatim.openstreetmap.org`). They contain data
© OpenStreetMap contributors, available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
See <https://www.openstreetmap.org/copyright>.

## Samples

Fetched once on 2026-11-12, sequentially with ≥ 1.5 s between requests
(Nominatim policy: max 1 request/second), User-Agent
`GhostGuide/0.1 (dev fixtures)`, with the production parameters of
`src/server/geo/geocode.ts`:

- search: `/search?format=jsonv2&q=<q>&limit=6&addressdetails=1&accept-language=en`
- reverse: `/reverse?format=jsonv2&lat=<lat>&lon=<lon>&zoom=10&addressdetails=1&accept-language=en`

| File | Request | What it shows |
|---|---|---|
| `search-banff.json` | search `q=Banff` | two towns with the same name in two countries (boundary relation with `addresstype=town`; place node) |
| `search-mount-fuji.json` | search `q=Mount Fuji` | `natural=volcano` and `natural=peak` results; Japanese `province` as the region; point-sized bounding boxes |
| `search-columbia-sc.json` | search `q=Columbia SC` | a city (boundary relation, `addresstype=city`) with county and state |
| `search-banff-national-park.json` | search `q=Banff National Park` | a park mapped as `leisure=nature_reserve` |
| `search-great-smoky-mountains.json` | search `q=Great Smoky Mountains` | weak matches (a chalet, an events venue) that map to kind `place` |
| `search-no-results.json` | search `q=xqzvvkjh nowhere` | an empty answer (`[]`) |
| `reverse-table-rock.json` | reverse `lat=35.05&lon=-82.72` (Table Rock State Park, SC) | a zoom-10 answer at county level: no city/town in the address |

## Refreshing

Values change as OSM is edited, so a refresh may change expected values in
the tests. Refresh one file at a time, for example:

```sh
curl -sS -A "GhostGuide/0.1 (dev fixtures)" -G https://nominatim.openstreetmap.org/search \
  --data-urlencode format=jsonv2 --data-urlencode "q=Banff" --data-urlencode limit=6 \
  --data-urlencode addressdetails=1 --data-urlencode accept-language=en -o search-banff.json
```

Keep requests sequential and at least one second apart, never script bulk
or autocomplete-style requests against the public instance, keep each file
small, and record any edit here.
