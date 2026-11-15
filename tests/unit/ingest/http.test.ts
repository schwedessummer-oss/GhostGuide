import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HttpClient, HttpError, parseRetryAfter, USER_AGENT, wikidataEntityUrl } from "../../../ingest/src/lib/http";

interface Call {
  url: string;
  headers: Record<string, string>;
  at: number;
}

/** A fake clock + fetch: no network, no real waiting. */
async function harness(responses: Array<() => Response>, opts: { hostIntervals?: Record<string, number> } = {}) {
  let now = Date.parse("2026-11-15T12:00:00Z");
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const client = new HttpClient({
    cacheDir: await mkdtemp(path.join(os.tmpdir(), "gg-http-")),
    hostIntervals: opts.hostIntervals ?? { "example.org": 1000 },
    baseBackoffMs: 100,
    maxRetries: 2,
    now: () => now,
    random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, at: now });
      const next = queue.shift();
      if (!next) throw new Error("unexpected request");
      return next();
    }) as typeof fetch,
  });
  return { client, calls, sleeps, advance: (ms: number) => (now += ms) };
}

const ok = (body: string, headers: Record<string, string> = {}) => () => new Response(body, { status: 200, headers });

describe("HttpClient", () => {
  it("sends the identifying User-Agent, which callers cannot replace", async () => {
    const { client, calls } = await harness([ok("{}")]);
    await client.get("https://example.org/a", { headers: { "User-Agent": "curl/8", Accept: "application/json" } });
    expect(calls[0].headers["User-Agent"]).toBe(USER_AGENT);
    expect(calls[0].headers.Accept).toBe("application/json");
    expect(USER_AGENT).not.toMatch(/vercel\.app/);
  });

  it("refuses a vercel.app User-Agent and one without a contact URL", () => {
    expect(() => new HttpClient({ cacheDir: "/tmp", userAgent: "GG/1 (+https://ghost-guide.vercel.app)" })).toThrow(/vercel\.app/);
    expect(() => new HttpClient({ cacheDir: "/tmp", userAgent: "GG/1" })).toThrow(/contact URL/);
  });

  it("caches responses and revalidates with ETag / Last-Modified", async () => {
    const { client, calls } = await harness([
      ok('{"v":1}', { etag: '"abc"', "last-modified": "Sat, 14 Nov 2026 10:00:00 GMT", "content-type": "application/json" }),
      () => new Response(null, { status: 304 }),
    ]);
    const first = await client.get("https://example.org/entity.json");
    expect(first).toMatchObject({ fromCache: false, etag: '"abc"', contentType: "application/json" });
    expect(first.json()).toEqual({ v: 1 });
    expect(first.rawRef).toMatch(/^http\/example\.org\/[0-9a-f]{2}\/[0-9a-f]{64}\.body$/);

    // Fresh enough: served from the cache without a request.
    const cached = await client.get("https://example.org/entity.json", { maxAgeMs: 60_000 });
    expect(cached).toMatchObject({ fromCache: true, revalidated: false });
    expect(calls).toHaveLength(1);

    // Otherwise a conditional request; 304 serves the cached body.
    const revalidated = await client.get("https://example.org/entity.json");
    expect(calls[1].headers["If-None-Match"]).toBe('"abc"');
    expect(calls[1].headers["If-Modified-Since"]).toBe("Sat, 14 Nov 2026 10:00:00 GMT");
    expect(revalidated).toMatchObject({ fromCache: true, revalidated: true, contentHash: first.contentHash });
    expect(revalidated.text()).toBe('{"v":1}');
  });

  it("retries 429 and 5xx with backoff, honouring Retry-After", async () => {
    const { client, calls, sleeps } = await harness([
      () => new Response("busy", { status: 503 }),
      () => new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
      ok("done"),
    ]);
    const res = await client.get("https://example.org/x");
    expect(res.text()).toBe("done");
    expect(calls).toHaveLength(3);
    // backoff 100 ms, then max(200 ms backoff, 7 s Retry-After); the 1 s host interval is already covered.
    expect(sleeps).toEqual([100, 900, 7000]);
  });

  it("gives up after the retries and does not retry other 4xx", async () => {
    const failing = await harness([() => new Response("", { status: 500 }), () => new Response("", { status: 502 }), () => new Response("", { status: 503 })]);
    await expect(failing.client.get("https://example.org/x")).rejects.toMatchObject({ name: "HttpError", status: 503 });
    expect(failing.calls).toHaveLength(3);

    const missing = await harness([() => new Response("", { status: 404 })]);
    await expect(missing.client.get("https://example.org/missing")).rejects.toBeInstanceOf(HttpError);
    expect(missing.calls).toHaveLength(1);
  });

  it("retries network errors", async () => {
    const { client, calls } = await harness([
      () => {
        throw new TypeError("fetch failed");
      },
      ok("fine"),
    ]);
    expect((await client.get("https://example.org/net")).text()).toBe("fine");
    expect(calls).toHaveLength(2);
  });

  it("spaces requests to the same host, not across hosts", async () => {
    const { client, calls } = await harness([ok("1"), ok("2"), ok("3")], { hostIntervals: { "example.org": 1000, "example.com": 1000 } });
    await client.get("https://example.org/1");
    await client.get("https://example.com/2");
    await client.get("https://example.org/3");
    expect(calls.map((c) => c.at - calls[0].at)).toEqual([0, 0, 1000]);
  });

  it("serves only cached copies offline and refuses Wikidata's api.php", async () => {
    const { client } = await harness([ok("cached")]);
    await client.get("https://example.org/page");
    const offline = new HttpClient({ cacheDir: client.cachePaths({ url: "https://example.org/page" }).meta.split("/http/")[0], offline: true });
    expect((await offline.get("https://example.org/page")).text()).toBe("cached");
    await expect(offline.get("https://example.org/other")).rejects.toThrow(/Offline and not cached/);
    await expect(client.get("https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q1")).rejects.toThrow(/Special:EntityData/);
  });

  it("builds Wikidata entity URLs and parses Retry-After", () => {
    expect(wikidataEntityUrl("Q180402")).toBe("https://www.wikidata.org/wiki/Special:EntityData/Q180402.json");
    expect(() => wikidataEntityUrl("180402")).toThrow();
    const now = Date.parse("2026-11-15T12:00:00Z");
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("Sun, 15 Nov 2026 12:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("soon", now)).toBeNull();
  });
});
