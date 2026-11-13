/**
 * Coverage with a supplementary, POI-only provider (Recreation.gov RIDB on
 * the outdoor layer) next to OpenStreetMap: RIDB rows are still requested
 * and loaded, but trail coverage is decided by the trail provider only. A
 * RIDB failure (bad key, the >500-facilities guard, an outage) never turns
 * loaded trails into "failed"/"partial", never names OpenStreetMap as
 * failing, and never disables shared caching; it is noted in the message.
 *
 * The registry is mocked: OSM plus a RIDB stand-in that covers every tile.
 * No provider is called (nothing runs the jobs). Tiles live around
 * lng 145–160, lat −42.5 (row iy = 190 of the 0.25° grid).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Bbox } from "@/domain/catalog";
import type { TrailDataProvider } from "@/server/trails/types";

vi.mock("@/server/trails/providers/registry", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/trails/providers/registry")>();
  const osm = orig.TRAIL_PROVIDERS.find((p) => p.id === "osm")!;
  const ridb: TrailDataProvider = {
    id: "ridb",
    label: "Recreation.gov",
    homepage: "https://ridb.recreation.gov",
    license: "US Government work (public domain)",
    attribution: "Recreation.gov (RIDB)",
    layers: ["outdoor"],
    isEnabled: () => true,
    covers: () => true,
    fetchArea: async () => {
      throw new Error("not called in this test");
    },
  };
  const all = [osm, ridb];
  return {
    ...orig,
    TRAIL_PROVIDERS: all,
    providerById: (id: string) => all.find((p) => p.id === id) ?? null,
    enabledProviders: (layer: "outdoor" | "services") => all.filter((p) => p.layers.includes(layer)),
    providersFor: (layer: "outdoor" | "services") => all.filter((p) => p.layers.includes(layer)),
  };
});

import { closeDb, sql } from "@/server/db";
import { ensureCoverage, getCoverage } from "@/server/trails/coverage";

beforeAll(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("network access is disabled in tests");
  });
});
afterAll(async () => {
  await sql()`update public.jobs set status = 'cancelled', finished_at = now()
               where kind like 'catalog.%' and status in ('queued', 'running')`;
  vi.unstubAllGlobals();
  await closeDb();
});

const IY = 190;
let nextIx = 1300;
function freshArea(n = 1): { bbox: Bbox; keys: string[] } {
  const ix = nextIx;
  nextIx += n + 1;
  const keys: string[] = [];
  for (let x = ix; x < ix + n; x++) for (let y = IY; y < IY + n; y++) keys.push(`0.25/${x}/${y}`);
  const w = ix * 0.25 - 180;
  const s = IY * 0.25 - 90;
  return { bbox: [w + 0.001, s + 0.001, w + n * 0.25 - 0.001, s + n * 0.25 - 0.001], keys };
}

async function set(provider: string, keys: string[], state: "ready" | "failed") {
  if (state === "ready") {
    await sql()`update public.catalog_tiles set status = 'ready', last_synced_at = now() - interval '1 day', next_refresh_at = now() + interval '20 days'
                 where layer = 'outdoor' and provider = ${provider} and tile_key = any(${keys}::text[])`;
  } else {
    await sql()`update public.catalog_tiles set status = 'failed', attempts = 1, last_synced_at = null, next_refresh_at = now() + interval '6 hours',
                       last_error = 'Recreation.gov RIDB: RIDB rejected the API key (HTTP 401); check RIDB_API_KEY'
                 where layer = 'outdoor' and provider = ${provider} and tile_key = any(${keys}::text[])`;
  }
  // The load ended (a non-retryable failure ends its job as "succeeded").
  await sql()`update public.jobs set status = 'succeeded', finished_at = now()
               where kind = 'catalog.ingest_tile' and payload->>'provider' = ${provider} and payload->>'tileKey' = any(${keys}::text[])
                 and status in ('queued', 'running')`;
}

describe("coverage with a supplementary POI-only provider", () => {
  it("requests both providers' tiles, but the trail provider alone decides the state and the sources named", async () => {
    const { bbox, keys } = freshArea(1);
    const cov = await ensureCoverage("outdoor", bbox);
    expect(cov.state).toBe("loading");
    expect(cov.message).toBe("Loading trails for this area from OpenStreetMap… this can take a minute.");
    const rows = await sql()<{ provider: string }[]>`
      select provider from public.catalog_tiles where layer = 'outdoor' and tile_key = any(${keys}::text[]) order by provider`;
    expect(rows.map((r) => r.provider)).toEqual(["osm", "ridb"]);
  });

  it("trails loaded + RIDB failed (job over): ready, OpenStreetMap not blamed, the RIDB failure noted", async () => {
    const { bbox, keys } = freshArea(2);
    await ensureCoverage("outdoor", bbox);
    await set("osm", keys, "ready");
    await set("ridb", keys, "failed");
    const cov = await ensureCoverage("outdoor", bbox);
    expect(cov).toMatchObject({ state: "ready", tilesReady: 4, tilesFailed: 0, tilesLoading: 0 });
    expect(cov.message).toBe("Trails for this area are loaded from OpenStreetMap. Recreation.gov data could not be loaded for part of this area right now.");
    expect(cov.message).not.toMatch(/OpenStreetMap and Recreation\.gov/);
    // The read-only status agrees.
    expect((await getCoverage("outdoor", bbox)).state).toBe("ready");
  });

  it("trails still loading while RIDB is loaded: loading; trails loaded while RIDB still loads: ready", async () => {
    const a = freshArea(1);
    await ensureCoverage("outdoor", a.bbox);
    await set("ridb", a.keys, "ready");
    expect((await ensureCoverage("outdoor", a.bbox)).state).toBe("loading");

    const b = freshArea(1);
    await ensureCoverage("outdoor", b.bbox);
    await set("osm", b.keys, "ready");
    expect((await ensureCoverage("outdoor", b.bbox)).state).toBe("ready");
  });

  it("an OpenStreetMap failure is still reported, naming only the trail source", async () => {
    const { bbox, keys } = freshArea(1);
    await ensureCoverage("outdoor", bbox);
    await set("osm", keys, "failed");
    await set("ridb", keys, "ready");
    const cov = await ensureCoverage("outdoor", bbox);
    expect(cov.state).toBe("failed");
    expect(cov.message).toBe("Trails for this area could not be loaded from OpenStreetMap right now. Please try again later.");
  });

  it("too-large areas count the trail provider's tiles only", async () => {
    const { bbox, keys } = freshArea(3);
    await ensureCoverage("outdoor", bbox, { maxTiles: 16 });
    await set("osm", keys, "ready");
    await set("ridb", keys, "failed");
    const cov = await ensureCoverage("outdoor", bbox, { maxTiles: 2 });
    expect(cov).toMatchObject({ state: "too_large", tilesTotal: 9, tilesFailed: 0 });
    expect(cov.tilesReady).toBe((await sql()<{ n: number }[]>`
      select count(*)::int as n from public.catalog_tiles where layer = 'outdoor' and provider = 'osm' and tile_key = any(${keys}::text[])`)[0].n);
  });
});
