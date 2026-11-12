/**
 * Recreation.gov RIDB provider: metadata, isEnabled with/without a key,
 * the radius search (URL, apikey header, timeout/retries), pagination and its
 * bound, error handling (never a silent empty result), and the registry
 * entry (RIDB is listed after OSM and only offered when enabled).
 * providerFetch is mocked: no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderFetchOptions, ProviderResponse } from "@/server/providers/http";

vi.mock("@/server/providers/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/providers/http")>();
  return { ...actual, providerFetch: vi.fn() };
});

import { resetEnvCache } from "@/config/env";
import type { Bbox } from "@/domain/catalog";
import { haversineM } from "@/domain/geo";
import { tileFromKey } from "@/server/geo/tiles";
import { ProviderError, providerFetch } from "@/server/providers/http";
import {
  RIDB_MAX_PAGES,
  RIDB_MAX_RADIUS_MILES,
  RIDB_PAGE_LIMIT,
  RIDB_TIMEOUT_MS,
  facilitiesUrl,
  ridbProvider,
  searchCircle,
} from "@/server/trails/providers/ridb";
import { TRAIL_PROVIDERS, enabledProviders, providerById, providersFor } from "@/server/trails/providers/registry";
import page from "../../fixtures/ridb/facilities-union-creek-tile.json";

const fetchMock = vi.mocked(providerFetch);
const TILE: Bbox = [-118.25, 44.5, -118.0, 44.75];
const KEY = "test-ridb-key-0123456789";

function respond(body: unknown, raw?: string, status = 200): ProviderResponse {
  const text = raw ?? JSON.stringify(body);
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    bytes: new TextEncoder().encode(text).buffer as ArrayBuffer,
    text: () => text,
    json: <T,>() => JSON.parse(text) as T,
  };
}

/** A schema-shaped page of `count` trailheads inside TILE, ids starting at `from`. */
function trailheadPage(from: number, count: number, total: number | null, offset: number) {
  const base = page.RECDATA.find((r) => r.FacilityID === "990002")!;
  const RECDATA = Array.from({ length: count }, (_, i) => ({
    ...base,
    FacilityID: String(800000 + from + i),
    FacilityName: `Example Trailhead ${from + i}`,
    FacilityLongitude: -118.2 + ((from + i) % 100) * 0.001,
    FacilityLatitude: 44.6,
  }));
  return {
    RECDATA,
    METADATA: { RESULTS: { CURRENT_COUNT: count, ...(total === null ? {} : { TOTAL_COUNT: total }) }, PARAMETERS: { QUERY: "", LIMIT: 50, OFFSET: offset } },
  };
}

const saved = { ...process.env };
beforeEach(() => {
  fetchMock.mockReset();
  process.env.RIDB_API_KEY = KEY;
  delete process.env.RIDB_URL;
  resetEnvCache();
});
afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

const callOpts = (i: number) => fetchMock.mock.calls[i][0] as ProviderFetchOptions;
const callUrl = (i: number) => new URL(callOpts(i).url);

