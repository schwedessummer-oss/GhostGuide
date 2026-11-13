import "server-only";
import { PNG } from "pngjs";
import { env } from "@/config/env";
import type { LngLat } from "@/domain/catalog";
import { log } from "@/server/log";
import { providerFetch } from "@/server/providers/http";
import type { Line } from "@/server/trails/types";
import { cleanLines, isValidCoord, lineLengthM, resampleLine } from "./geodesy";

/**
 * Elevation from Terrarium-encoded terrain tiles (default: AWS Open Data
 * Terrain Tiles, https://registry.opendata.aws/terrain-tiles/).
 *
 * Tiles are 256×256 PNGs on the Web Mercator XYZ grid; each pixel encodes
 *
 *     elevation_m = (R·256 + G + B/256) − 32768
 *
 * Pixel values are treated as samples at pixel centres and interpolated
 * bilinearly, across tile edges when needed (neighbouring tiles are fetched).
 * Zoom 12 gives a grid of ~38 m·cos(lat) per pixel (~27 m at 45°); the
 * underlying DEM is ~10 m (USGS 3DEP) to ~90 m (SRTM) depending on region,
 * so every value here is an ESTIMATE and labelled as such.
 *
 * Nothing is fabricated: if any tile a computation needs cannot be fetched
 * or decoded, the result is null (profile) or null per point (elevationsAt).
 *
 * Decoded tiles are kept in a bounded module-level LRU (48 tiles ≈ 12 MB)
 * and concurrent requests for the same tile share one fetch.
 */

export const TERRAIN_TILE_SIZE = 256;
export const DEFAULT_TERRAIN_ZOOM = 12;
/** Highest zoom published by the AWS Terrarium tile set. */
export const MAX_TERRAIN_ZOOM = 15;
/** Web Mercator latitude limit; tiles do not cover beyond it. */
export const MERCATOR_MAX_LAT = 85.051_128_779_806_59;
const DEFAULT_TILE_CACHE_SIZE = 48;
const DEFAULT_MAX_TILES = 64;
/** Long routes step down to coarser zooms to stay within maxTiles, but never below this. */
const MIN_FALLBACK_ZOOM = 10;
const FETCH_CONCURRENCY = 6;
/** Encoded tiles larger than this are rejected before decoding (a 256² Terrarium PNG is ≤ ~200 KB). */
const MAX_TILE_BYTES = 4 * 1024 * 1024;
/** Physically impossible values (deeper than the Challenger Deep / higher than Everest) are no-data. */
const MIN_PLAUSIBLE_M = -11_100;
const MAX_PLAUSIBLE_M = 9_000;
const EQUATOR_M = 40_075_016.686;

/** Returns the encoded PNG bytes of tile z/x/y, or null when unavailable. */
export type TileFetcher = (z: number, x: number, y: number) => Promise<Uint8Array | null>;

export interface DecodedTile {
  size: number;
  /** Row-major elevations in metres; NaN marks no-data pixels. */
  elevations: Float32Array;
}

export interface ElevationResult {
  /**
   * [distance_m, elevation_m] downsampled to ≤ profilePoints points. Distance
   * continues across lines in input order; where two lines are disconnected
   * the profile has two points at the same distance (the jump between them).
   */
  profile: [number, number][];
  /** Smoothed, hysteresis-filtered climb summed per line (integer metres). */
  gainM: number;
  lossM: number;
  maxM: number;
  minM: number;
  /** Number of elevation samples taken along the route. */
  samples: number;
  /** Human-readable provenance, always marked as an estimate. */
  source: string;
}

export interface ElevationProfileOptions {
  /** Target distance between samples (default 30 m). */
  spacingM?: number;
  /** Soft cap on samples; spacing grows for long routes (default 1500). */
  maxSamples?: number;
  /** Points kept in the returned profile (default 300). */
  profilePoints?: number;
  /** Tile zoom (default 12). */
  zoom?: number;
  /** Most tiles one call may fetch; long routes fall back to coarser zooms (default 64). */
  maxTiles?: number;
  /** Moving-average window in samples applied before gain/loss (default 5). */
  smoothingWindow?: number;
  /** Hysteresis threshold for gain/loss in metres (default 3). */
  thresholdM?: number;
  /** Injected tile source (tests, alternative providers). Bypasses the shared cache. */
  fetchTile?: TileFetcher;
  signal?: AbortSignal;
}

