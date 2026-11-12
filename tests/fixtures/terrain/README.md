# Terrain tile fixtures

Real Terrarium-encoded elevation tiles used by `tests/unit/geo/elevation.test.ts`
to check decoding and Web Mercator sampling against known geography. Tests never
touch the network; everything else in the elevation tests uses synthetic tiles
generated in the test with `pngjs`.

| File | Tile (z/x/y) | Area | Used to check |
|---|---|---|---|
| `terrarium-12-662-1443.png` | 12/662/1443 | Mount Rainier summit, Washington, USA | summit ≈ 4392 m (published elevation) |
| `terrarium-12-682-1564.png` | 12/682/1564 | Lake Tahoe (open water), California/Nevada, USA | flat lake surface ≈ 1897 m |

- Source: AWS Open Data **Terrain Tiles** (Terrarium format), downloaded once on
  2026-11-12 from
  `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png`
  (see https://registry.opendata.aws/terrain-tiles/). Files are byte-for-byte as
  served.
- Encoding: `elevation_m = (R * 256 + G + B / 256) - 32768`.
- Attribution: the tiles were produced by Mapzen/Tilezen ("joerd") from public
  elevation datasets; for these US tiles the underlying data is USGS 3DEP / NED
  (public domain) with SRTM (NASA) and other sources elsewhere. Full attribution:
  https://github.com/tilezen/joerd/blob/master/docs/attribution.md
- These fixtures contain **no OpenStreetMap data**, so the ODbL
  ("© OpenStreetMap contributors") does not apply to them. Any OSM-derived
  fixture must carry that attribution in its own folder's README.
