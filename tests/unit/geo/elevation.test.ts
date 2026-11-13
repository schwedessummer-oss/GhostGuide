import { readFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offsetMeters, type LatLng } from "@/domain/geo";
import {
  clearTerrainTileCache,
  decodeTerrariumPng,
  downsampleProfile,
  elevationProfileFor,
  elevationSourceLabel,
  elevationsAt,
  gainLossWithHysteresis,
  lngLatToWorldPixel,
  metersPerPixel,
  smoothSeries,
  TerrainTileCache,
  terrainTileUrl,
  terrariumElevation,
  type TileFetcher,
} from "@/server/geo/elevation";
import { providerFetch, ProviderError } from "@/server/providers/http";
import type { Line } from "@/server/trails/types";

vi.mock("@/server/providers/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/providers/http")>();
  return { ...actual, providerFetch: vi.fn() };
});

// ---------------------------------------------------------------------------
// Synthetic Terrarium tiles
// ---------------------------------------------------------------------------
const Z = 12;
const world = (z = Z) => 256 * 2 ** z;
const pxToLng = (gx: number, z = Z) => (gx / world(z)) * 360 - 180;
const pxToLat = (gy: number, z = Z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / world(z)))) * 180) / Math.PI;

function encode(e: number): [number, number, number] {
  const v = e + 32768;
  const r = Math.floor(v / 256);
  const g = Math.floor(v) - r * 256;
  const b = Math.min(255, Math.round((v - Math.floor(v)) * 256));
  return [r, g, b];
}

type PixelFn = (p: { i: number; j: number; gx: number; gy: number; lng: number; lat: number }) => number | null;

