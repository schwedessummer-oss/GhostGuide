/**
 * Local stand-ins for the external data providers, so the e2e suite runs
 * without internet and against deterministic, RECORDED provider answers
 * (tests/e2e/fixtures, see its README for provenance and licences).
 *
 *   POST /overpass/api/interpreter                Overpass API (bbox parsed from the query)
 *   GET  /nominatim/search, /nominatim/reverse    Nominatim
 *   GET  /metno/locationforecast/2.0/complete     MET Norway Locationforecast
 *   GET  /nws/alerts/active                       US National Weather Service alerts
 *   GET  /terrarium/{z}/{x}/{y}.png               Terrarium terrain tiles
 *   GET  /style.json, /fonts/{stack}/{range}.pbf  a blank MapLibre style (background only)
 *
 * Behaviour (defaults; see `setMock` / POST /__mock/control):
 *   - Overpass, outdoor layer: the recorded Table Rock State Park response for
 *     the 0.25° catalog tile containing Table Rock (-82.72, 35.05), answered
 *     after `overpass.fixtureDelayMs` (so the on-demand "loading" state is
 *     observable); a valid response without elements for every other tile and
 *     for the services layer (no services sample has been recorded).
 *     Per-tile overrides simulate slow or failing tiles:
 *       { "overpass": { "tiles": { "0.25/389/500": { "mode": "slow", "delayMs": 20000 } } } }
 *       modes: "fixture" | "empty" | "slow" | "fail" (HTTP `status`, default 504)
 *              | "runtime_error" (HTTP 200 with an Overpass runtime-error remark)
 *   - Nominatim search: known queries map to recorded answers, anything else
 *     is an empty answer ([]); reverse: recorded answers per 0.1° cell centre,
 *     HTTP 503 (unavailable) for cells without a recording — never invented.
 *   - MET Norway: the recorded forecast nearest to the point (within 150 km),
 *     else HTTP 503. Expires is one hour ahead. The recording's timestamps
 *     are moved forward by WHOLE DAYS when needed so the series still covers
 *     "now" (values and day/night alignment unchanged; documented in the
 *     fixtures README). If-Modified-Since is honoured (304).
 *   - NWS: the recorded empty FeatureCollection (no active alerts).
 *   - Terrain: recorded tiles where available, else a generated flat tile.
 *   - Every provider can be switched to { "mode": "fail" } (HTTP 503).
 *
 * Control API (used by specs through tests/e2e/helpers.mjs):
 *   GET  /__mock/health
 *   GET  /__mock/requests?provider=overpass   request log (newest last)
 *   POST /__mock/control   JSON patch, deep-merged into the settings
 *   POST /__mock/reset     default settings, empty request log
 *
 * Plain node:http, no dependencies besides pngjs (already a dependency).
 */
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures");
const SHARED_FIXTURES = path.resolve(here, "../fixtures");

/** Table Rock State Park, SC: the area with a recorded Overpass response. */
export const TABLE_ROCK = Object.freeze({ lng: -82.72, lat: 35.05 });
/** Catalog tile grid (src/server/geo/tiles.ts). */
export const TILE_DEG = 0.25;

export function tileKeyFor(lng, lat) {
  const ix = Math.floor((lng + 180) / TILE_DEG);
  const iy = Math.floor((lat + 90) / TILE_DEG);
  return `${TILE_DEG}/${ix}/${iy}`;
}
export const TABLE_ROCK_TILE = tileKeyFor(TABLE_ROCK.lng, TABLE_ROCK.lat);

const readJson = (file) => JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8"));

/** Nominatim forward answers by normalized query (lower case, single spaces). */
const SEARCH_FIXTURES = {
  "table rock state park": "nominatim/search-table-rock-state-park.json",
  "table rock": "nominatim/search-table-rock.json",
  banff: "nominatim/search-banff.json",
};

/** Nominatim reverse answers by requested cell centre "lat_lon" (one decimal, as the app asks). */
const REVERSE_FIXTURES = {
  "35.0_-82.7": "nominatim/reverse-35.0_-82.7.json",
  "35.0_-82.8": "nominatim/reverse-35.0_-82.8.json",
  "35.1_-82.7": "nominatim/reverse-35.1_-82.7.json",
};

/** MET Norway recordings and the point each was requested for. */
const METNO_FIXTURES = [
  { file: "metno/complete-table-rock-sc.json", lat: 35.033, lng: -82.7 },
  { file: "metno/complete-banff-ab.json", lat: 51.176, lng: -115.563 },
];
const METNO_MAX_DISTANCE_KM = 150;

const DEFAULTS = Object.freeze({
  overpass: { mode: "normal", fixtureDelayMs: 2_500, tiles: {} },
  nominatim: { mode: "normal" },
  metno: { mode: "normal" },
  nws: { mode: "normal" },
  terrain: { mode: "normal" },
});

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) delete target[k];
    else if (isObj(v) && isObj(target[k])) deepMerge(target[k], v);
    else target[k] = clone(v);
  }
  return target;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// Overpass
