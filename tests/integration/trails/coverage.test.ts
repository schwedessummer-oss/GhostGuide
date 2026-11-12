/**
 * Coverage status and on-demand loading requests (ensureCoverage /
 * getCoverage) against Postgres: tile rows, ingest-job enqueueing and its
 * deduplication (also under concurrent searches), every coverage state, and
 * the honest messages. No provider is called here (nothing runs the jobs).
 *
 * Tiles live around lng 145–160, lat −37.5 (row iy = 210 of the 0.25° grid).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Bbox } from "@/domain/catalog";
import { closeDb, sql } from "@/server/db";
import { tileFromKey } from "@/server/geo/tiles";
import { ensureCoverage, getCoverage, summarizeCoverage, rowState, combineTileStates } from "@/server/trails/coverage";
import { ingestJobKey } from "@/server/trails/repository";

beforeAll(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("network access is disabled in tests");
  });
});
afterAll(async () => {
  // Nothing runs these jobs here; do not leave them for other suites.
  await sql()`update public.jobs set status = 'cancelled', finished_at = now()
               where kind like 'catalog.%' and status in ('queued', 'running')`;
  vi.unstubAllGlobals();
  await closeDb();
});

const IY = 210;
let nextIx = 1300;

/** A bbox strictly inside an nx × ny block of fresh tiles; returns the keys too. */
function freshArea(nx: number, ny = nx): { bbox: Bbox; keys: string[] } {
  const ix = nextIx;
  nextIx += nx + 1;
  const keys: string[] = [];
  for (let x = ix; x < ix + nx; x++) for (let y = IY; y < IY + ny; y++) keys.push(`0.25/${x}/${y}`);
  const w = ix * 0.25 - 180;
  const s = IY * 0.25 - 90;
  return { bbox: [w + 0.001, s + 0.001, w + nx * 0.25 - 0.001, s + ny * 0.25 - 0.001], keys };
}

async function jobsFor(keys: string[]) {
  return sql()<{ id: number; dedupKey: string; status: string; payload: { layer: string; provider: string; tileKey: string } }[]>`
    select id, dedup_key, status::text as status, payload from public.jobs
     where kind = 'catalog.ingest_tile' and payload->>'tileKey' = any(${keys}::text[]) order by id`;
}

async function tiles(keys: string[]) {
  return sql()<{ tileKey: string; status: string; requestGen: string }[]>`
    select tile_key, status, floor(extract(epoch from requested_at) * 1000)::bigint::text as request_gen
      from public.catalog_tiles where layer = 'outdoor' and provider = 'osm' and tile_key = any(${keys}::text[]) order by tile_key`;
}

/** Put tiles straight into a state (as if ingestion had run). */
async function setTiles(keys: string[], state: "ready" | "ready_due" | "failed" | "failed_due" | "fetching" | "fetching_stale" | "refreshing", syncedDaysAgo = 1) {
  const synced = sql()`now() - make_interval(days => ${syncedDaysAgo})`;
  switch (state) {
    case "ready":
      await sql()`update public.catalog_tiles set status = 'ready', last_synced_at = ${synced}, next_refresh_at = now() + interval '20 days', attempts = 0
                   where tile_key = any(${keys}::text[]) and layer = 'outdoor'`;
      break;
    case "ready_due":
      await sql()`update public.catalog_tiles set status = 'ready', last_synced_at = ${synced}, next_refresh_at = now() - interval '1 minute'
                   where tile_key = any(${keys}::text[]) and layer = 'outdoor'`;
      break;
    case "failed":
      await sql()`update public.catalog_tiles set status = 'failed', attempts = 1, last_error = 'HTTP 504', last_synced_at = null, next_refresh_at = now() + interval '5 minutes'
                   where tile_key = any(${keys}::text[]) and layer = 'outdoor'`;
      break;
    case "failed_due":
      await sql()`update public.catalog_tiles set status = 'failed', attempts = 1, last_error = 'HTTP 504', last_synced_at = null, next_refresh_at = now() - interval '1 minute'
                   where tile_key = any(${keys}::text[]) and layer = 'outdoor'`;
      break;
    case "fetching":
      await sql()`update public.catalog_tiles set status = 'fetching', fetch_started_at = now() - interval '1 minute'
                   where tile_key = any(${keys}::text[]) and layer = 'outdoor'`;
      break;
    case "fetching_stale":
      await sql()`update public.catalog_tiles set status = 'fetching', fetch_started_at = now() - interval '10 minutes'
                   where tile_key = any(${keys}::text[]) and layer = 'outdoor'`;
      break;
    case "refreshing":
      await sql()`update public.catalog_tiles set status = 'fetching', fetch_started_at = now() - interval '1 minute', last_synced_at = ${synced}
                   where tile_key = any(${keys}::text[]) and layer = 'outdoor'`;
      break;
  }
}