/** Encode a 256×256 Terrarium PNG; fn returns elevation per pixel centre (null = transparent). */
function makeTile(z: number, tx: number, ty: number, fn: PixelFn, size = 256): Uint8Array {
  const png = new PNG({ width: size, height: size });
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const gx = tx * 256 + i + 0.5;
      const gy = ty * 256 + j + 0.5;
      const e = fn({ i, j, gx, gy, lng: pxToLng(gx, z), lat: pxToLat(gy, z) });
      const o = (j * size + i) * 4;
      if (e === null) {
        png.data[o + 3] = 0;
        continue;
      }
      const [r, g, b] = encode(e);
      png.data[o] = r;
      png.data[o + 1] = g;
      png.data[o + 2] = b;
      png.data[o + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

/** A fetcher that renders tiles on demand from an elevation function, recording calls. */
function syntheticWorld(fn: PixelFn, opts: { missing?: (key: string) => boolean } = {}) {
  const calls: string[] = [];
  const rendered = new Map<string, Uint8Array>();
  const fetchTile: TileFetcher = async (z, x, y) => {
    const key = `${z}/${x}/${y}`;
    calls.push(key);
    if (opts.missing?.(key)) return null;
    if (!rendered.has(key)) rendered.set(key, makeTile(z, x, y, fn));
    return rendered.get(key)!;
  };
  return { fetchTile, calls };
}

const origin: LatLng = { lat: 46.5, lng: 8.0 };
const KX = Math.cos((origin.lat * Math.PI) / 180) * (Math.PI / 180) * 6_371_008.8; // metres per degree lng
const eastOf = (lng: number) => (lng - origin.lng) * KX;
const at = (eastM: number, northM = 0): [number, number] => {
  const p = offsetMeters(origin, eastM, northM);
  return [p.lng, p.lat];
};
const eastLine = (fromM: number, toM: number, step = 50, northM = 0): Line => {
  const n = Math.max(1, Math.round(Math.abs(toM - fromM) / step));
  return Array.from({ length: n + 1 }, (_, i) => at(fromM + ((toM - fromM) * i) / n, northM));
};

/** Deterministic per-pixel noise in [-1, 1]. */
const hashNoise = (i: number, j: number) => {
  let h = Math.imul(i * 374761393 + j * 668265263, 1274126177) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 2147483647.5 - 1;
};

const fixture = (name: string) => new Uint8Array(readFileSync(path.resolve(import.meta.dirname, "../../fixtures/terrain", name)));
const fixtureFetcher =
  (tiles: Record<string, string>): TileFetcher =>
  async (z, x, y) => {
    const name = tiles[`${z}/${x}/${y}`];
    return name ? fixture(name) : null;
  };

// ---------------------------------------------------------------------------
describe("Terrarium decoding", () => {
  it("decodes the RGB formula", () => {
    expect(terrariumElevation(128, 0, 0)).toBe(0);
    expect(terrariumElevation(135, 26, 128)).toBe(1818.5);
    expect(terrariumElevation(0, 0, 0)).toBe(-32768);
    for (const e of [-430.25, 0, 1897.5, 4392, 8848.75]) expect(terrariumElevation(...encode(e))).toBeCloseTo(e, 2);
  });

  it("decodes a tile and marks transparent / impossible pixels as no data", () => {
    const tile = decodeTerrariumPng(makeTile(Z, 0, 0, ({ i, j }) => (i === 0 && j === 0 ? null : i === 1 && j === 0 ? -32768 : 1234.5)))!;
    expect(tile.size).toBe(256);
    expect(tile.elevations[0]).toBeNaN();
    expect(tile.elevations[1]).toBeNaN();
    expect(tile.elevations[2]).toBeCloseTo(1234.5, 3);
    expect(tile.elevations[256 * 256 - 1]).toBeCloseTo(1234.5, 3);
  });

  it("rejects malformed bytes and wrong tile sizes without throwing", () => {
    expect(decodeTerrariumPng(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decodeTerrariumPng(new Uint8Array(0))).toBeNull();
    const truncated = makeTile(Z, 0, 0, () => 100).slice(0, 200);
    expect(decodeTerrariumPng(truncated)).toBeNull();
    expect(decodeTerrariumPng(makeTile(Z, 0, 0, () => 100, 128))).toBeNull();
    expect(decodeTerrariumPng("png" as unknown as Uint8Array)).toBeNull();
  });
});

describe("Web Mercator", () => {
  it("maps known points to pixels and tiles", () => {
    expect(lngLatToWorldPixel(0, 0, 0)).toEqual({ x: 128, y: 128 });
    const rainier = lngLatToWorldPixel(-121.7604, 46.8529, 12)!;
    expect([Math.floor(rainier.x / 256), Math.floor(rainier.y / 256)]).toEqual([662, 1443]);
    expect(lngLatToWorldPixel(180, 0, 1)!.x).toBe(512);
    expect(lngLatToWorldPixel(0, 86, 12)).toBeNull();
    expect(lngLatToWorldPixel(NaN, 0, 12)).toBeNull();
    expect(metersPerPixel(0, 12)).toBeCloseTo(38.22, 2);
    expect(metersPerPixel(45, 12)).toBeCloseTo(27.02, 2);
  });

  it("labels the source by the grid it was sampled on, never as a DEM resolution", () => {
    const aws = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
    // ~27 m is the zoom-12 pixel spacing at 45°; the DEM behind it can be 10 m or 90 m.
    expect(elevationSourceLabel(45, 12, aws)).toBe("AWS Terrain Tiles, sampled on a ~27 m grid; source data resolution varies by region (estimate)");
    expect(elevationSourceLabel(45, 10, aws)).toContain("sampled on a ~108 m grid");
    // A custom tile server: nothing is claimed about the data behind it.
    expect(elevationSourceLabel(0, 12, "https://t.example/{z}/{x}/{y}.png")).toBe("Terrarium terrain tiles, sampled on a ~38 m grid (estimate)");
    for (const label of [elevationSourceLabel(45, 12, aws), elevationSourceLabel(60, 11, "https://t.example/{z}/{x}/{y}.png")]) {
      expect(label).not.toMatch(/\bDEM\b/);
      expect(label).toMatch(/\(estimate\)$/);
    }
  });

  it("builds tile URLs from the template", () => {
    expect(terrainTileUrl("https://t.example/{z}/{x}/{y}.png", 12, 3, 4)).toBe("https://t.example/12/3/4.png");
    expect(() => terrainTileUrl("https://t.example/{z}/{x}.png", 1, 2, 3)).toThrow();
  });
});

describe("bilinear sampling", () => {
  const p0 = lngLatToWorldPixel(origin.lng, origin.lat, Z)!;
  const tx = Math.floor(p0.x / 256);
  const ty = Math.floor(p0.y / 256);
  const pointAtPx = (gx: number, gy: number) => ({ lng: pxToLng(gx), lat: pxToLat(gy) });

  it("interpolates between pixel centres", async () => {
    // e = 10·column + 3·row inside every tile: bilinear reproduces planes exactly.
    const { fetchTile } = syntheticWorld(({ i, j }) => 10 * i + 3 * j);
    const [a, b, c] = await elevationsAt(
      [pointAtPx(tx * 256 + 10.5, ty * 256 + 20.5), pointAtPx(tx * 256 + 10.75, ty * 256 + 20.5), pointAtPx(tx * 256 + 10.75, ty * 256 + 21.25)],
      { fetchTile },
    );
    expect(a).toBeCloseTo(160, 1); // exactly pixel (10, 20)
    expect(b).toBeCloseTo(162.5, 1); // a quarter of the way to (11, 20)
    expect(c).toBe(164.8); // 10·10.25 + 3·20.75 = 164.75 (both axes interpolated), rounded to 0.1 m
  });

  it("interpolates across tile edges using the neighbouring tile", async () => {
    const { fetchTile, calls } = syntheticWorld(({ gx }) => (gx < (tx + 1) * 256 ? 100 : 200));
    const y = ty * 256 + 100.5;
    const [edge, inside, beyond] = await elevationsAt(
      [pointAtPx((tx + 1) * 256, y), pointAtPx((tx + 1) * 256 - 0.25, y), pointAtPx((tx + 1) * 256 + 0.5, y)],
      { fetchTile },
    );
    expect(edge).toBe(150);
    expect(inside).toBe(125);
    expect(beyond).toBe(200);
    expect(new Set(calls)).toEqual(new Set([`${Z}/${tx}/${ty}`, `${Z}/${tx + 1}/${ty}`]));
  });

  it("returns null per point for invalid input, polar points, missing tiles and no-data pixels", async () => {
    const { fetchTile } = syntheticWorld(({ i }) => (i === 50 ? null : 500), { missing: (k) => k === `${Z}/${tx + 2}/${ty}` });
    const y = ty * 256 + 100.5;
    const out = await elevationsAt(
      [
        pointAtPx(tx * 256 + 10.5, y),
        { lng: NaN, lat: 0 },
        { lng: 0, lat: 89 },
        pointAtPx((tx + 2) * 256 + 100.5, y),
        pointAtPx(tx * 256 + 50.5, y),
        null as unknown as LatLng,
      ],
      { fetchTile },
    );
    expect(out).toEqual([500, null, null, null, null, null]);
    expect(await elevationsAt([], { fetchTile })).toEqual([]);
  });

  it("admits tiles in point order up to maxTiles", async () => {
    const { fetchTile, calls } = syntheticWorld(() => 42);
    const y = ty * 256 + 100.5;
    const out = await elevationsAt([pointAtPx(tx * 256 + 100.5, y), pointAtPx((tx + 3) * 256 + 100.5, y)], { fetchTile, maxTiles: 1 });
    expect(out).toEqual([42, null]);
    expect(calls).toEqual([`${Z}/${tx}/${ty}`]);
  });

  it("treats a throwing fetcher as unavailable", async () => {
    const fetchTile: TileFetcher = async () => {
      throw new Error("boom");
    };
    expect(await elevationsAt([origin], { fetchTile })).toEqual([null]);
    expect(await elevationProfileFor([eastLine(0, 500)], { fetchTile })).toBeNull();
  });
});

describe("series helpers", () => {
  it("smooths noise but keeps endpoints and linear trends", () => {
    const ramp = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
    expect(smoothSeries(ramp)).toEqual(ramp);
    const zig = Array.from({ length: 21 }, (_, i) => (i % 2 ? 2 : -2));
    const s = smoothSeries(zig);
    expect(s[0]).toBe(-2);
    expect(s[20]).toBe(-2);
    for (const v of s.slice(2, -2)) expect(Math.abs(v)).toBeLessThanOrEqual(0.4 + 1e-9);
    expect(smoothSeries([1, 9])).toEqual([1, 9]);
    expect(smoothSeries([1, 9, 3], 1)).toEqual([1, 9, 3]);
  });

  it("counts only changes that clear the hysteresis threshold", () => {
    expect(gainLossWithHysteresis([0, 1, 2, 1, 0, 2, 1])).toEqual({ gain: 0, loss: 0 });
    expect(gainLossWithHysteresis([0, 5, 0])).toEqual({ gain: 5, loss: 5 });
    expect(gainLossWithHysteresis([0, 3, 6, 9, 6, 3])).toEqual({ gain: 9, loss: 6 });
    // The final remainder below the threshold is not counted (documented).
    expect(gainLossWithHysteresis([0, 2, 4, 6])).toEqual({ gain: 4, loss: 0 });
    expect(gainLossWithHysteresis([0, 2, 4, 6], 0)).toEqual({ gain: 6, loss: 0 });
    expect(gainLossWithHysteresis([5])).toEqual({ gain: 0, loss: 0 });
  });

  it("downsamples with LTTB, keeping ends and peaks", () => {
    const flatWithSpike: [number, number][] = Array.from({ length: 1000 }, (_, i) => [i, i === 437 ? 900 : 100]);
    const d = downsampleProfile(flatWithSpike, 50);
    expect(d).toHaveLength(50);
    expect(d[0]).toEqual([0, 100]);
    expect(d.at(-1)).toEqual([999, 100]);
    expect(d.some(([x, y]) => x === 437 && y === 900)).toBe(true);
    for (let i = 1; i < d.length; i++) expect(d[i][0]).toBeGreaterThan(d[i - 1][0]);
    expect(downsampleProfile(flatWithSpike.slice(0, 10), 50)).toHaveLength(10);
    expect(downsampleProfile(flatWithSpike, 2)).toEqual([
      [0, 100],
      [999, 100],
    ]);
  });
});

describe("elevationProfileFor (synthetic DEM)", () => {
  // Ramp: +1 m per 10 m east of the origin.
  const ramp: PixelFn = ({ lng }) => 1000 + eastOf(lng) * 0.1;

  it("measures a steady climb: gain, loss, extremes and profile", async () => {
    const { fetchTile } = syntheticWorld(ramp);
    const r = (await elevationProfileFor([eastLine(0, 3000)], { fetchTile }))!;
    expect(r).not.toBeNull();
    expect(r.gainM).toBeGreaterThanOrEqual(297);
    expect(r.gainM).toBeLessThanOrEqual(300);
    expect(r.lossM).toBe(0);
    expect(r.minM).toBe(1000);
    expect(r.maxM).toBe(1300);
    expect(r.samples).toBe(101); // 3000 / 30 + 1
    expect(r.profile[0][0]).toBe(0);
    expect(r.profile[0][1]).toBeCloseTo(1000, 0);
    expect(r.profile.at(-1)![0]).toBeCloseTo(3000, -1);
    expect(r.profile.at(-1)![1]).toBeCloseTo(1300, 0);
    expect(r.source).toBe("AWS Terrain Tiles, sampled on a ~26 m grid; source data resolution varies by region (estimate)");
  });

  it("does not let DEM noise inflate gain on flat ground", async () => {
    const { fetchTile } = syntheticWorld(({ i, j }) => 500 + 1.5 * hashNoise(i, j));
    const line = eastLine(0, 3000, 50, 123);
    const r = (await elevationProfileFor([line], { fetchTile }))!;
    // A naive sum of positive differences over the raw samples is large…
    const raw = r.profile.map((p) => p[1]);
    let naive = 0;
    for (let i = 1; i < raw.length; i++) naive += Math.max(0, raw[i] - raw[i - 1]);
    expect(naive).toBeGreaterThan(15);
    // …the smoothed, hysteresis-filtered value is not.
    expect(r.gainM).toBeLessThanOrEqual(3);
    expect(r.lossM).toBeLessThanOrEqual(3);
    expect(r.maxM - r.minM).toBeLessThanOrEqual(3);
  });

  it("keeps a noisy climb close to the true climb", async () => {
    const { fetchTile } = syntheticWorld((p) => (ramp(p) as number) + 1.5 * hashNoise(p.i, p.j));
    const r = (await elevationProfileFor([eastLine(0, 3000)], { fetchTile }))!;
    expect(r.gainM).toBeGreaterThanOrEqual(292);
    expect(r.gainM).toBeLessThanOrEqual(306);
    expect(r.lossM).toBeLessThanOrEqual(6);
  });

  it("follows rolling terrain (sine, 50 m amplitude, 1 km period)", async () => {
    const { fetchTile } = syntheticWorld(({ lng }) => 1000 + 50 * Math.sin((2 * Math.PI * eastOf(lng)) / 1000));
    const r = (await elevationProfileFor([eastLine(0, 3000)], { fetchTile }))!;
    // True gain/loss: 3 cycles × 100 m. Smoothing over ~120 m shaves ~3.5 %.
    expect(r.gainM).toBeGreaterThanOrEqual(280);
    expect(r.gainM).toBeLessThanOrEqual(301);
    expect(r.lossM).toBeGreaterThanOrEqual(280);
    expect(r.lossM).toBeLessThanOrEqual(301);
    expect(r.maxM).toBeGreaterThanOrEqual(1049);
    expect(r.minM).toBeLessThanOrEqual(951);
  });

  it("sums lines separately and never counts the jump between them", async () => {
    const { fetchTile } = syntheticWorld(ramp);
    const a = eastLine(0, 1000); // 1000 → 1100 m
    const b = eastLine(3000, 2000); // 1300 → 1200 m (walked west, downhill)
    const r = (await elevationProfileFor([a, b], { fetchTile }))!;
    expect(r.gainM).toBeGreaterThanOrEqual(97);
    expect(r.gainM).toBeLessThanOrEqual(100);
    expect(r.lossM).toBeGreaterThanOrEqual(97);
    expect(r.lossM).toBeLessThanOrEqual(100);
    expect(r.maxM).toBe(1300);
    expect(r.minM).toBe(1000);
    // Distance continues across lines: the profile ends at 2 km, not 3 km.
    expect(r.profile.at(-1)![0]).toBeCloseTo(2000, -1);
    const atJoin = r.profile.filter(([d]) => Math.abs(d - 1000) < 1);
    expect(atJoin.map(([, e]) => Math.round(e))).toEqual([1100, 1300]);
  });

  it("bounds samples and profile points for long routes", async () => {
    const { fetchTile } = syntheticWorld(ramp);
    const line = eastLine(0, 20_000, 200);
    const r = (await elevationProfileFor([line], { fetchTile }))!;
    expect(r.samples).toBe(668);
    expect(r.profile).toHaveLength(300);
    for (let i = 1; i < r.profile.length; i++) expect(r.profile[i][0]).toBeGreaterThanOrEqual(r.profile[i - 1][0]);
    expect(r.profile.at(-1)![0]).toBeCloseTo(20_000, -1);

    const capped = (await elevationProfileFor([line], { fetchTile, maxSamples: 200, profilePoints: 40 }))!;
    expect(capped.samples).toBeLessThanOrEqual(200);
    expect(capped.samples).toBeGreaterThan(150);
    expect(capped.profile).toHaveLength(40);
    expect(capped.gainM).toBeGreaterThanOrEqual(1990);
    expect(capped.gainM).toBeLessThanOrEqual(2000);
  });

  it("falls back to coarser zooms to respect the tile budget, then gives up", async () => {
    const line = eastLine(0, 20_000, 500);
    const full = syntheticWorld(ramp);
    await elevationProfileFor([line], { fetchTile: full.fetchTile });
    const tilesAtZ12 = new Set(full.calls).size;
    expect(tilesAtZ12).toBeGreaterThan(2);

    const { fetchTile, calls } = syntheticWorld(ramp);
    const maxTiles = tilesAtZ12 - 1;
    const r = (await elevationProfileFor([line], { fetchTile, maxTiles }))!;
    expect(r).not.toBeNull();
    const zooms = new Set(calls.map((c) => Number(c.split("/")[0])));
    expect(zooms.size).toBe(1);
    const zoom = [...zooms][0];
    expect(zoom).toBeLessThan(12);
    expect(zoom).toBeGreaterThanOrEqual(10);
    expect(new Set(calls).size).toBeLessThanOrEqual(maxTiles);
    expect(r.source).toContain(`~${Math.round(metersPerPixel(origin.lat, zoom))} m`);
    expect(r.gainM).toBeGreaterThanOrEqual(1990);

    const none = syntheticWorld(ramp);
    const long = eastLine(0, 400_000, 5000);
    expect(await elevationProfileFor([long], { fetchTile: none.fetchTile, maxTiles: 2 })).toBeNull();
    expect(none.calls).toEqual([]);
  });

  it("returns null when any needed tile is missing or a sample has no data", async () => {
    const p0 = lngLatToWorldPixel(origin.lng, origin.lat, Z)!;
    const firstTile = `${Z}/${Math.floor(p0.x / 256)}/${Math.floor(p0.y / 256)}`;
    const missing = syntheticWorld(ramp, { missing: (k) => k !== firstTile });
    expect(await elevationProfileFor([eastLine(0, 20_000, 500)], { fetchTile: missing.fetchTile })).toBeNull();

    const holes = syntheticWorld(({ i }) => (i === 128 ? null : 700));
    expect(await elevationProfileFor([eastLine(0, 20_000, 500)], { fetchTile: holes.fetchTile })).toBeNull();

    const corrupt: TileFetcher = async () => new Uint8Array([137, 80, 78, 71, 0, 0]);
    expect(await elevationProfileFor([eastLine(0, 500)], { fetchTile: corrupt })).toBeNull();
  });

  it("returns null for empty, degenerate or polar geometry", async () => {
    const { fetchTile, calls } = syntheticWorld(ramp);
    expect(await elevationProfileFor([], { fetchTile })).toBeNull();
    expect(await elevationProfileFor([[[8, 46]]], { fetchTile })).toBeNull();
    expect(await elevationProfileFor([[[NaN, 1], "x"]] as unknown as Line[], { fetchTile })).toBeNull();
    expect(
      await elevationProfileFor(
        [
          [
            [10, 86],
            [10.1, 86],
          ],
        ],
        { fetchTile },
      ),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("rejects when aborted, before or during tile loading", async () => {
    const before = new AbortController();
    before.abort();
    await expect(elevationProfileFor([eastLine(0, 500)], { fetchTile: syntheticWorld(ramp).fetchTile, signal: before.signal })).rejects.toThrow();
    await expect(elevationsAt([origin], { signal: before.signal })).rejects.toThrow();

    const during = new AbortController();
    const hanging: TileFetcher = () => new Promise(() => {});
    const pending = elevationProfileFor([eastLine(0, 500)], { fetchTile: hanging, signal: during.signal });
    during.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("TerrainTileCache", () => {
  const tileBytes = makeTile(Z, 0, 0, () => 321);

  it("shares one fetch between concurrent requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchTile = vi.fn<TileFetcher>(async () => {
      await gate;
      return tileBytes;
    });
    const cache = new TerrainTileCache(fetchTile, 4);
    const all = Promise.all([cache.get(12, 1, 1), cache.get(12, 1, 1), cache.get(12, 1, 1)]);
    release();
    const [a, b, c] = await all;
    expect(fetchTile).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    await cache.get(12, 1, 1);
    expect(fetchTile).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used tile", async () => {
    const fetchTile = vi.fn<TileFetcher>(async () => tileBytes);
    const cache = new TerrainTileCache(fetchTile, 2);
    await cache.get(12, 0, 0);
    await cache.get(12, 1, 0);
    await cache.get(12, 0, 0); // refresh 0/0
    await cache.get(12, 2, 0); // evicts 1/0
    expect(cache.size).toBe(2);
    await cache.get(12, 0, 0);
    expect(fetchTile).toHaveBeenCalledTimes(3);
    await cache.get(12, 1, 0);
    expect(fetchTile).toHaveBeenCalledTimes(4);
  });

  it("does not cache failures", async () => {
    let fail = true;
    const fetchTile = vi.fn<TileFetcher>(async () => {
      if (fail) throw new Error("timeout");
      return tileBytes;
    });
    const cache = new TerrainTileCache(fetchTile, 2);
    expect(await cache.get(12, 0, 0)).toBeNull();
    fail = false;
    expect(await cache.get(12, 0, 0)).not.toBeNull();
    expect(fetchTile).toHaveBeenCalledTimes(2);
  });
});

describe("default tile source (providerFetch)", () => {
  const mocked = vi.mocked(providerFetch);
  const tahoe = fixture("terrarium-12-682-1564.png");
  const okResponse = (bytes: Uint8Array) => ({
    status: 200,
    headers: new Headers(),
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    json: () => {
      throw new Error("not json");
    },
    text: () => "",
  });

  beforeEach(() => {
    clearTerrainTileCache();
    mocked.mockReset();
  });
  afterEach(() => clearTerrainTileCache());

  it("fetches through providerFetch with the configured URL and caches decoded tiles", async () => {
    mocked.mockResolvedValue(okResponse(tahoe));
    const p = { lat: 39.09, lng: -120.03 };
    expect(await elevationsAt([p])).toEqual([1897.6]);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0][0]).toMatchObject({
      provider: "terrain_tiles",
      url: "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/12/682/1564.png",
      timeoutMs: 15_000,
      retries: 1,
      okStatuses: [],
    });
    expect(await elevationsAt([p])).toEqual([1897.6]);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("returns null when the provider fails, and retries on the next call", async () => {
    mocked.mockRejectedValueOnce(new ProviderError("terrain_tiles", "HTTP 503", 503, true));
    const p = { lat: 39.09, lng: -120.03 };
    expect(await elevationsAt([p])).toEqual([null]);
    mocked.mockResolvedValueOnce(okResponse(tahoe));
    expect(await elevationsAt([p])).toEqual([1897.6]);
    expect(mocked).toHaveBeenCalledTimes(2);
  });
});

describe("real AWS Terrain Tiles fixtures", () => {
  const fetchTile = fixtureFetcher({
    "12/662/1443": "terrarium-12-662-1443.png",
    "12/682/1564": "terrarium-12-682-1564.png",
  });

  it("finds Mount Rainier's summit near its published 4392 m", async () => {
    const [summit] = await elevationsAt([{ lat: 46.8529, lng: -121.7604 }], { fetchTile });
    expect(summit).not.toBeNull();
    expect(Math.abs(summit! - 4392)).toBeLessThan(25);
    // A 1.4 km south→north line over the summit, inside the fixture tile:
    // one climb to the top and one descent, so gain ≈ top − start and loss ≈ top − end.
    const crossing: Line = [
      [-121.7604, 46.847],
      [-121.7604, 46.86],
    ];
    const r = (await elevationProfileFor([crossing], { fetchTile }))!;
    expect(r).not.toBeNull();
    expect(Math.abs(r.maxM - 4392)).toBeLessThan(25);
    const first = r.profile[0][1];
    const last = r.profile.at(-1)![1];
    expect(first).toBeLessThan(r.maxM - 100);
    expect(last).toBeLessThan(r.maxM - 200);
    expect(Math.abs(r.gainM - (r.maxM - first))).toBeLessThan(10);
    expect(Math.abs(r.lossM - (r.maxM - last))).toBeLessThan(10);
  });

  it("reads Lake Tahoe as a flat ~1897 m surface", async () => {
    const [lake] = await elevationsAt([{ lat: 39.09, lng: -120.03 }], { fetchTile });
    expect(lake).toBeCloseTo(1897.6, 1);
    const r = (await elevationProfileFor([[[-120.03, 39.09], [-120.01, 39.09]]], { fetchTile }))!;
    expect(r).toMatchObject({ gainM: 0, lossM: 0, maxM: 1898, minM: 1898 });
    expect(r.source).toBe("AWS Terrain Tiles, sampled on a ~30 m grid; source data resolution varies by region (estimate)");
  });
});
