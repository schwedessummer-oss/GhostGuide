/**
 * Work bounds that need no database: the area a trail search scans
 * (read.ts searchWindow) and which catalog jobs a runner may still start
 * close to its deadline (handlers/catalog.ts claimableCatalogKinds).
 */
import { describe, expect, it } from "vitest";
import type { Bbox } from "@/domain/catalog";
import { tilesForBbox } from "@/server/geo/tiles";
import { CATALOG_JOB_KINDS, MIN_INGEST_BUDGET_MS, claimableCatalogKinds } from "@/server/jobs/handlers/catalog";
import { CLIENT_TIMEOUT_MARGIN_SEC } from "@/server/trails/providers/osm";
import { DEFAULT_OVERPASS_TIMEOUT_SEC } from "@/server/trails/providers/osm/query";
import { searchWindow } from "@/server/trails/read";

const area = (b: Bbox) => (b[2] - b[0]) * (b[3] - b[1]);
const close = (a: Bbox, b: Bbox) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));

describe("searchWindow", () => {
  it("keeps an area within the coverage limit as it is", () => {
    const b: Bbox = [-105.9, 39.6, -105.1, 40.4];
    expect(tilesForBbox("outdoor", b, 16).truncated).toBe(false);
    expect(searchWindow(b, 16)).toEqual({ bbox: b, limited: false });
  });

  it("cuts a world-sized box to a window of maxTiles tiles' area around its centre", () => {
    const w = searchWindow([-180, -90, 180, 90], 16);
    expect(w.limited).toBe(true);
    close(w.bbox, [-0.5, -0.5, 0.5, 0.5]);
    expect(area(w.bbox)).toBeCloseTo(16 * 0.25 * 0.25, 9);
  });

  it("centres the window on the requested area and keeps it inside it", () => {
    const b: Bbox = [-110, 35, -100, 41];
    const w = searchWindow(b, 16);
    close(w.bbox, [-105.5, 37.5, -104.5, 38.5]);
    expect(w.bbox[0]).toBeGreaterThanOrEqual(b[0]);
    expect(w.bbox[3]).toBeLessThanOrEqual(b[3]);
  });

  it("keeps the shape of a long, narrow area (same area budget)", () => {
    const b: Bbox = [-120, 40, -70, 40.1];
    const w = searchWindow(b, 16);
    expect(w.limited).toBe(true);
    expect(w.bbox[1]).toBeCloseTo(40, 9);
    expect(w.bbox[3]).toBeCloseTo(40.1, 9);
    expect(area(w.bbox)).toBeCloseTo(1, 6);
    expect((w.bbox[0] + w.bbox[2]) / 2).toBeCloseTo(-95, 9);
  });

  it("scales with the limit", () => {
    const w = searchWindow([-180, -90, 180, 90], 64);
    close(w.bbox, [-1, -1, 1, 1]);
  });
});

describe("claimableCatalogKinds", () => {
  it("a tile load needs time for one full Overpass attempt plus storing it", () => {
    expect(MIN_INGEST_BUDGET_MS).toBeGreaterThanOrEqual((DEFAULT_OVERPASS_TIMEOUT_SEC + CLIENT_TIMEOUT_MARGIN_SEC) * 1000 + 20_000);
  });

  it("stops claiming tile loads once a full attempt no longer fits; maintenance jobs still run", () => {
    expect(claimableCatalogKinds(285_000)).toEqual([...CATALOG_JOB_KINDS]);
    expect(claimableCatalogKinds(MIN_INGEST_BUDGET_MS)).toEqual([...CATALOG_JOB_KINDS]);
    expect(claimableCatalogKinds(MIN_INGEST_BUDGET_MS - 1)).toEqual(["catalog.refresh_stale", "catalog.purge_caches"]);
    expect(claimableCatalogKinds(46_000)).not.toContain("catalog.ingest_tile");
  });
});