/** Finish (or kill) the queued jobs of these tiles, as a runner would. */
async function finishJobs(keys: string[], status: "succeeded" | "dead" = "succeeded") {
  await sql()`update public.jobs set status = ${status}::public.job_status, finished_at = now()
               where kind = 'catalog.ingest_tile' and payload->>'tileKey' = any(${keys}::text[]) and status in ('queued', 'running')`;
}

describe("ensureCoverage: requesting tiles", () => {
  it("creates pending tiles and exactly one ingest job per tile; repeated searches are deduplicated", async () => {
    const { bbox, keys } = freshArea(2);
    const cov = await ensureCoverage("outdoor", bbox);
    expect(cov).toEqual({
      layer: "outdoor",
      state: "loading",
      tilesTotal: 4,
      tilesReady: 0,
      tilesLoading: 4,
      tilesFailed: 0,
      oldestSyncAt: null,
      message: "Loading trails for this area from OpenStreetMap… this can take a minute.",
    });
    const rows = await tiles(keys);
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending", "pending", "pending"]);
    let jobs = await jobsFor(keys);
    expect(jobs).toHaveLength(4);
    for (const j of jobs) {
      expect(j.status).toBe("queued");
      expect(j.payload).toEqual({ layer: "outdoor", provider: "osm", tileKey: j.payload.tileKey });
      const gen = rows.find((r) => r.tileKey === j.payload.tileKey)!.requestGen;
      expect(j.dedupKey).toBe(ingestJobKey("outdoor", "osm", j.payload.tileKey, gen));
    }

    await ensureCoverage("outdoor", bbox);
    await ensureCoverage("outdoor", bbox, { inlineTiles: 2 }); // outside a request scope: no-op, no throw
    jobs = await jobsFor(keys);
    expect(jobs).toHaveLength(4);
    expect((await tiles(keys)).map((r) => r.status)).toEqual(["pending", "pending", "pending", "pending"]);
  });

  it("enqueues one job per tile when many searches arrive at once", async () => {
    const { bbox, keys } = freshArea(3);
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureCoverage("outdoor", bbox)));
    for (const r of results) expect(r.state).toBe("loading");
    const jobs = await jobsFor(keys);
    expect(jobs).toHaveLength(9);
    expect(new Set(jobs.map((j) => j.payload.tileKey)).size).toBe(9);
  });

  it("re-requests a pending tile whose job is gone (finished or dead), once", async () => {
    const { bbox, keys } = freshArea(1);
    await ensureCoverage("outdoor", bbox);
    const [first] = await jobsFor(keys);
    await finishJobs(keys, "dead");
    await ensureCoverage("outdoor", bbox);
    await ensureCoverage("outdoor", bbox);
    const jobs = await jobsFor(keys);
    expect(jobs).toHaveLength(2);
    expect(jobs[1].dedupKey).not.toBe(first.dedupKey);
    expect(jobs[1].status).toBe("queued");
  });

  it("caps the work per call at maxTiles and reports too_large without requesting anything", async () => {
    const { bbox, keys } = freshArea(5);
    // Two tiles of the area are already loaded (e.g. from an earlier, zoomed-in search).
    await ensureCoverage("outdoor", freshAreaFromKeys(keys.slice(0, 1)));
    await ensureCoverage("outdoor", freshAreaFromKeys(keys.slice(6, 7)));
    await setTiles([keys[0], keys[6]], "ready", 3);
    const before = (await jobsFor(keys)).length;

    const cov = await ensureCoverage("outdoor", bbox, { maxTiles: 4 });
    expect(cov.state).toBe("too_large");
    expect(cov.tilesTotal).toBe(25);
    expect(cov.tilesReady).toBe(2);
    expect(cov.tilesLoading).toBe(0);
    expect(cov.message).toBe("Zoom in to load trails for this area. Showing trails already loaded.");
    expect(cov.oldestSyncAt).not.toBeNull();
    expect(await tiles(keys)).toHaveLength(2);
    expect((await jobsFor(keys)).length).toBe(before);
  });
});

