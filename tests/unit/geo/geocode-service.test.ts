/**
 * geocodePlaces / reverseAdminArea control flow with the database and the
 * provider client mocked: request shape, "never throws" on every failure
 * path, and what is (not) cached. The real cache tables are exercised in
 * tests/integration/trails/search-geocode.test.ts.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A self-hosted base URL with a trailing slash: requests must not get "//search".
process.env.NOMINATIM_URL = "https://nominatim.example.test/osm/";

interface Call {
  text: string;
  values: unknown[];
}
const db = vi.hoisted(() => ({
  calls: [] as Call[],
  respond: (() => []) as (text: string, values: unknown[]) => unknown[] | Error,
}));
vi.mock("@/server/db", () => ({
  withSystem: async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?").replace(/\s+/g, " ").trim();
        db.calls.push({ text, values });
        const r = db.respond(text, values);
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      },
      { json: (v: unknown) => v },
    );
    return fn(tx);
  },
}));

const http = vi.hoisted(() => ({
  providerFetch: vi.fn(),
  recordProviderCacheHit: vi.fn(async () => {}),
}));
vi.mock("@/server/providers/http", () => http);

import { geocodePlaces, reverseAdminArea } from "@/server/geo/geocode";

const fixtureText = (name: string) => readFileSync(new URL(`../../fixtures/nominatim/${name}`, import.meta.url), "utf8");
const okResponse = (text: string) => ({ status: 200, headers: new Headers(), bytes: new ArrayBuffer(0), text: () => text, json: () => JSON.parse(text) });

const isSelect = (c: Call) => c.text.startsWith("select");
const isInsert = (c: Call) => c.text.startsWith("insert");

beforeEach(() => {
  db.calls = [];
  db.respond = () => [];
  http.providerFetch.mockReset();
  http.recordProviderCacheHit.mockClear();
});

describe("geocodePlaces", () => {
  it("does not call the provider or the cache for queries without a place", async () => {
    for (const q of ["near me", "hiking trails", "", "   "]) {
      const r = await geocodePlaces(q);
      expect(r.status).toBe("no_results");
      expect(r.results).toEqual([]);
      expect(r.placeQuery).toBe("");
    }
    expect(http.providerFetch).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });

  it("requests /search with the policy parameters and caches the mapped answer", async () => {
    http.providerFetch.mockResolvedValue(okResponse(fixtureText("search-banff.json")));
    const r = await geocodePlaces("  best hikes   around Banff ");
    expect(r).toMatchObject({ query: "best hikes around Banff", placeQuery: "Banff", status: "ok" });
    expect(r.results.map((x) => x.label)).toEqual(["Banff, Alberta, Canada", "Banff, Scotland, United Kingdom"]);
    expect(r.attribution[0]).toEqual({
      name: "© OpenStreetMap contributors",
      url: "https://www.openstreetmap.org/copyright",
      license: "ODbL 1.0",
    });

    expect(http.providerFetch).toHaveBeenCalledTimes(1);
    const opts = http.providerFetch.mock.calls[0][0];
    expect(opts).toMatchObject({ provider: "nominatim", minIntervalMs: 1100, timeoutMs: 10_000, retries: 1 });
    const url = new URL(opts.url);
    expect(url.origin + url.pathname).toBe("https://nominatim.example.test/osm/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      format: "jsonv2",
      q: "Banff",
      limit: "6",
      addressdetails: "1",
      "accept-language": "en",
    });

    const read = db.calls.find(isSelect)!;
    expect(read.values).toEqual(["nominatim", "banff"]);
    const write = db.calls.find(isInsert)!;
    expect(write.values[0]).toBe("nominatim");
    expect(write.values[1]).toBe("banff");
    expect(write.values[2]).toEqual(r.results);
    expect(write.values[3]).toBe(30);
  });

  it("serves a valid cache row without calling the provider and counts the hit", async () => {
    const cached = [
      { id: "osm:node/1", label: "Cached, Place", kind: "town", lng: 1, lat: 2, bbox: null, countryCode: "xx", source: "OpenStreetMap Nominatim" },
    ];
    db.respond = (text) => (text.startsWith("select") ? [{ results: cached }] : []);
    const r = await geocodePlaces("Cached");
    expect(r).toMatchObject({ status: "ok", results: cached });
    expect(http.providerFetch).not.toHaveBeenCalled();
    expect(http.recordProviderCacheHit).toHaveBeenCalledWith("nominatim");
  });

  it("an empty cached answer is 'no_results'; a malformed cache row is a miss", async () => {
    db.respond = (text) => (text.startsWith("select") ? [{ results: [] }] : []);
    expect((await geocodePlaces("Nowhere")).status).toBe("no_results");
    expect(http.providerFetch).not.toHaveBeenCalled();

    db.respond = (text) => (text.startsWith("select") ? [{ results: [{ label: 42 }] }] : []);
    http.providerFetch.mockResolvedValue(okResponse(fixtureText("search-columbia-sc.json")));
    const r = await geocodePlaces("Columbia SC");
    expect(r.status).toBe("ok");
    expect(http.providerFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps working when the cache cannot be read or written", async () => {
    db.respond = () => new Error("database down");
    http.providerFetch.mockResolvedValue(okResponse(fixtureText("search-mount-fuji.json")));
    const r = await geocodePlaces("Mount Fuji");
    expect(r.status).toBe("ok");
    expect(r.results).toHaveLength(3);
    expect(db.calls.some(isInsert)).toBe(true);
  });

  it("reports 'unavailable' on provider errors and does not cache", async () => {
    http.providerFetch.mockRejectedValue(new Error("HTTP 503"));
    const r = await geocodePlaces("Banff");
    expect(r).toMatchObject({ status: "unavailable", results: [], placeQuery: "Banff" });
    expect(db.calls.some(isInsert)).toBe(false);
  });

  it("reports 'unavailable' for non-array answers and invalid JSON, without caching", async () => {
    http.providerFetch.mockResolvedValue(okResponse('{"error":"something went wrong"}'));
    expect((await geocodePlaces("Banff")).status).toBe("unavailable");
    http.providerFetch.mockResolvedValue(okResponse("<html>busy</html>"));
    expect((await geocodePlaces("Banff")).status).toBe("unavailable");
    expect(db.calls.some(isInsert)).toBe(false);
  });

  it("caches an empty answer as no_results", async () => {
    http.providerFetch.mockResolvedValue(okResponse(fixtureText("search-no-results.json")));
    const r = await geocodePlaces("xqzvvkjh nowhere");
    expect(r.status).toBe("no_results");
    const write = db.calls.find(isInsert)!;
    expect(write.values[2]).toEqual([]);
  });
});

describe("reverseAdminArea", () => {
  it("returns null for invalid coordinates without any I/O", async () => {
    for (const [lat, lng] of [
      [NaN, 0],
      [0, Infinity],
      [91, 0],
      [0, -181],
      ["35" as unknown as number, 0],
    ]) {
      expect(await reverseAdminArea(lat, lng)).toBeNull();
    }
    expect(db.calls).toHaveLength(0);
    expect(http.providerFetch).not.toHaveBeenCalled();
  });

  it("asks about the cell centre and caches the answer on the 0.1° grid", async () => {
    http.providerFetch.mockResolvedValue(okResponse(fixtureText("reverse-table-rock.json")));
    const area = await reverseAdminArea(35.0412, -82.7111);
    expect(area).toEqual({ countryCode: "us", regionName: "South Carolina", nearestPlace: null });

    const opts = http.providerFetch.mock.calls[0][0];
    expect(opts).toMatchObject({ provider: "nominatim", minIntervalMs: 1100, timeoutMs: 10_000, retries: 1 });
    const url = new URL(opts.url);
    expect(url.pathname).toBe("/osm/reverse");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      format: "jsonv2",
      lat: "35.0",
      lon: "-82.7",
      zoom: "10",
      addressdetails: "1",
      "accept-language": "en",
    });
    expect(db.calls.find(isSelect)!.values).toEqual(["nominatim", "350/-827"]);
    const write = db.calls.find(isInsert)!;
    expect(write.values.slice(0, 5)).toEqual(["nominatim", "350/-827", "us", "South Carolina", null]);
    expect(write.values[5]).toEqual({
      address: {
        county: "Pickens County",
        state: "South Carolina",
        "ISO3166-2-lvl4": "US-SC",
        country: "United States",
        country_code: "us",
      },
    });
    expect(write.values[6]).toBe(180);
  });

  it("serves cached cells and counts the hit", async () => {
    db.respond = (text) => (text.startsWith("select") ? [{ countryCode: "ca", regionName: "Alberta", nearestPlace: "Banff" }] : []);
    expect(await reverseAdminArea(51.17, -115.57)).toEqual({ countryCode: "ca", regionName: "Alberta", nearestPlace: "Banff" });
    expect(http.providerFetch).not.toHaveBeenCalled();
    expect(http.recordProviderCacheHit).toHaveBeenCalledWith("nominatim");
  });

  it("returns null on provider failure or an unexpected answer, without caching", async () => {
    http.providerFetch.mockRejectedValue(new Error("Timed out"));
    expect(await reverseAdminArea(35, -82)).toBeNull();
    http.providerFetch.mockResolvedValue(okResponse("[]"));
    expect(await reverseAdminArea(35, -82)).toBeNull();
    http.providerFetch.mockResolvedValue(okResponse("not json"));
    expect(await reverseAdminArea(35, -82)).toBeNull();
    expect(db.calls.some(isInsert)).toBe(false);
  });

  it("caches 'Unable to geocode' (open sea) as an all-null area", async () => {
    http.providerFetch.mockResolvedValue(okResponse('{"error":"Unable to geocode"}'));
    expect(await reverseAdminArea(-40, -30)).toEqual({ countryCode: null, regionName: null, nearestPlace: null });
    const write = db.calls.find(isInsert)!;
    expect(write.values.slice(0, 5)).toEqual(["nominatim", "-400/-300", null, null, null]);
  });

  it("still answers when the cache is down", async () => {
    db.respond = () => new Error("database down");
    http.providerFetch.mockResolvedValue(okResponse(fixtureText("reverse-table-rock.json")));
    expect(await reverseAdminArea(35.05, -82.72)).toEqual({ countryCode: "us", regionName: "South Carolina", nearestPlace: null });
  });
});
