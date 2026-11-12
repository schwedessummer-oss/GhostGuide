/**
 * DEVELOPMENT ONLY: load the recorded OpenStreetMap samples in
 * tests/fixtures/osm through the real ingestion pipeline into a LOCAL
 * database, so the explore/trail pages have real-world data to render when
 * the public Overpass API is unreachable from a dev machine.
 *
 *   npm run db:seed:catalog-fixtures
 *
 * The data is genuine OSM data (ODbL, see the fixtures README), recorded on
 * 2026-11-12. Elevation (AWS Terrain Tiles) and place names (Nominatim) are
 * fetched live when reachable, else left empty — never invented.
 * Refuses to run against a non-local database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { databaseUrl, isLocalUrl, loadEnv, ROOT } from "../db/lib";

loadEnv();

const SAMPLES = [
  { file: "table-rock-outdoor.json", lng: -82.72, lat: 35.05 },
  { file: "greenville-falls-park-outdoor.json", lng: -82.4, lat: 34.847 },
] as const;

async function main() {
  const url = databaseUrl();
  if (!isLocalUrl(url)) throw new Error("Refusing to seed fixtures into a non-local database.");

  const { parseOverpassResponse } = await import("@/server/trails/providers/osm/parse");
  const { osmProvider } = await import("@/server/trails/providers/osm");
  const { tileForPoint } = await import("@/server/geo/tiles");
  const { ensureCoverage } = await import("@/server/trails/coverage");
  const { ingestTile } = await import("@/server/trails/ingest");
  const { closeDb } = await import("@/server/db");

  for (const sample of SAMPLES) {
    const json = JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/osm", sample.file), "utf8"));
    const tile = tileForPoint("outdoor", sample.lng, sample.lat);
    // Create the tile row (pending) without inline loading.
    await ensureCoverage("outdoor", tile.bbox, { request: true, inlineTiles: 0 });
    const result = await ingestTile("outdoor", "osm", tile.key, {
      provider: { ...osmProvider, fetchArea: async () => parseOverpassResponse("outdoor", json) },
    });
    console.log(`${sample.file} → tile ${tile.key}:`, JSON.stringify(result));
  }
  await closeDb();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