export interface ElevationsAtOptions {
  zoom?: number;
  maxTiles?: number;
  fetchTile?: TileFetcher;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Terrarium encoding: (R·256 + G + B/256) − 32768 metres. */
export function terrariumElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Width/height from the PNG IHDR chunk, without decompressing anything. */
function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  // IHDR must be the first chunk: length(4) "IHDR"(4) width(4) height(4)
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Decode a Terrarium PNG into elevations. Returns null for anything that is
 * not a 256×256 PNG (checked from the header before decompressing, so a
 * hostile or broken server cannot make us allocate a huge image). Fully
 * transparent pixels and physically impossible values become NaN (no data).
 */
export function decodeTerrariumPng(bytes: Uint8Array): DecodedTile | null {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_TILE_BYTES) return null;
  const dims = pngDimensions(bytes);
  if (!dims || dims.width !== TERRAIN_TILE_SIZE || dims.height !== TERRAIN_TILE_SIZE) return null;
  let png: PNG;
  try {
    png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    return null;
  }
  const size = TERRAIN_TILE_SIZE;
  if (png.width !== size || png.height !== size || png.data.length < size * size * 4) return null;
  const elevations = new Float32Array(size * size);
  const d = png.data;
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    if (d[o + 3] === 0) {
      elevations[i] = NaN;
      continue;
    }
    const e = terrariumElevation(d[o], d[o + 1], d[o + 2]);
    elevations[i] = e < MIN_PLAUSIBLE_M || e > MAX_PLAUSIBLE_M ? NaN : e;
  }
  return { size, elevations };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Continuous Web Mercator pixel coordinates of a point at zoom z for
 * 256-pixel tiles (tile x = floor(x / 256)). Null outside ±85.0511° latitude
 * or for invalid input.
 */
export function lngLatToWorldPixel(lng: number, lat: number, z: number): { x: number; y: number } | null {
  if (!isValidCoord([lng, lat]) || Math.abs(lat) > MERCATOR_MAX_LAT) return null;
  const world = TERRAIN_TILE_SIZE * 2 ** z;
  const phi = (lat * Math.PI) / 180;
  const x = ((lng + 180) / 360) * world;
  const y = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * world;
  return { x, y: Math.min(world, Math.max(0, y)) };
}

/** Ground size of one pixel at a latitude and zoom, metres. */
export function metersPerPixel(lat: number, z: number): number {
  return (EQUATOR_M * Math.cos((lat * Math.PI) / 180)) / (TERRAIN_TILE_SIZE * 2 ** z);
}

interface PixelRef {
  key: string;
  z: number;
  tx: number;
  ty: number;
  /** Index into the tile's elevation array. */
  index: number;
}

interface SamplePlan {
  refs: [PixelRef, PixelRef, PixelRef, PixelRef];
  /** Bilinear weights for refs (sum to 1). */
  weights: [number, number, number, number];
}

const tileKey = (z: number, x: number, y: number) => `${z}/${x}/${y}`;

/**
 * The four pixels around a point (pixel centres at integer + 0.5) and their
 * bilinear weights. x wraps around the antimeridian; y clamps at the edge of
 * the Mercator world.
 */
function planSample(lng: number, lat: number, z: number): SamplePlan | null {
  const p = lngLatToWorldPixel(lng, lat, z);
  if (!p) return null;
  const size = TERRAIN_TILE_SIZE;
  const world = size * 2 ** z;
  const u = p.x - 0.5;
  const v = p.y - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const ref = (px: number, py: number): PixelRef => {
    const gx = ((px % world) + world) % world;
    const gy = Math.min(world - 1, Math.max(0, py));
    const tx = Math.floor(gx / size);
    const ty = Math.floor(gy / size);
    return { key: tileKey(z, tx, ty), z, tx, ty, index: (gy - ty * size) * size + (gx - tx * size) };
  };
  return {
    refs: [ref(x0, y0), ref(x0 + 1, y0), ref(x0, y0 + 1), ref(x0 + 1, y0 + 1)],
    weights: [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy],
  };
}