describe("ridb provider: metadata and enablement", () => {
  it("describes Recreation.gov RIDB on the outdoor layer only", () => {
    expect(ridbProvider.id).toBe("ridb");
    expect(ridbProvider.label).toBe("Recreation.gov");
    expect(ridbProvider.layers).toEqual(["outdoor"]);
    expect(ridbProvider.license).toBe("US Government work (public domain)");
    expect(ridbProvider.attribution).toBe("Recreation.gov (RIDB)");
    expect(ridbProvider.homepage).toBe("https://ridb.recreation.gov");
  });

  it("is enabled only when RIDB_API_KEY is set (blank counts as missing)", () => {
    expect(ridbProvider.isEnabled()).toBe(true);
    delete process.env.RIDB_API_KEY;
    resetEnvCache();
    expect(ridbProvider.isEnabled()).toBe(false);
    process.env.RIDB_API_KEY = "   ";
    resetEnvCache();
    expect(ridbProvider.isEnabled()).toBe(false);
  });

  it("refuses to fetch without a key (no request is made)", async () => {
    delete process.env.RIDB_API_KEY;
    resetEnvCache();
    const err = await ridbProvider.fetchArea("outdoor", TILE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ridb provider: registry", () => {
  it("is registered after OpenStreetMap", () => {
    expect(TRAIL_PROVIDERS.map((p) => p.id)).toEqual(["osm", "ridb"]);
    expect(providerById("ridb")).toBe(ridbProvider);
  });

  it("is offered for US outdoor areas only when a key is configured", () => {
    expect(enabledProviders("outdoor").map((p) => p.id)).toEqual(["osm", "ridb"]);
    expect(enabledProviders("services").map((p) => p.id)).toEqual(["osm"]);
    expect(providersFor("outdoor", TILE).map((p) => p.id)).toEqual(["osm", "ridb"]);
    expect(providersFor("outdoor", [7.5, 46.5, 7.75, 46.75]).map((p) => p.id)).toEqual(["osm"]);

    delete process.env.RIDB_API_KEY;
    resetEnvCache();
    expect(enabledProviders("outdoor").map((p) => p.id)).toEqual(["osm"]);
    expect(providersFor("outdoor", TILE).map((p) => p.id)).toEqual(["osm"]);
    // Still known by id (e.g. for stored tiles), just not offered.
    expect(providerById("ridb")).toBe(ridbProvider);
  });
});

describe("ridb provider: search circle", () => {
  it("centres on the bbox and reaches its farthest corner, rounded up", () => {
    const c = searchCircle(TILE);
    expect(c.lat).toBe(44.625);
    expect(c.lng).toBe(-118.125);
    const cornerMiles = haversineM({ lat: 44.625, lng: -118.125 }, { lat: 44.5, lng: -118.25 }) / 1609.344;
    expect(c.radiusMiles).toBeGreaterThanOrEqual(cornerMiles);
    expect(c.radiusMiles).toBeLessThan(cornerMiles * 1.05);
    expect(Number.isInteger(c.radiusMiles * 100)).toBe(true);
  });

  it("fits 0.25° tiles from American Samoa and the Keys to the North Slope within the API's 25-mile maximum", () => {
    for (const key of ["0.25/37/302", "0.25/392/458", "0.25/247/538", "0.25/94/644", "0.25/7/565"]) {
      const tile = tileFromKey("outdoor", key)!;
      expect(searchCircle(tile.bbox).radiusMiles).toBeLessThan(RIDB_MAX_RADIUS_MILES);
    }
  });

  it("rejects invalid bboxes and areas larger than one search allows", () => {
    expect(() => searchCircle([1, 2, 1, 3] as Bbox)).toThrow(RangeError);
    expect(() => searchCircle([Number.NaN, 0, 1, 1] as Bbox)).toThrow(RangeError);
    expect(() => searchCircle([-120, 40, -118, 42])).toThrow(/too large/);
  });

  it("builds the documented facilities query", () => {
    const url = new URL(facilitiesUrl("https://ridb.example.org/api/v1/", { lat: 44.625, lng: -118.125, radiusMiles: 12.34 }, 100));
    expect(url.origin + url.pathname).toBe("https://ridb.example.org/api/v1/facilities");
    expect(Object.fromEntries(url.searchParams)).toEqual({ latitude: "44.625", longitude: "-118.125", radius: "12.34", limit: "50", offset: "100" });
  });
});

describe("ridb provider: fetchArea", () => {
  it("sends one radius search with the apikey header and returns POIs inside the tile, no trails", async () => {
    fetchMock.mockResolvedValueOnce(respond(page));
    const r = await ridbProvider.fetchArea("outdoor", TILE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const o = callOpts(0);
    expect(o.provider).toBe("ridb");
    expect(o.method ?? "GET").toBe("GET");
    expect(o.headers).toEqual({ apikey: KEY });
    expect(o.timeoutMs).toBe(RIDB_TIMEOUT_MS);
    expect(o.retries).toBe(1);
    const url = callUrl(0);
    expect(url.origin + url.pathname).toBe("https://ridb.recreation.gov/api/v1/facilities");
    expect(url.searchParams.get("latitude")).toBe("44.625");
    expect(url.searchParams.get("longitude")).toBe("-118.125");
    expect(url.searchParams.get("limit")).toBe(String(RIDB_PAGE_LIMIT));
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.toString()).not.toContain(KEY);

    expect(r.trails).toEqual([]);
    expect(r.dataTimestamp).toBeNull();
    expect(r.pois.map((p) => p.providerId)).toEqual([
      "facility/233115", "facility/990001", "facility/990002", "facility/990003", "facility/990004", "facility/990005",
    ]);
    for (const p of r.pois) {
      expect(p.layer).toBe("outdoor");
      expect(p.lng).toBeGreaterThanOrEqual(TILE[0]);
      expect(p.lng).toBeLessThanOrEqual(TILE[2]);
    }
  });

  it("uses RIDB_URL as the base", async () => {
    process.env.RIDB_URL = "http://127.0.0.1:9999/ridb/api/v1";
    resetEnvCache();
    fetchMock.mockResolvedValueOnce(respond({ RECDATA: [], METADATA: { RESULTS: { CURRENT_COUNT: 0, TOTAL_COUNT: 0 } } }));
    const r = await ridbProvider.fetchArea("outdoor", TILE);
    expect(callOpts(0).url.startsWith("http://127.0.0.1:9999/ridb/api/v1/facilities?")).toBe(true);
    expect(r.pois).toEqual([]);
  });

  it("pages with limit/offset until TOTAL_COUNT is reached", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(trailheadPage(0, 50, 120, 0)))
      .mockResolvedValueOnce(respond(trailheadPage(50, 50, 120, 50)))
      .mockResolvedValueOnce(respond(trailheadPage(100, 20, 120, 100)));
    const r = await ridbProvider.fetchArea("outdoor", TILE);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((i) => callUrl(i).searchParams.get("offset"))).toEqual(["0", "50", "100"]);
    expect(r.pois).toHaveLength(120);
  });

  it("stops when a full page reaches TOTAL_COUNT exactly, or when a page is short without a total", async () => {
    fetchMock.mockResolvedValueOnce(respond(trailheadPage(0, 50, 50, 0)));
    expect((await ridbProvider.fetchArea("outdoor", TILE)).pois).toHaveLength(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(respond(trailheadPage(0, 50, null, 0))).mockResolvedValueOnce(respond(trailheadPage(50, 3, null, 50)));
    expect((await ridbProvider.fetchArea("outdoor", TILE)).pois).toHaveLength(53);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it(`requests at most ${RIDB_MAX_PAGES} pages and then fails instead of returning a partial list`, async () => {
    fetchMock.mockImplementation(async (o: ProviderFetchOptions) => {
      const offset = Number(new URL(o.url).searchParams.get("offset"));
      return respond(trailheadPage(offset, 50, 5000, offset));
    });
    const err = await ridbProvider.fetchArea("outdoor", TILE).catch((e: unknown) => e);
    expect(fetchMock).toHaveBeenCalledTimes(RIDB_MAX_PAGES);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect((err as ProviderError).message).toMatch(/More than 500 RIDB facilities/);
  });

  it("treats malformed bodies as retryable provider errors, never as an empty area", async () => {
    for (const body of [{ error: "x" }, { RECDATA: "nope" }, []]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(respond(body));
      const err = await ridbProvider.fetchArea("outdoor", TILE).catch((e: unknown) => e);
      expect(err, JSON.stringify(body)).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable).toBe(true);
    }
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(respond(null, "<html>maintenance</html>"));
    const err = await ridbProvider.fetchArea("outdoor", TILE).catch((e: unknown) => e);
    expect((err as ProviderError).message).toMatch(/not valid JSON/);
    expect((err as ProviderError).retryable).toBe(true);
  });

  it("fails a page in the middle as a whole (no partial result)", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(trailheadPage(0, 50, 120, 0)))
      .mockRejectedValueOnce(new ProviderError("ridb", "HTTP 503", 503, true));
    const err = await ridbProvider.fetchArea("outdoor", TILE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(503);
    expect((err as ProviderError).retryable).toBe(true);
  });

  it("explains a rejected key and does not retry it", async () => {
    fetchMock.mockRejectedValueOnce(new ProviderError("ridb", "HTTP 401", 401, false));
    const err = await ridbProvider.fetchArea("outdoor", TILE).catch((e: unknown) => e);
    expect((err as ProviderError).message).toMatch(/rejected the API key \(HTTP 401\)/);
    expect((err as ProviderError).message).not.toContain(KEY);
    expect((err as ProviderError).retryable).toBe(false);
  });

  it("stops between pages when aborted", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      return respond(trailheadPage(0, 50, 120, 0));
    });
    const err = await ridbProvider.fetchArea("outdoor", TILE, { signal: controller.signal }).catch((e: unknown) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callOpts(0).signal).toBe(controller.signal);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
  });

  it("rejects the services layer and oversized areas before any request", async () => {
    await expect(ridbProvider.fetchArea("services", TILE)).rejects.toBeInstanceOf(RangeError);
    await expect(ridbProvider.fetchArea("outdoor", [-120, 40, -118, 42])).rejects.toBeInstanceOf(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