// ---------------------------------------------------------------------------

/** The first "(south,west,north,east)" filter of an Overpass QL query, as [w, s, e, n]. */
export function bboxFromOverpassQuery(query) {
  const num = String.raw`(-?\d+(?:\.\d+)?)`;
  const m = new RegExp(String.raw`\(${num},${num},${num},${num}\)`).exec(query ?? "");
  if (!m) return null;
  const [s, w, n, e] = m.slice(1).map(Number);
  return [w, s, e, n];
}

function overpassBody(elements, timestamp) {
  return {
    version: 0.6,
    generator: "Overpass API (Ghost Guide e2e mock)",
    osm3s: {
      timestamp_osm_base: timestamp,
      copyright: "The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.",
    },
    elements,
  };
}

// ---------------------------------------------------------------------------
// MET Norway
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** A recording re-dated by whole days so its hourly part covers `now` (unchanged when it already does). */
function metnoDocument(fixture, now) {
  const doc = readJson(fixture.file);
  const series = doc.properties?.timeseries ?? [];
  const first = series.length ? Date.parse(series[0].time) : NaN;
  const shiftDays = Number.isFinite(first) ? Math.max(0, Math.floor((now - first) / DAY_MS)) : 0;
  if (shiftDays > 0) {
    const shift = (iso) => new Date(Date.parse(iso) + shiftDays * DAY_MS).toISOString().replace(".000Z", "Z");
    for (const step of series) step.time = shift(step.time);
    if (doc.properties?.meta?.updated_at) doc.properties.meta.updated_at = shift(doc.properties.meta.updated_at);
  }
  return { doc, shiftDays };
}

// ---------------------------------------------------------------------------
// Terrain tiles
// ---------------------------------------------------------------------------