/** The bbox strictly inside one tile key (helper for "an earlier search of one tile"). */
function freshAreaFromKeys(keys: string[]): Bbox {
  const t = tileFromKey("outdoor", keys[0])!;
  return [t.bbox[0] + 0.001, t.bbox[1] + 0.001, t.bbox[2] - 0.001, t.bbox[3] - 0.001];
}

describe("ensureCoverage: states", () => {
  it("is ready when every tile holds data, with the oldest sync time, and queues refreshes of due tiles without changing state", async () => {
    const { bbox, keys } = freshArea(2);
    await ensureCoverage("outdoor", bbox);
    await finishJobs(keys);
    await setTiles(keys.slice(0, 2), "ready", 2);
    await setTiles(keys.slice(2), "ready", 5);
    const before = (await jobsFor(keys)).length;

    const cov = await ensureCoverage("outdoor", bbox);
    expect(cov).toMatchObject({ state: "ready", tilesTotal: 4, tilesReady: 4, tilesLoading: 0, tilesFailed: 0 });
    expect(cov.message).toBe("Trails for this area are loaded from OpenStreetMap.");
    const ageDays = (Date.now() - Date.parse(cov.oldestSyncAt!)) / 86_400_000;
    expect(ageDays).toBeGreaterThan(4.9);
    expect(ageDays).toBeLessThan(5.1);
    expect((await jobsFor(keys)).length).toBe(before);

    // One tile is due for refresh: still "ready", one refresh job, deduplicated.
    await setTiles([keys[0]], "ready_due");
    expect((await ensureCoverage("outdoor", bbox)).state).toBe("ready");
    expect((await ensureCoverage("outdoor", bbox)).state).toBe("ready");
    const jobs = await jobsFor([keys[0]]);
    expect(jobs.filter((j) => j.status === "queued")).toHaveLength(1);
    expect((await jobsFor(keys)).length).toBe(before + 1);

    // A tile being refreshed still counts as ready (its data is served).
    await setTiles([keys[1]], "refreshing");
    expect((await ensureCoverage("outdoor", bbox)).state).toBe("ready");
  });

  it("reports loading while some tiles are pending, with what is loaded so far", async () => {
    const { bbox, keys } = freshArea(2);
    await ensureCoverage("outdoor", bbox);
    await setTiles(keys.slice(0, 3), "ready");
    const cov = await ensureCoverage("outdoor", bbox);
    expect(cov).toMatchObject({ state: "loading", tilesReady: 3, tilesLoading: 1 });
    expect(cov.message).toBe("Loading more trails for this area from OpenStreetMap… this can take a minute. Showing what is loaded so far.");
  });

  it("reports partial when some tiles failed and failed when all did; a due failed tile is retried (loading)", async () => {
    const { bbox, keys } = freshArea(2);
    await ensureCoverage("outdoor", bbox);
    await finishJobs(keys);
    await setTiles(keys.slice(0, 2), "ready");
    await setTiles(keys.slice(2), "failed");
    const partial = await ensureCoverage("outdoor", bbox);
    expect(partial).toMatchObject({ state: "partial", tilesReady: 2, tilesFailed: 2, tilesLoading: 0 });
    expect(partial.message).toBe("Some of this area could not be loaded right now; showing what is available.");

    await setTiles(keys, "failed");
    const failed = await ensureCoverage("outdoor", bbox);
    expect(failed).toMatchObject({ state: "failed", tilesReady: 0, tilesFailed: 4 });
    expect(failed.message).toBe("Trails for this area could not be loaded from OpenStreetMap right now. Please try again later.");
    const before = (await jobsFor(keys)).length;

    // Backoff over for one tile: a retry is queued and that tile shows as loading.
    await setTiles([keys[0]], "failed_due");
    const retrying = await ensureCoverage("outdoor", bbox);
    expect(retrying).toMatchObject({ state: "loading", tilesLoading: 1, tilesFailed: 3 });
    expect((await jobsFor(keys)).length).toBe(before + 1);
    expect((await ensureCoverage("outdoor", bbox)).tilesLoading).toBe(1);
    expect((await jobsFor(keys)).length).toBe(before + 1);
  });

  it("re-requests a tile stuck fetching (crashed worker) and keeps reporting it as loading", async () => {
    const { bbox, keys } = freshArea(1);
    await ensureCoverage("outdoor", bbox);
    await finishJobs(keys);
    await setTiles(keys, "fetching");
    expect((await ensureCoverage("outdoor", bbox)).state).toBe("loading");
    expect((await jobsFor(keys)).filter((j) => j.status === "queued")).toHaveLength(0); // a live fetch: no new job
    await setTiles(keys, "fetching_stale");
    expect((await ensureCoverage("outdoor", bbox)).state).toBe("loading");
    expect((await jobsFor(keys)).filter((j) => j.status === "queued")).toHaveLength(1);
  });
});

