# MET Norway Locationforecast fixtures

Used by `tests/unit/weather/**` and `tests/integration/trails/conditions*.test.ts`
(served through a stubbed `fetch`). Tests never touch the network.

## License and attribution

Real, unedited responses from the MET Norway Locationforecast 2.0 API
(`https://api.met.no/weatherapi/locationforecast/2.0/complete`).
Weather data from MET Norway (The Norwegian Meteorological Institute),
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
(see <https://api.met.no/doc/License>).

## Samples

Fetched once on 2026-11-12 around 03:42 UTC, sequentially, with
User-Agent `GhostGuide/0.1 (dev fixtures)`, using the production request
shape of `src/server/weather/metno.ts` (coordinates rounded to 3 decimals,
altitude rounded to 10 m). The responses had `Expires` ≈ 30 minutes after
`Date` and a `Last-Modified` header; the tests set their own headers.

| File | Request | What it shows |
|---|---|---|
| `complete-table-rock-sc.json` | `lat=35.033&lon=-82.7&altitude=340` (Table Rock State Park, SC, USA) | global model: no gusts, no precipitation probabilities; hourly steps until 2026-11-14T17:00Z, then 6-hourly; steps 13:00–17:00 on 11-14 carry only `next_1_hours`; dry, fair weather |
| `complete-banff-ab.json` | `lat=51.176&lon=-115.563&altitude=1390` (Banff, AB, Canada) | sub-zero temperatures, fog and light snow showers symbols |
| `complete-preikestolen-no.json` | `lat=58.986&lon=6.19&altitude=600` (Preikestolen, Norway) | Nordic model: `wind_speed_of_gust`, `probability_of_precipitation` and `probability_of_thunder` in `next_1_hours`; rain, sleet and snow symbols |

## Refreshing

Values change with every model run, so a refresh changes expected values
in the tests. Refresh one file at a time, for example:

```sh
curl -sS -A "GhostGuide/0.1 (dev fixtures)" \
  "https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=35.033&lon=-82.7&altitude=340" \
  -o complete-table-rock-sc.json
```

Respect the MET Norway terms of service (identifying User-Agent, no more
than 4 coordinate decimals, honour `Expires`), keep requests rare and
sequential, keep files unedited and record any change here.