let flatTile = null;
/** A 256×256 Terrarium tile at 0 m (R=128, G=0, B=0). */
function flatTerrariumPng() {
  if (flatTile) return flatTile;
  const png = new PNG({ width: 256, height: 256, colorType: 2 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 128;
    png.data[i + 1] = 0;
    png.data[i + 2] = 0;
    png.data[i + 3] = 255;
  }
  flatTile = PNG.sync.write(png, { colorType: 2 });
  return flatTile;
}

function terrainFixture(z, x, y) {
  const name = `terrarium-${z}-${x}-${y}.png`;
  for (const dir of [path.join(FIXTURES, "terrain"), path.join(SHARED_FIXTURES, "terrain")]) {
    const file = path.join(dir, name);
    if (existsSync(file)) return readFileSync(file);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const payload = body === undefined || body === null ? "" : isBuffer || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "no-store",
    ...(isBuffer || typeof body === "string" ? {} : { "Content-Type": "application/json; charset=utf-8" }),
    ...headers,
  });
  res.end(payload);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Start the mock providers. Resolves to { url, port, close(), settings(), reset(), set(patch), requests() }.
 * `port: 0` picks a free port.
 */
export async function startMockProviders({ port = 0, host = "127.0.0.1", quiet = true } = {}) {
  let settings = clone(DEFAULTS);
  let log = [];
  const tableRock = readJson("osm/table-rock-outdoor.json");
  const osmTimestamp = tableRock.osm3s?.timestamp_osm_base ?? null;
  let base = "";

  const record = (entry) => {
    log.push({ at: new Date().toISOString(), ...entry });
    if (log.length > 5_000) log = log.slice(-4_000);
    if (!quiet) console.log(`[mock] ${entry.provider} ${entry.method} ${entry.path} → ${entry.status ?? ""} ${entry.note ?? ""}`);
  };

  async function overpass(req, res, url) {
    const raw = req.method === "POST" ? await readBody(req) : "";
    const form = new URLSearchParams(raw);
    const query = form.get("data") ?? url.searchParams.get("data") ?? "";
    const bbox = bboxFromOverpassQuery(query);
    const layer = /"route"="hiking"/.test(query) ? "outdoor" : "services";
    const ua = req.headers["user-agent"] ?? null;
    if (!bbox) {
      record({ provider: "overpass", method: req.method, path: url.pathname, status: 400, ua, note: "no bbox in query" });
      return send(res, 400, "Error: could not parse the query (mock)", { "Content-Type": "text/plain" });
    }
    const centre = { lng: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 };
    const tileKey = tileKeyFor(centre.lng, centre.lat);
    const s = settings.overpass;
    const override = s.mode === "fail" ? { mode: "fail", status: s.status } : (s.tiles?.[tileKey] ?? null);
    const hasFixture = layer === "outdoor" && tileKey === TABLE_ROCK_TILE;
    const mode = override?.mode ?? (hasFixture ? "fixture" : "empty");
    const entry = { provider: "overpass", method: req.method, path: url.pathname, layer, tileKey, bbox, ua, mode };

    if (mode === "slow" || (mode === "fixture" && s.fixtureDelayMs > 0)) {
      await sleep(mode === "slow" ? Number(override?.delayMs ?? 20_000) : Number(s.fixtureDelayMs));
      // (req.destroyed is already true once the body was read; the socket tells whether the client left.)
      if (!res.socket || res.socket.destroyed) return record({ ...entry, status: null, note: "client gave up" });
    }
    if (mode === "fail") {
      const status = Number(override?.status ?? 504);
      record({ ...entry, status });
      return send(res, status, `<html><body>Mock Overpass failure (${status})</body></html>`, { "Content-Type": "text/html" });
    }
    if (mode === "runtime_error") {
      record({ ...entry, status: 200 });
      return send(res, 200, { ...overpassBody([], osmTimestamp), remark: "runtime error: Query timed out in \"query\" at line 3 after 90 seconds." });
    }
    const useFixture = mode === "fixture" || (mode === "slow" && hasFixture);
    record({ ...entry, status: 200, note: useFixture ? "fixture" : "empty" });
    return send(res, 200, useFixture ? tableRock : overpassBody([], osmTimestamp));
  }

  function nominatim(req, res, url, kind) {
    const ua = req.headers["user-agent"] ?? null;
    if (settings.nominatim.mode === "fail") {
      record({ provider: "nominatim", method: req.method, path: url.pathname, status: 503, ua });
      return send(res, 503, "<html><body>Service unavailable (mock)</body></html>", { "Content-Type": "text/html" });
    }
    if (kind === "search") {
      const q = (url.searchParams.get("q") ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
      const file = SEARCH_FIXTURES[q];
      record({ provider: "nominatim", method: req.method, path: url.pathname, query: q, status: 200, ua, note: file ? "fixture" : "no results" });
      return send(res, 200, file ? readJson(file) : []);
    }
    const lat = Number(url.searchParams.get("lat"));
    const lon = Number(url.searchParams.get("lon"));
    const key = `${lat.toFixed(1)}_${lon.toFixed(1)}`;
    const file = REVERSE_FIXTURES[key];
    record({ provider: "nominatim", method: req.method, path: url.pathname, query: key, status: file ? 200 : 503, ua, note: file ? "fixture" : "no recording" });
    if (!file) return send(res, 503, "<html><body>No recorded reverse answer for this cell (mock)</body></html>", { "Content-Type": "text/html" });
    return send(res, 200, readJson(file));
  }

  function metno(req, res, url) {
    const ua = req.headers["user-agent"] ?? null;
    const point = { lat: Number(url.searchParams.get("lat")), lng: Number(url.searchParams.get("lon")) };
    const entry = { provider: "metno", method: req.method, path: url.pathname, query: `${point.lat},${point.lng}`, ua };
    if (settings.metno.mode === "fail") {
      record({ ...entry, status: 503 });
      return send(res, 503, "<html><body>Service unavailable (mock)</body></html>", { "Content-Type": "text/html" });
    }
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
      record({ ...entry, status: 400 });
      return send(res, 400, { error: "lat and lon are required" });
    }
    const nearest = METNO_FIXTURES.map((f) => ({ f, d: haversineKm(point, f) })).sort((a, b) => a.d - b.d)[0];
    if (!nearest || nearest.d > METNO_MAX_DISTANCE_KM) {
      record({ ...entry, status: 503, note: "no recording near this point" });
      return send(res, 503, "<html><body>No recorded forecast near this point (mock)</body></html>", { "Content-Type": "text/html" });
    }
    const now = Date.now();
    const { doc, shiftDays } = metnoDocument(nearest.f, now);
    const updated = Date.parse(doc.properties?.meta?.updated_at ?? "");
    const lastModified = Number.isFinite(updated) ? new Date(updated).toUTCString() : new Date(now).toUTCString();
    const headers = {
      "Content-Type": "application/json",
      Date: new Date(now).toUTCString(),
      Expires: new Date(now + 3_600_000).toUTCString(),
      "Last-Modified": lastModified,
    };
    const ims = Date.parse(req.headers["if-modified-since"] ?? "");
    if (Number.isFinite(ims) && Number.isFinite(updated) && Math.floor(updated / 1000) <= Math.floor(ims / 1000)) {
      record({ ...entry, status: 304, note: nearest.f.file });
      res.writeHead(304, { "Access-Control-Allow-Origin": "*", ...headers });
      return res.end();
    }
    record({ ...entry, status: 200, note: `${nearest.f.file}${shiftDays ? ` (+${shiftDays} d)` : ""}` });
    return send(res, 200, JSON.stringify(doc), headers);
  }

  function nws(req, res, url) {
    const ua = req.headers["user-agent"] ?? null;
    const entry = { provider: "nws", method: req.method, path: url.pathname, query: url.searchParams.get("point"), ua };
    if (settings.nws.mode === "fail") {
      record({ ...entry, status: 503 });
      return send(res, 503, { title: "Service unavailable (mock)", status: 503 }, { "Content-Type": "application/problem+json" });
    }
    record({ ...entry, status: 200 });
    return send(res, 200, JSON.stringify(readJson("nws/alerts-active-table-rock-sc.json")), { "Content-Type": "application/geo+json" });
  }

  function terrain(req, res, url, z, x, y) {
    const ua = req.headers["user-agent"] ?? null;
    const entry = { provider: "terrain_tiles", method: req.method, path: url.pathname, query: `${z}/${x}/${y}`, ua };
    if (settings.terrain.mode === "fail") {
      record({ ...entry, status: 503 });
      return send(res, 503, "unavailable (mock)", { "Content-Type": "text/plain" });
    }
    const recorded = terrainFixture(z, x, y);
    record({ ...entry, status: 200, note: recorded ? "fixture" : "flat" });
    return send(res, 200, recorded ?? flatTerrariumPng(), { "Content-Type": "image/png" });
  }

  function style(res) {
    return send(res, 200, {
      version: 8,
      name: "Ghost Guide e2e (blank)",
      glyphs: `${base}/fonts/{fontstack}/{range}.pbf`,
      sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": "#eae6dc" } }],
    });
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? "/", "http://mock.local");
    } catch {
      return send(res, 400, { error: "bad url" });
    }
    try {
      if (req.method === "OPTIONS") return send(res, 204, "");
      const p = url.pathname;

      if (p === "/__mock/health") return send(res, 200, { ok: true });
      if (p === "/__mock/requests") {
        const provider = url.searchParams.get("provider");
        return send(res, 200, provider ? log.filter((r) => r.provider === provider) : log);
      }
      if (p === "/__mock/settings") return send(res, 200, settings);
      if (p === "/__mock/control" && req.method === "POST") {
        deepMerge(settings, JSON.parse((await readBody(req)) || "{}"));
        return send(res, 200, settings);
      }
      if (p === "/__mock/reset" && req.method === "POST") {
        settings = clone(DEFAULTS);
        log = [];
        return send(res, 200, settings);
      }

      if (p === "/overpass/api/interpreter" || p === "/api/interpreter") return await overpass(req, res, url);
      if (p === "/nominatim/search" || p === "/search") return nominatim(req, res, url, "search");
      if (p === "/nominatim/reverse" || p === "/reverse") return nominatim(req, res, url, "reverse");
      if (p === "/metno/locationforecast/2.0/complete" || p === "/locationforecast/2.0/complete") return metno(req, res, url);
      if (p === "/nws/alerts/active" || p === "/alerts/active") return nws(req, res, url);
      const tile = /^\/terrarium\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/.exec(p);
      if (tile) return terrain(req, res, url, Number(tile[1]), Number(tile[2]), Number(tile[3]));
      if (p === "/style.json") return style(res);
      if (p.startsWith("/fonts/")) return send(res, 200, Buffer.alloc(0), { "Content-Type": "application/x-protobuf" });

      record({ provider: "unknown", method: req.method, path: p, status: 404 });
      return send(res, 404, { error: `no mock for ${req.method} ${p}` });
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  base = `http://${host}:${actualPort}`;

  return {
    url: base,
    port: actualPort,
    settings: () => clone(settings),
    set: (patch) => deepMerge(settings, patch),
    reset: () => {
      settings = clone(DEFAULTS);
      log = [];
    },
    requests: (provider) => (provider ? log.filter((r) => r.provider === provider) : [...log]),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Server-side environment pointing the app at a running mock. */
export function mockProviderEnv(mockUrl) {
  return {
    OVERPASS_URLS: `${mockUrl}/overpass/api/interpreter`,
    NOMINATIM_URL: `${mockUrl}/nominatim`,
    METNO_URL: `${mockUrl}/metno`,
    NWS_URL: `${mockUrl}/nws`,
    TERRAIN_TILES_URL: `${mockUrl}/terrarium/{z}/{x}/{y}.png`,
    NEXT_PUBLIC_MAP_STYLE_URL: `${mockUrl}/style.json`,
    NEXT_PUBLIC_MAP_TERRAIN_TILES_URL: "off",
  };
}

// Standalone: `node tests/e2e/mock-providers.mjs [port]` (handy when debugging a spec by hand).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mock = await startMockProviders({ port: Number(process.argv[2] ?? 3299), quiet: false });
  console.log(`Mock providers listening at ${mock.url}`);
  console.log(JSON.stringify(mockProviderEnv(mock.url), null, 2));
}