/** Bilinear value for a planned sample; null when a contributing pixel has no data. */
function sample(plan: SamplePlan, tiles: Map<string, DecodedTile | null>): number | null {
  let sum = 0;
  for (let k = 0; k < 4; k++) {
    const tile = tiles.get(plan.refs[k].key);
    if (!tile) return null;
    const w = plan.weights[k];
    if (w === 0) continue;
    const e = tile.elevations[plan.refs[k].index];
    if (Number.isNaN(e)) return null;
    sum += w * e;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Tile cache
// ---------------------------------------------------------------------------

/**
 * Bounded LRU of decoded tiles with de-duplication of concurrent fetches.
 * Failures (null, thrown errors, undecodable bytes) are never cached, so a
 * transient outage does not poison later requests.
 */
export class TerrainTileCache {
  private readonly tiles = new Map<string, DecodedTile>();
  private readonly inflight = new Map<string, Promise<DecodedTile | null>>();

  constructor(
    private readonly fetchTile: TileFetcher,
    private readonly maxTiles = DEFAULT_TILE_CACHE_SIZE,
  ) {}

  get size(): number {
    return this.tiles.size;
  }

  clear(): void {
    this.tiles.clear();
  }

  get(z: number, x: number, y: number): Promise<DecodedTile | null> {
    const key = tileKey(z, x, y);
    const hit = this.tiles.get(key);
    if (hit) {
      // Refresh recency.
      this.tiles.delete(key);
      this.tiles.set(key, hit);
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = this.load(z, x, y, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async load(z: number, x: number, y: number, key: string): Promise<DecodedTile | null> {
    let bytes: Uint8Array | null;
    try {
      bytes = await this.fetchTile(z, x, y);
    } catch (err) {
      log.warn("elevation.tile_fetch_failed", { tile: key, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
    if (!bytes) return null;
    const decoded = decodeTerrariumPng(bytes);
    if (!decoded) {
      log.warn("elevation.tile_decode_failed", { tile: key, bytes: bytes.byteLength });
      return null;
    }
    this.tiles.set(key, decoded);
    while (this.tiles.size > this.maxTiles) {
      const oldest = this.tiles.keys().next().value as string;
      this.tiles.delete(oldest);
    }
    return decoded;
  }
}

/** Fill the {z}/{x}/{y} placeholders of a tile URL template. */
export function terrainTileUrl(template: string, z: number, x: number, y: number): string {
  if (!template.includes("{z}") || !template.includes("{x}") || !template.includes("{y}")) {
    throw new Error("TERRAIN_TILES_URL must contain {z}, {x} and {y}");
  }
  return template.replaceAll("{z}", String(z)).replaceAll("{x}", String(x)).replaceAll("{y}", String(y));
}

const defaultFetchTile: TileFetcher = async (z, x, y) => {
  const res = await providerFetch({
    provider: "terrain_tiles",
    url: terrainTileUrl(env().TERRAIN_TILES_URL, z, x, y),
    headers: { Accept: "image/png" },
    timeoutMs: 15_000,
    retries: 1,
    okStatuses: [],
  });
  return new Uint8Array(res.bytes);
};

let sharedCache: TerrainTileCache | null = null;
function defaultCache(): TerrainTileCache {
  sharedCache ??= new TerrainTileCache(defaultFetchTile);
  return sharedCache;
}

/** Drop every cached tile of the default tile source (tests, memory pressure). */
export function clearTerrainTileCache(): void {
  sharedCache?.clear();
}

// ---------------------------------------------------------------------------
// Fetch orchestration
// ---------------------------------------------------------------------------

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Resolve with `promise`, or reject as soon as `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Load tiles with bounded concurrency; the map holds null for failures. */
async function loadTiles(
  refs: Iterable<PixelRef>,
  cache: TerrainTileCache,
  signal: AbortSignal | undefined,
): Promise<Map<string, DecodedTile | null>> {
  const unique = new Map<string, PixelRef>();
  for (const r of refs) if (!unique.has(r.key)) unique.set(r.key, r);
  const queue = [...unique.values()];
  const out = new Map<string, DecodedTile | null>();
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      signal?.throwIfAborted();
      out.set(r.key, await raceAbort(cache.get(r.z, r.tx, r.ty), signal));
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker));
  return out;
}

function tileKeysOf(plans: (SamplePlan | null)[]): Set<string> {
  const keys = new Set<string>();
  for (const p of plans) if (p) for (const r of p.refs) keys.add(r.key);
  return keys;
}

function normalizeZoom(zoom: number | undefined): number {
  if (zoom === undefined || !Number.isFinite(zoom)) return DEFAULT_TERRAIN_ZOOM;
  return Math.min(MAX_TERRAIN_ZOOM, Math.max(0, Math.round(zoom)));
}

const positiveOr = (v: number | undefined, fallback: number) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback);

// ---------------------------------------------------------------------------
// Series processing (pure; exported for tests and reuse)
// ---------------------------------------------------------------------------

/**
 * Centred moving average with a symmetric window that shrinks near the ends
 * (index i averages i−h..i+h with h = min(⌊window/2⌋, i, n−1−i)). Endpoints
 * are kept as-is and linear trends pass through unchanged, so smoothing
 * removes DEM noise without shaving the start/end elevations.
 */
export function smoothSeries(values: readonly number[], window = 5): number[] {
  const n = values.length;
  const half = Math.max(0, Math.floor(window / 2));
  if (half === 0 || n < 3) return values.slice();
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const h = Math.min(half, i, n - 1 - i);
    out[i] = (prefix[i + h + 1] - prefix[i - h]) / (2 * h + 1);
  }
  return out;
}

/**
 * Total climb and descent with a hysteresis threshold: a reference elevation
 * only moves once the series has risen or fallen at least `thresholdM` from
 * it, and only that confirmed change is counted. Wiggles smaller than the
 * threshold (DEM noise, pixel steps) therefore add nothing, while sustained
 * climbs are counted in full except for a final remainder < thresholdM.
 */
export function gainLossWithHysteresis(values: readonly number[], thresholdM = 3): { gain: number; loss: number } {
  let gain = 0;
  let loss = 0;
  if (values.length < 2) return { gain, loss };
  const threshold = Math.max(0, thresholdM);
  let ref = values[0];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - ref;
    if (d >= threshold && d > 0) {
      gain += d;
      ref = values[i];
    } else if (-d >= threshold && d < 0) {
      loss -= d;
      ref = values[i];
    }
  }
  return { gain, loss };
}

/**
 * Largest-Triangle-Three-Buckets downsampling: keeps the first and last
 * points and, per bucket, the point forming the largest triangle with its
 * neighbours. Preserves peaks and valleys far better than taking every n-th
 * point. Returns a copy when no reduction is needed.
 */
export function downsampleProfile(points: readonly [number, number][], maxPoints: number): [number, number][] {
  const n = points.length;
  const m = Math.max(2, Math.floor(maxPoints));
  if (n <= m) return points.map((p) => [p[0], p[1]] as [number, number]);
  const out: [number, number][] = [points[0]];
  const every = (n - 2) / (m - 2);
  let a = 0;
  for (let i = 0; i < m - 2; i++) {
    const nextStart = Math.floor((i + 1) * every) + 1;
    const nextEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgX = 0;
    let avgY = 0;
    for (let j = nextStart; j < nextEnd; j++) {
      avgX += points[j][0];
      avgY += points[j][1];
    }
    const count = Math.max(1, nextEnd - nextStart);
    avgX /= count;
    avgY /= count;
    if (nextEnd <= nextStart) {
      avgX = points[n - 1][0];
      avgY = points[n - 1][1];
    }
    const start = Math.floor(i * every) + 1;
    const end = Math.floor((i + 1) * every) + 1;
    const [ax, ay] = points[a];
    let maxArea = -1;
    let chosen = start;
    for (let j = start; j < end; j++) {
      const area = Math.abs((ax - avgX) * (points[j][1] - ay) - (ax - points[j][0]) * (avgY - ay));
      if (area > maxArea) {
        maxArea = area;
        chosen = j;
      }
    }
    out.push(points[chosen]);
    a = chosen;
  }
  out.push(points[n - 1]);
  return out.map((p) => [p[0], p[1]] as [number, number]);
}

/**
 * Human-readable source of an elevation result. The metres figure is the
 * spacing of the tile grid we sampled (Web Mercator pixel size at this
 * latitude and zoom), NOT the resolution of the elevation model behind the
 * tiles: AWS Terrain Tiles merge DEMs from ~10 m (USGS 3DEP) to ~90 m (SRTM)
 * and coarser, by region, so a fine grid can carry upsampled coarse data.
 * The label says exactly that, and nothing about a custom tile server's data.
 */
export function elevationSourceLabel(lat: number, z: number, tilesUrl: string = env().TERRAIN_TILES_URL): string {
  const grid = `sampled on a ~${Math.max(1, Math.round(metersPerPixel(lat, z)))} m grid`;
  return tilesUrl.includes("elevation-tiles-prod")
    ? `AWS Terrain Tiles, ${grid}; source data resolution varies by region (estimate)`
    : `Terrarium terrain tiles, ${grid} (estimate)`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Elevation profile, gain/loss and extremes for a route.
 *
 * Method
 *  1. Each line is resampled every `spacingM` (30 m) metres, keeping its first
 *     and last vertex; spacing grows for long routes so the total stays near
 *     `maxSamples` (every line keeps its two endpoints, so the cap is soft
 *     for geometries with more than maxSamples/2 lines).
 *  2. Every sample is read from the DEM with bilinear interpolation. If the
 *     route needs more than `maxTiles` tiles at the requested zoom, coarser
 *     zooms are tried (down to 10); the source label states the grid used.
 *  3. Gain/loss: per line, the samples are smoothed with a centred moving
 *     average (5 samples ≈ 120 m at default spacing) and accumulated with a
 *     3 m hysteresis threshold (see gainLossWithHysteresis). Lines are summed;
 *     the jump between disconnected lines is never counted.
 *  4. max/min come from the unsmoothed samples; the profile is the
 *     unsmoothed series downsampled with LTTB to `profilePoints` points
 *     (distance rounded to 1 m, elevation to 0.1 m).
 *
 * Returns null when the geometry is empty or outside Web Mercator coverage,
 * when the tile budget cannot be met, or when any needed tile is unavailable
 * or a sample has no data. Rejects only when `signal` aborts.
 */
export async function elevationProfileFor(lines: Line[], opts: ElevationProfileOptions = {}): Promise<ElevationResult | null> {
  opts.signal?.throwIfAborted();
  const clean = cleanLines(lines);
  if (clean.length === 0) return null;

  const spacingM = positiveOr(opts.spacingM, 30);
  const maxSamples = Math.max(2, Math.floor(positiveOr(opts.maxSamples, 1500)));
  const profilePoints = Math.max(2, Math.floor(positiveOr(opts.profilePoints, 300)));
  const maxTiles = Math.max(1, Math.floor(positiveOr(opts.maxTiles, DEFAULT_MAX_TILES)));
  const window = Math.max(1, Math.floor(positiveOr(opts.smoothingWindow, 5)));
  const thresholdM = opts.thresholdM !== undefined && Number.isFinite(opts.thresholdM) && opts.thresholdM >= 0 ? opts.thresholdM : 3;

  // 1. Sample positions.
  const lengths = clean.map(lineLengthM);
  const totalM = lengths.reduce((a, b) => a + b, 0);
  if (!(totalM > 0)) return null;
  const budget = Math.max(1, maxSamples - 2 * clean.length);
  const spacing = Math.max(spacingM, totalM / budget);
  const perLine = clean.map((l) => resampleLine(l, spacing));
  const points = perLine.flat();

  // 2. Choose a zoom within the tile budget.
  const requestedZoom = normalizeZoom(opts.zoom);
  const floorZoom = Math.min(requestedZoom, MIN_FALLBACK_ZOOM);
  let zoom = requestedZoom;
  let plans = points.map((p) => planSample(p.lng, p.lat, zoom));
  if (plans.some((p) => p === null)) return null;
  while (tileKeysOf(plans).size > maxTiles && zoom > floorZoom) {
    zoom -= 1;
    plans = points.map((p) => planSample(p.lng, p.lat, zoom));
  }
  if (tileKeysOf(plans).size > maxTiles) {
    log.warn("elevation.tile_budget_exceeded", { tiles: tileKeysOf(plans).size, maxTiles, zoom });
    return null;
  }

  // 3. Fetch tiles and sample.
  const cache = opts.fetchTile ? new TerrainTileCache(opts.fetchTile, Number.MAX_SAFE_INTEGER) : defaultCache();
  const tiles = await loadTiles(
    plans.flatMap((p) => (p ? p.refs : [])),
    cache,
    opts.signal,
  );
  for (const t of tiles.values()) if (!t) return null;
  const values: number[] = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const v = sample(plans[i]!, tiles);
    if (v === null) return null;
    values[i] = v;
  }

  // 4. Per-line gain/loss, extremes and the concatenated profile.
  let gain = 0;
  let loss = 0;
  let maxM = -Infinity;
  let minM = Infinity;
  const series: [number, number][] = [];
  let offset = 0;
  let cursor = 0;
  perLine.forEach((linePoints, li) => {
    const elev = values.slice(cursor, cursor + linePoints.length);
    cursor += linePoints.length;
    const gl = gainLossWithHysteresis(smoothSeries(elev, window), thresholdM);
    gain += gl.gain;
    loss += gl.loss;
    for (let i = 0; i < elev.length; i++) {
      maxM = Math.max(maxM, elev[i]);
      minM = Math.min(minM, elev[i]);
      series.push([offset + linePoints[i].distM, elev[i]]);
    }
    offset += lengths[li];
  });

  const profile = downsampleProfile(series, profilePoints).map(
    ([d, e]) => [Math.round(d), Math.round(e * 10) / 10] as [number, number],
  );
  const midLat = points[Math.floor(points.length / 2)].lat;
  return {
    profile,
    gainM: Math.round(gain),
    lossM: Math.round(loss),
    maxM: Math.round(maxM),
    minM: Math.round(minM),
    samples: points.length,
    source: elevationSourceLabel(midLat, zoom),
  };
}

/**
 * DEM elevation (metres, 0.1 m precision; an estimate) at each point, in
 * input order. A point is null when it is invalid, outside Web Mercator
 * coverage, needs a tile that is unavailable or beyond `maxTiles` (tiles are
 * admitted in point order), or falls on a no-data pixel. Rejects only when
 * `signal` aborts.
 */
export async function elevationsAt(points: LngLat[], opts: ElevationsAtOptions = {}): Promise<(number | null)[]> {
  opts.signal?.throwIfAborted();
  if (!Array.isArray(points) || points.length === 0) return [];
  const zoom = normalizeZoom(opts.zoom);
  const maxTiles = Math.max(1, Math.floor(positiveOr(opts.maxTiles, DEFAULT_MAX_TILES)));

  const admitted = new Set<string>();
  const plans = points.map((p) => {
    const plan = p && typeof p === "object" ? planSample(p.lng, p.lat, zoom) : null;
    if (!plan) return null;
    const keys = new Set(plan.refs.map((r) => r.key));
    const extra = [...keys].filter((k) => !admitted.has(k));
    if (admitted.size + extra.length > maxTiles) return null;
    for (const k of extra) admitted.add(k);
    return plan;
  });

  const cache = opts.fetchTile ? new TerrainTileCache(opts.fetchTile, Number.MAX_SAFE_INTEGER) : defaultCache();
  const tiles = await loadTiles(
    plans.flatMap((p) => (p ? p.refs : [])),
    cache,
    opts.signal,
  );
  return plans.map((plan) => {
    if (!plan) return null;
    const v = sample(plan, tiles);
    return v === null ? null : Math.round(v * 10) / 10;
  });
}
