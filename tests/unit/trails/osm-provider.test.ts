import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderFetchOptions, ProviderResponse } from "@/server/providers/http";

vi.mock("@/server/providers/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/providers/http")>();
  return { ...actual, providerFetch: vi.fn() };
});

import { resetEnvCache } from "@/config/env";
import { ProviderError, providerFetch } from "@/server/providers/http";
import { QUICK_FAILURE_MS, QUICK_RETRY_DELAY_MS, osmProvider, parseOverpassEndpoints } from "@/server/trails/providers/osm";
import { buildOverpassQuery } from "@/server/trails/providers/osm/query";
import type { Bbox } from "@/domain/catalog";
import { memberWay, node, relation, response, straight } from "../../fixtures/osm/synthetic";

const fetchMock = vi.mocked(providerFetch);
const BBOX: Bbox = [-82.75, 35, -82.5, 35.25];
const A = "https://a.example.org/api/interpreter";
const B = "https://b.example.org/api/interpreter";

function ok(body: unknown, raw?: string): ProviderResponse {
  const text = raw ?? JSON.stringify(body);
  return {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    bytes: new TextEncoder().encode(text).buffer as ArrayBuffer,
    text: () => text,
    json: <T,>() => JSON.parse(text) as T,
  };
}

const SAMPLE = response([
  relation(1, { route: "hiking", name: "Sample Route" }, [memberWay(11, straight([0, 0], [1000, 0]))]),
  node(2, { highway: "trailhead", name: "Sample Trailhead" }, [0, 0]),
]);

const saved = { ...process.env };
beforeEach(() => {
  fetchMock.mockReset();
  process.env.OVERPASS_URLS = `${A}, ${B}`;
  resetEnvCache();
});
afterEach(() => {
  vi.useRealTimers();
  process.env = { ...saved };
  resetEnvCache();
});

describe("osm provider: metadata", () => {
  it("is a global, always-enabled provider for both layers", () => {
    expect(osmProvider.id).toBe("osm");
    expect(osmProvider.layers).toEqual(["outdoor", "services"]);
    expect(osmProvider.isEnabled()).toBe(true);
    expect(osmProvider.covers([-180, -90, 180, 90])).toBe(true);
    expect(osmProvider.covers([139.6, 35.6, 139.8, 35.8])).toBe(true);
    expect(osmProvider.license).toBe("ODbL 1.0");
    expect(osmProvider.attribution).toMatch(/OpenStreetMap contributors/);
    expect(osmProvider.homepage).toBe("https://www.openstreetmap.org");
  });
});