describe("getCoverage (read-only)", () => {
  it("never creates tiles or jobs and says what has not been loaded", async () => {
    const { bbox, keys } = freshArea(2);
    const cov = await getCoverage("outdoor", bbox);
    expect(cov).toMatchObject({ state: "partial", tilesTotal: 4, tilesReady: 0, tilesLoading: 0, tilesFailed: 0 });
    expect(cov.message).toBe("Trails for this area have not been loaded yet.");
    expect(await tiles(keys)).toHaveLength(0);
    expect(await jobsFor(keys)).toHaveLength(0);

    await ensureCoverage("outdoor", freshAreaFromKeys(keys.slice(0, 1)));
    await setTiles(keys.slice(0, 1), "ready");
    const some = await getCoverage("outdoor", bbox);
    expect(some).toMatchObject({ state: "partial", tilesReady: 1 });
    expect(some.message).toBe("Part of this area has not been loaded yet; showing what is available.");

    // A due tile is NOT re-requested by a read.
    await setTiles(keys.slice(0, 1), "ready_due");
    const jobsBefore = (await jobsFor(keys)).length;
    await getCoverage("outdoor", bbox);
    expect((await jobsFor(keys)).length).toBe(jobsBefore);
  });

  it("covers the services layer with its own tiles and wording", async () => {
    const { bbox } = freshArea(1);
    const cov = await ensureCoverage("services", bbox);
    expect(cov).toMatchObject({ layer: "services", state: "loading", tilesTotal: 1 });
    expect(cov.message).toBe("Loading nearby places for this area from OpenStreetMap… this can take a minute.");
  });
});

describe("never throws", () => {
  it("returns an honest failed status for invalid input", async () => {
    for (const bad of [[0, 0, 0, 0], [10, 10, 5, 5], [Number.NaN, 0, 1, 1], [-190, 0, 1, 1]] as Bbox[]) {
      const cov = await ensureCoverage("outdoor", bad);
      expect(cov).toMatchObject({ state: "failed", tilesTotal: 0 });
      expect(cov.message).toMatch(/unavailable/);
    }
    const layer = await ensureCoverage("nope" as "outdoor", [0, 0, 0.1, 0.1]);
    expect(layer.state).toBe("failed");
  });
});

describe("summarizeCoverage / rowState (pure)", () => {
  const base = { layer: "outdoor" as const, tilesTotal: 4, ready: 0, loading: 0, failed: 0, missing: 0, oldestSyncAt: null, tooLarge: false, sources: "OpenStreetMap" };

  it("picks states in priority order", () => {
    expect(summarizeCoverage({ ...base, ready: 4 }).state).toBe("ready");
    expect(summarizeCoverage({ ...base, ready: 2, loading: 1, failed: 1 }).state).toBe("loading");
    expect(summarizeCoverage({ ...base, ready: 3, failed: 1 }).state).toBe("partial");
    expect(summarizeCoverage({ ...base, failed: 4 }).state).toBe("failed");
    expect(summarizeCoverage({ ...base, failed: 1, missing: 3 }).state).toBe("partial");
    expect(summarizeCoverage({ ...base, ready: 4, tooLarge: true }).state).toBe("too_large");
    expect(summarizeCoverage({ ...base, ready: 4, sources: "" }).message).toBe("Trails for this area are loaded.");
  });

  it("classifies rows: data present wins, failed with a queued retry is loading", () => {
    const at = new Date();
    expect(rowState(undefined)).toBe("missing");
    expect(rowState({ status: "ready", lastSyncedAt: at, jobStatus: null })).toBe("ready");
    expect(rowState({ status: "fetching", lastSyncedAt: at, jobStatus: null })).toBe("ready");
    expect(rowState({ status: "pending", lastSyncedAt: null, jobStatus: "queued" })).toBe("loading");
    expect(rowState({ status: "failed", lastSyncedAt: null, jobStatus: "queued" })).toBe("loading");
    expect(rowState({ status: "failed", lastSyncedAt: null, jobStatus: "succeeded" })).toBe("failed");
    expect(combineTileStates(["ready", "failed", "loading"])).toBe("loading");
    expect(combineTileStates(["ready", "missing"])).toBe("missing");
    expect(combineTileStates([])).toBe("ready");
  });
});
