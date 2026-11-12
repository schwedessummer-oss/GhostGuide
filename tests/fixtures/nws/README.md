# National Weather Service alert fixtures

Used by `tests/unit/weather/**` and `tests/integration/trails/conditions*.test.ts`
(served through a stubbed `fetch`). Tests never touch the network.

## License and attribution

Data from the US National Weather Service (api.weather.gov), a work of the
US Government (public domain). Weather alerts from the US National Weather
Service (NOAA).

## Samples

Real responses were fetched once on 2026-11-12 around 03:42 UTC with
User-Agent `GhostGuide/0.1 (dev fixtures)` and `Accept: application/geo+json`.

| File | Origin | What it shows |
|---|---|---|
| `alerts-active-table-rock-sc.json` | real: `GET /alerts/active?point=35.033,-82.7` (Table Rock State Park, SC) | no active alerts: an empty `FeatureCollection` |
| `alerts-active-out-of-bounds-toronto.json` | real: `GET /alerts/active?point=43.7,-79.4` (Toronto, Canada), HTTP 400 `application/problem+json` | the answer for points outside NWS coverage (`detail`: "out of bounds") |
| `alerts-sample-real.json` | real: `GET /alerts?limit=2&status=actual&message_type=alert` | two real Special Weather Statements (Kentucky), used as the reference for the alert schema; both expire at 2026-11-12T04:00Z |
| `alerts-active-synthetic.json` | **synthetic**, generated to match the real schema above | edge cases for the mapper (see below) |

### Synthetic collection

Built by hand (one-off script, values invented for testing only; they are
not real alerts) with the property names, formats and nesting of the real
samples. Reference time in the tests: 2026-11-12T15:00:00Z.

1. Wind Advisory (Moderate) — kept
2. Winter Storm Warning (Severe) with a 3 221-character description — kept, description trimmed to 2 000 characters
3. `status: "Test"` — dropped
4. `messageType: "Cancel"` — dropped
5. Dense Fog Advisory that expired at 14:30Z — dropped
6. Flash Flood Emergency (Extreme), `messageType: "Update"`, no `@id`, no `onset`, no `ends`, no `instruction`, CRLF/blank-line noise in the description — kept (url from the feature id, onset from `effective`, ends from `expires`)
7. Duplicate id of 1 — dropped
8. No `event` — dropped
9. Frost Advisory with `severity: null`, a `javascript:` `@id` and a non-NWS feature id — kept with severity "Unknown" and url null
10. A feature without `properties` and a string entry — dropped

Expected order after mapping: Flash Flood Emergency, Winter Storm Warning,
Wind Advisory, Frost Advisory.

## Refreshing

Keep requests rare and sequential with an identifying User-Agent. Point
queries accept at most 4 decimals.