describe("osm provider: endpoints", () => {
  it("parses a comma-separated endpoint list, skipping blanks, invalid entries and duplicates", () => {
    expect(parseOverpassEndpoints(` ${A} ,, not a url, ftp://x.example.org/i, ${B}, ${A}`)).toEqual([A, B]);
    expect(parseOverpassEndpoints("")).toEqual([]);
    expect(parseOverpassEndpoints(undefined)).toEqual([]);
  });

  it("fails without retry when no endpoint is valid", async () => {
    process.env.OVERPASS_URLS = "not-a-url, also bad";
    resetEnvCache();
    const err = await osmProvider.fetchArea("outdoor", BBOX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("osm provider: fetchArea", () => {
  it("POSTs the query for the layer and bbox and parses the response", async () => {
    fetchMock.mockResolvedValueOnce(ok(SAMPLE));
    const controller = new AbortController();
    const result = await osmProvider.fetchArea("outdoor", BBOX, { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const opts = fetchMock.mock.calls[0][0] as ProviderFetchOptions;
    // Client timeout = Overpass [timeout:90] + 15 s margin; retries are decided by the provider, not the client.
    expect(opts).toMatchObject({ provider: "overpass", url: A, method: "POST", timeoutMs: 105_000, retries: 0, signal: controller.signal });
    expect(opts.body).toBeInstanceOf(URLSearchParams);
    expect((opts.body as URLSearchParams).get("data")).toBe(buildOverpassQuery("outdoor", BBOX, { timeoutSec: 90 }));

    expect(result.trails.map((t) => t.providerId)).toEqual(["relation/1"]);
    expect(result.pois.map((p) => p.providerId)).toEqual(["node/2"]);
    expect(result.dataTimestamp).toEqual(new Date(SAMPLE.osm3s.timestamp_osm_base));
  });

  it("uses the services query for the services layer", async () => {
    fetchMock.mockResolvedValueOnce(ok(response([node(5, { amenity: "fuel", name: "Fuel" }, [0, 0])])));
    const result = await osmProvider.fetchArea("services", BBOX);
    const opts = fetchMock.mock.calls[0][0] as ProviderFetchOptions;
    expect((opts.body as URLSearchParams).get("data")).toBe(buildOverpassQuery("services", BBOX, { timeoutSec: 90 }));
    expect(result.trails).toEqual([]);
    expect(result.pois.map((p) => p.category)).toEqual(["fuel"]);
  });

  it("sends a broad Accept header and a Referer naming this site, and asks for error-body excerpts", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://trails.example.org/";
    resetEnvCache();
    fetchMock.mockResolvedValueOnce(ok(SAMPLE));
    await osmProvider.fetchArea("outdoor", BBOX);
    const opts = fetchMock.mock.calls[0][0] as ProviderFetchOptions;
    expect(opts.headers).toEqual({ Accept: "*/*", Referer: "https://trails.example.org/" });
    expect(opts.errorBodyChars).toBeGreaterThan(0);
  });

  it.each([403, 406])("moves on to the next endpoint when an instance refuses the client (HTTP %i)", async (status) => {
    fetchMock.mockRejectedValueOnce(new ProviderError("overpass", `HTTP ${status}: blocked`, status, false)).mockResolvedValueOnce(ok(SAMPLE));
    const result = await osmProvider.fetchArea("outdoor", BBOX);
    expect(fetchMock.mock.calls.map((c) => (c[0] as ProviderFetchOptions).url)).toEqual([A, B]);
    expect(result.trails).toHaveLength(1);
  });

  it("when every instance refuses, the error keeps the status and reason and stays retryable (the tile backs off)", async () => {
    fetchMock
      .mockRejectedValueOnce(new ProviderError("overpass", "HTTP 406: Not Acceptable", 406, false))
      .mockRejectedValueOnce(new ProviderError("overpass", "HTTP 403: Forbidden", 403, false));
    const err = (await osmProvider.fetchArea("outdoor", BBOX).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(403);
    expect(err.message).toBe("HTTP 403: Forbidden");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a bad query (HTTP 400) is still thrown at once, without trying other instances", async () => {
    fetchMock.mockRejectedValueOnce(new ProviderError("overpass", "HTTP 400", 400, false));
    const err = (await osmProvider.fetchArea("outdoor", BBOX).catch((e: unknown) => e)) as ProviderError;
    expect(err.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next endpoint on a retryable HTTP error (429)", async () => {
    fetchMock.mockRejectedValueOnce(new ProviderError("overpass", "HTTP 429", 429, true)).mockResolvedValueOnce(ok(SAMPLE));
    const result = await osmProvider.fetchArea("outdoor", BBOX);
    expect(fetchMock.mock.calls.map((c) => (c[0] as ProviderFetchOptions).url)).toEqual([A, B]);
    expect(result.trails).toHaveLength(1);
  });

  it("treats an HTTP 200 runtime-error remark as retryable and moves on", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ ...response([]), remark: 'runtime error: Query timed out in "query" at line 3 after 91 seconds.' }))
      .mockResolvedValueOnce(ok(SAMPLE));
    const result = await osmProvider.fetchArea("outdoor", BBOX);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.trails).toHaveLength(1);
  });

  it("treats invalid JSON and a response without elements as retryable", async () => {
    fetchMock.mockResolvedValueOnce(ok(null, "<html>busy</html>")).mockResolvedValueOnce(ok({ version: 0.6 }));
    const err = await osmProvider.fetchArea("outdoor", BBOX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).message).toMatch(/elements/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws the last retryable error when every endpoint fails", async () => {
    fetchMock
      .mockRejectedValueOnce(new ProviderError("overpass", "HTTP 504", 504, true))
      .mockResolvedValueOnce(ok({ ...response([]), remark: "runtime error: Query run out of memory using about 2048 MB of RAM." }));
    const err = await osmProvider.fetchArea("outdoor", BBOX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).message).toMatch(/out of memory/);
  });

  it("does not try other endpoints after a non-retryable error (e.g. HTTP 400 bad query)", async () => {
    fetchMock.mockRejectedValueOnce(new ProviderError("overpass", "HTTP 400", 400, false));
    const err = await osmProvider.fetchArea("outdoor", BBOX).catch((e: unknown) => e);
    expect((err as ProviderError).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new ProviderError("overpass", "This operation was aborted", null, true);
    });
    const err = await osmProvider.fetchArea("outdoor", BBOX, { signal: controller.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    const aborted = AbortSignal.abort();
    await expect(osmProvider.fetchArea("outdoor", BBOX, { signal: aborted })).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates unexpected (non-provider) errors", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("boom"));
    await expect(osmProvider.fetchArea("outdoor", BBOX)).rejects.toThrow(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries the same endpoint once, after a pause, for a quick network failure (connection reset)", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new ProviderError("overpass", "read ECONNRESET", null, true))
      .mockResolvedValueOnce(ok(SAMPLE));
    const pending = osmProvider.fetchArea("outdoor", BBOX);
    await vi.advanceTimersByTimeAsync(QUICK_RETRY_DELAY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still pausing
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(fetchMock.mock.calls.map((c) => (c[0] as ProviderFetchOptions).url)).toEqual([A, A]);
    expect(result.trails).toHaveLength(1);
  });

  it("retries a quick network failure only once per endpoint, then moves on", async () => {
    vi.useFakeTimers();
    const reset = new ProviderError("overpass", "read ECONNRESET", null, true);
    fetchMock.mockRejectedValueOnce(reset).mockRejectedValueOnce(reset).mockRejectedValueOnce(reset).mockRejectedValueOnce(reset);
    const pending = osmProvider.fetchArea("outdoor", BBOX).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await pending;
    expect(fetchMock.mock.calls.map((c) => (c[0] as ProviderFetchOptions).url)).toEqual([A, A, B, B]);
    expect(err).toBe(reset);
    expect((err as ProviderError).retryable).toBe(true);
  });

  it("does not repeat a slow failure (client timeout) on the same endpoint", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 105_000); // the attempt took the whole client timeout
        throw new ProviderError("overpass", "Timed out after 105000 ms", null, true);
      })
      .mockResolvedValueOnce(ok(SAMPLE));
    const result = await osmProvider.fetchArea("outdoor", BBOX);
    expect(fetchMock.mock.calls.map((c) => (c[0] as ProviderFetchOptions).url)).toEqual([A, B]);
    expect(result.trails).toHaveLength(1);
    expect(QUICK_FAILURE_MS).toBeLessThan(105_000);
  });

  it("never repeats an HTTP-level failure (429, 5xx, runtime remark) on the same endpoint", async () => {
    for (const failure of [
      () => fetchMock.mockRejectedValueOnce(new ProviderError("overpass", "HTTP 429", 429, true)),
      () => fetchMock.mockRejectedValueOnce(new ProviderError("overpass", "HTTP 504", 504, true)),
      () => fetchMock.mockResolvedValueOnce(ok({ ...response([]), remark: "runtime error: Query timed out in \"query\" at line 3 after 91 seconds." })),
    ]) {
      fetchMock.mockReset();
      failure();
      fetchMock.mockRejectedValueOnce(new ProviderError("overpass", "HTTP 503", 503, true));
      const err = await osmProvider.fetchArea("outdoor", BBOX).catch((e: unknown) => e);
      expect(fetchMock.mock.calls.map((c) => (c[0] as ProviderFetchOptions).url)).toEqual([A, B]);
      expect((err as ProviderError).status).toBe(503);
    }
  });

  it("stops during the retry pause when the caller aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    fetchMock.mockRejectedValueOnce(new ProviderError("overpass", "read ECONNRESET", null, true));
    const pending = osmProvider.fetchArea("outdoor", BBOX, { signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never returns partial data from a runtime-error response, even when it has elements", async () => {
    const partial = { ...SAMPLE, remark: "runtime error: Query run out of memory using about 2048 MB of RAM." };
    fetchMock.mockResolvedValueOnce(ok(partial)).mockResolvedValueOnce(ok(partial));
    const err = await osmProvider.fetchArea("outdoor", BBOX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toMatch(/runtime error/);
  });

  it("rejects an invalid bbox before any request", async () => {
    await expect(osmProvider.fetchArea("outdoor", [10, 0, 5, 1])).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
