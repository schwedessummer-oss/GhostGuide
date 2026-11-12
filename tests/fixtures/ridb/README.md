# Recreation.gov RIDB fixtures

Used by `tests/unit/trails/ridb*.test.ts` (served through a mocked
`providerFetch`). Tests never touch the network.

## What these are (and are not)

**These are NOT recorded RIDB responses.** The RIDB API requires an API key,
which this project did not have when the provider was written. The fixtures
were built by hand to follow the documented response schema exactly:

- OpenAPI spec: <https://ridb.recreation.gov/shared/swagger/ridb.yaml>
  (rendered at <https://ridb.recreation.gov/docs>), read on 2026-11-12.
- Endpoint: `GET /api/v1/facilities` (`getFacilities`) with `latitude`,
  `longitude`, `radius` (miles, maximum 25), `limit` (maximum 50) and
  `offset`; the key goes in the `apikey` header.
- Response: `{ "RECDATA": Facility[], "METADATA": { "RESULTS":
  { "CURRENT_COUNT", "TOTAL_COUNT" }, "PARAMETERS": { "QUERY", "LIMIT",
  "OFFSET" } } }`.
- Every record carries every property the spec lists as **required** for
  `Facility` (FacilityID, LegacyFacilityID, OrgFacilityID, FacilityName,
  FacilityDescription, FacilityTypeDescription, FacilityUseFeeDescription,
  FacilityDirections, FacilityAccessibilityText, FacilityPhone,
  FacilityEmail, FacilityReservationURL, FacilityMapURL, FacilityAdaAccess,
  GEOJSON, FacilityLongitude, FacilityLatitude, StayLimit, Keywords,
  Reservable, Enabled, LastUpdatedDate) with the documented types, plus the
  optional ParentOrgID / ParentRecAreaID. The nested arrays returned with
  `full=true` (CAMPSITE, ACTIVITY, LINK, ...) are absent because the
  provider does not request full records.

The spec does not enumerate `FacilityTypeDescription` values. The provider
maps only the ones it can map confidently (Campground, Trailhead, Visitor
Center, Information..., Ranger Station; see
`src/server/trails/providers/ridb/parse.ts`) and skips the rest.

When a real key is available, replace or extend these files with recorded
responses (see "Refreshing") and keep the synthetic edge cases.

## Files

| File | Request it stands for | Contents |
|---|---|---|
| `facilities-union-creek-tile.json` | one page for the 0.25° tile `0.25/247/538` (bbox −118.25, 44.5, −118.0, 44.75; Wallowa-Whitman NF, Oregon) | record 1 is the spec's own `Facility` example (UNION CREEK CAMPGROUND, FacilityID 233115), verbatim; records 2–11 are **synthetic** (FacilityIDs 990001–990010, names start with "Example"), covering: a reservable campground with an HTML fee text longer than 200 characters, a trailhead, a visitor center, a ranger station, an "Information Site" with HTML entities in its name, two types that are skipped (Facility, Permit), a 0,0 placeholder location, a disabled facility, and a campground outside the tile |

Pagination, malformed bodies and HTTP errors are built inline in the tests
from these records.

## Refreshing (needs a key)

```sh
curl -sS -H "apikey: $RIDB_API_KEY" \
  "https://ridb.recreation.gov/api/v1/facilities?latitude=44.625&longitude=-118.125&radius=12.5&limit=50&offset=0" \
  -o facilities-union-creek-tile.recorded.json
```

RIDB data is a US Government work (public domain); attribute it as
"Recreation.gov (RIDB)".
