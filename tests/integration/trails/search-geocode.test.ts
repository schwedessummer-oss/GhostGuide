/**
 * Place search (Nominatim) against the real cache tables, with `fetch`
 * stubbed (no network): forward caching and cache-hit accounting, failures
 * that must not be cached, expiry, and the 0.1° reverse-geocoding grid.
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, sql, withSystem } from "@/server/db";
import { geocodePlaces, reverseAdminArea } from "@/server/geo/geocode";

afterAll(closeDb);

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/nominatim/${name}`, import.meta.url), "utf8");

interface Stub {
  status: number;
  body: string;
}
let replies: (Stub | Error)[] = [];
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  void input;
  void init;
  const next = replies.shift() ?? new Error("unexpected fetch");
  if (next instanceof Error) throw next;
  return new Response(next.body, { status: next.status, headers: { "content-type": "application/json" } });
});

beforeEach(async () => {
  replies = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  // Start every test with a free Nominatim slot so the 1 req/s spacing does not carry over.
  await withSystem((tx) => tx`delete from public.provider_throttle where provider = 'nominatim'`);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function usage() {
  const [row] = await sql()<{ requests: number; errors: number; cacheHits: number }[]>`
    select requests, errors, cache_hits from public.external_api_usage
     where provider = 'nominatim' and day = (now() at time zone 'utc')::date`;
  return row ?? { requests: 0, errors: 0, cacheHits: 0 };
}
const forwardRow = async (key: string) =>
  (
    await sql()<{ results: unknown; ttlDays: number }[]>`
      select results, extract(epoch from (expires_at - now())) / 86400 as ttl_days
        from public.geocode_cache where provider = 'nominatim' and query_key = ${key}`
  )[0];
const clearForward = (...keys: string[]) => sql()`delete from public.geocode_cache where provider = 'nominatim' and query_key = any(${keys}::text[])`;
const clearCell = (...keys: string[]) => sql()`delete from public.geo_admin_cache where provider = 'nominatim' and cell_key = any(${keys}::text[])`;

describe("geocodePlaces (cache + provider)", () => {
  it("fetches once, caches 30 days under the normalized place query, then serves the cache", async () => {
    await clearForward("banff");
    replies = [{ status: 200, body: fixture("search-banff.json") }];
    const before = await usage();

    const first = await geocodePlaces("Banff");
    expect(first.status).toBe("ok");
    expect(first.results.map((r) => r.label)).toEqual(["Banff, Alberta, Canada", "Banff, Scotland, United Kingdom"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&q=Banff&limit=6&addressdetails=1&accept-language=en",
    );
    expect((init?.headers as Record<string, string>)["User-Agent"]).toMatch(/GhostGuide/);

    const row = await forwardRow("banff");
    expect(row.results).toEqual(first.results);
    expect(row.ttlDays).toBeGreaterThan(29.9);
    expect(row.ttlDays).toBeLessThanOrEqual(30);
    const afterFetch = await usage();
    expect(afterFetch.requests - before.requests).toBe(1);

    // Different spelling of the same place query: no fetch, one cache hit.
    for (const q of ["  BANFF ", "best hikes near banff", "Banff trails"]) {
      const again = await geocodePlaces(q);
      expect(again.status).toBe("ok");
      expect(again.results).toEqual(first.results);
      expect(again.placeQuery.toLowerCase()).toBe("banff");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const afterHits = await usage();
    expect(afterHits.cacheHits - afterFetch.cacheHits).toBe(3);
    expect(afterHits.requests).toBe(afterFetch.requests);
  });

  it("caches an empty answer as no_results", async () => {
    await clearForward("xqzvvkjh nowhere");
    replies = [{ status: 200, body: fixture("search-no-results.json") }];
    expect((await geocodePlaces("xqzvvkjh nowhere")).status).toBe("no_results");
    expect((await geocodePlaces("XQZVVKJH   nowhere")).status).toBe("no_results");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await forwardRow("xqzvvkjh nowhere")).results).toEqual([]);
  });

  it("reports unavailable on a provider error and does not cache it", async () => {
    await clearForward("mount fuji");
    replies = [{ status: 400, body: '{"error":"bad request"}' }];
    const failed = await geocodePlaces("Mount Fuji");
    expect(failed).toMatchObject({ status: "unavailable", results: [], placeQuery: "Mount Fuji" });
    expect(await forwardRow("mount fuji")).toBeUndefined();

    // The next request reaches the provider again and succeeds.
    replies = [{ status: 200, body: fixture("search-mount-fuji.json") }];
    const ok = await geocodePlaces("Mount Fuji");
    expect(ok.status).toBe("ok");
    expect(ok.results[0]).toMatchObject({ kind: "volcano", countryCode: "jp" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable when the network fails (after one retry) and does not cache", async () => {
    await clearForward("columbia sc");
    replies = [new TypeError("fetch failed"), new TypeError("fetch failed")];
    const before = await usage();
    const r = await geocodePlaces("Columbia SC");
    expect(r.status).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await forwardRow("columbia sc")).toBeUndefined();
    expect((await usage()).errors - before.errors).toBe(2);
  });

  it("refetches once the cached answer has expired", async () => {
    await clearForward("columbia sc");
    replies = [{ status: 200, body: fixture("search-columbia-sc.json") }];
    await geocodePlaces("Columbia SC");
    await sql()`update public.geocode_cache set expires_at = now() - interval '1 minute' where provider = 'nominatim' and query_key = 'columbia sc'`;
    replies = [{ status: 200, body: fixture("search-columbia-sc.json") }];
    const r = await geocodePlaces("Columbia SC");
    expect(r.results[0]).toMatchObject({ kind: "city", label: "Columbia, South Carolina, United States" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await forwardRow("columbia sc")).ttlDays).toBeGreaterThan(29.9);
  });

  it("does not touch the provider for 'near me' queries", async () => {
    const r = await geocodePlaces("hikes near me");
    expect(r).toMatchObject({ status: "no_results", placeQuery: "", results: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("reverseAdminArea (0.1° grid cache)", () => {
  it("caches per 0.1° cell for 180 days; other points in the cell are served from the cache", async () => {
    await clearCell("350/-827", "351/-827");
    replies = [{ status: 200, body: fixture("reverse-table-rock.json") }];
    const before = await usage();

    const area = await reverseAdminArea(35.0412, -82.7111);
    expect(area).toEqual({ countryCode: "us", regionName: "South Carolina", nearestPlace: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/reverse");
    expect(url.searchParams.get("lat")).toBe("35.0");
    expect(url.searchParams.get("lon")).toBe("-82.7");
    expect(url.searchParams.get("zoom")).toBe("10");

    const [row] = await sql()<{ countryCode: string; regionName: string; nearestPlace: string | null; payload: unknown; ttlDays: number }[]>`
      select country_code, region_name, nearest_place, payload, extract(epoch from (expires_at - now())) / 86400 as ttl_days
        from public.geo_admin_cache where provider = 'nominatim' and cell_key = '350/-827'`;
    expect(row).toMatchObject({ countryCode: "us", regionName: "South Carolina", nearestPlace: null });
    expect(row.payload).toMatchObject({ address: { county: "Pickens County", state: "South Carolina" } });
    expect(row.ttlDays).toBeGreaterThan(179.9);

    // Same cell (rounds to 35.0 / -82.7): cached.
    expect(await reverseAdminArea(34.96, -82.66)).toEqual(area);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await usage()).cacheHits - before.cacheHits).toBe(1);

    // Neighbouring cell: a new request.
    replies = [{ status: 200, body: '{"address":{"state":"North Carolina","town":"Brevard","country_code":"us"}}' }];
    expect(await reverseAdminArea(35.06, -82.7)).toEqual({ countryCode: "us", regionName: "North Carolina", nearestPlace: "Brevard" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null on failure without caching, then succeeds later", async () => {
    await clearCell("-339/1514");
    replies = [{ status: 403, body: "{}" }];
    expect(await reverseAdminArea(-33.9, 151.4)).toBeNull();
    const rows = await sql()`select 1 from public.geo_admin_cache where provider = 'nominatim' and cell_key = '-339/1514'`;
    expect(rows).toHaveLength(0);

    replies = [{ status: 200, body: '{"address":{"state":"New South Wales","city":"Sydney","country_code":"au"}}' }];
    expect(await reverseAdminArea(-33.9, 151.4)).toEqual({ countryCode: "au", regionName: "New South Wales", nearestPlace: "Sydney" });
  });

  it("caches open sea ('Unable to geocode') as an all-null area", async () => {
    await clearCell("-400/-300");
    replies = [{ status: 200, body: '{"error":"Unable to geocode"}' }];
    const empty = { countryCode: null, regionName: null, nearestPlace: null };
    expect(await reverseAdminArea(-40, -30)).toEqual(empty);
    expect(await reverseAdminArea(-40.02, -30.03)).toEqual(empty);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
