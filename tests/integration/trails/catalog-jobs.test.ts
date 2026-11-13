/**
 * Catalog background jobs and runners against Postgres: the ingest-tile
 * handler (success, deferral when the provider's concurrency cap is reached
 * or time is short, retryable vs final failures, invalid payloads),
 * refresh_stale, purge_caches, the periodic schedule, and both cron routes
 * (Bearer auth; the safety runner never runs catalog jobs, the catalog
 * runner does).
 *
 * The provider registry and the elevation / reverse-geocoding services are
 * mocked (a fake OSM provider), and fetch is stubbed to throw: no network.
 * Tiles live around lng 145–160, lat −35 (row iy = 220 of the 0.25° grid).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bbox } from "@/domain/catalog";
import { offsetMeters } from "@/domain/geo";
import { closeDb, sql } from "@/server/db";
import { tileFromKey, type Tile } from "@/server/geo/tiles";
import { createCatalogHandlers, purgeCatalogCaches, refreshStaleTiles, CATALOG_JOB_KINDS, MIN_INGEST_BUDGET_MS } from "@/server/jobs/handlers/catalog";
import { PERIODIC_JOBS } from "@/server/jobs/periodic";
import { enqueueJob, runDueJobs } from "@/server/jobs/queue";
import { ProviderError } from "@/server/providers/http";
import { ensureCoverage } from "@/server/trails/coverage";
import * as repo from "@/server/trails/repository";
import type { NormalizedTrail, ProviderAreaResult, TrailDataProvider } from "@/server/trails/types";

const fake = vi.hoisted(() => ({
  /** Per-tile responses by tile west-south corner "w,s"; anything else gets an empty area. */
  responses: new Map<string, () => unknown>(),
  calls: [] as string[],
  /**
   * Kinds a runner may claim when it did not restrict kinds itself (the
   * /api/cron/jobs route). Keeps the route test from running other suites'
   * jobs in the shared test database; the route's own exclusion of
   * "catalog." kinds still applies on top.
   */
  routeScope: null as string[] | null,
}));

vi.mock("@/server/jobs/queue", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/jobs/queue")>();
  return {
    ...orig,
    runDueJobs: (handlers: Parameters<typeof orig.runDueJobs>[0], opts: Parameters<typeof orig.runDueJobs>[1] = {}) =>
      orig.runDueJobs(handlers, { ...opts, kinds: opts.kinds ?? fake.routeScope ?? undefined }),
  };
});
// The safety runner's periodic scheduling and heartbeat are not under test here
// (and would change state other suites rely on).
vi.mock("@/server/jobs/periodic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/jobs/periodic")>()),
  ensurePeriodicJobs: async () => {},
}));
vi.mock("@/server/jobs/health", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/jobs/health")>()),
  recordRunnerHeartbeat: async () => {},
}));

vi.mock("@/server/trails/providers/registry", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/trails/providers/registry")>();
  const provider: TrailDataProvider = {
    id: "osm",
    label: "OpenStreetMap",
    homepage: "https://www.openstreetmap.org",
    license: "ODbL 1.0",
    attribution: "© OpenStreetMap contributors",
    layers: ["outdoor", "services"],
    isEnabled: () => true,
    covers: () => true,
    async fetchArea(_layer, bbox) {
      const key = `${bbox[0]},${bbox[1]}`;
      fake.calls.push(key);
      const respond = fake.responses.get(key);
      return (respond ? respond() : { trails: [], pois: [], dataTimestamp: null }) as ProviderAreaResult;
    },
  };
  return {
    ...orig,
    TRAIL_PROVIDERS: [provider],
    providerById: (id: string) => (id === "osm" ? provider : null),
    enabledProviders: () => [provider],
    providersFor: () => [provider],
  };
});
vi.mock("@/server/geo/elevation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/geo/elevation")>()),
  elevationProfileFor: async () => null,
}));
vi.mock("@/server/geo/geocode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/geo/geocode")>()),
  reverseAdminArea: async () => null,
}));

// Imported after the mocks are declared (vi.mock is hoisted anyway).
import { GET as catalogCron } from "@/app/api/cron/catalog/route";
import { GET as jobsCron } from "@/app/api/cron/jobs/route";

const CRON_SECRET = "test-cron-secret-0123456789";

beforeAll(async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("network access is disabled in tests");
  });
  // Start from a clean slate: earlier files may have left catalog jobs queued.
  await sql()`update public.jobs set status = 'cancelled', finished_at = now()
               where kind like 'catalog.%' and status in ('queued', 'running')`;
});
afterAll(async () => {
  await sql()`update public.jobs set status = 'cancelled', finished_at = now()
               where kind like 'catalog.%' and status in ('queued', 'running')`;
  vi.unstubAllGlobals();
  await closeDb();
});
beforeEach(async () => {
  fake.responses.clear();
  fake.calls.length = 0;
  await sql()`update public.catalog_tiles set status = 'failed' where provider = 'osm' and status = 'fetching'`;
});

// ---------------------------------------------------------------------------

const IY = 220;
let nextIx = 1300;
function freshTile(): Tile {
  return tileFromKey("outdoor", `0.25/${nextIx++}/${IY}`)!;
}
const inner = (t: Tile): Bbox => [t.bbox[0] + 0.001, t.bbox[1] + 0.001, t.bbox[2] - 0.001, t.bbox[3] - 0.001];
const respondFor = (t: Tile, fn: () => unknown) => fake.responses.set(`${t.bbox[0]},${t.bbox[1]}`, fn);

let seq = 7_000_000;
function trailIn(t: Tile, name: string): NormalizedTrail {
  const c = { lng: (t.bbox[0] + t.bbox[2]) / 2, lat: (t.bbox[1] + t.bbox[3]) / 2 };
  const pt = (east: number) => {
    const p = offsetMeters(c, east, 0);
    return [p.lng, p.lat] as [number, number];
  };
  return {
    provider: "osm",
    providerId: `relation/${seq++}`,
    name,
    nameEn: null,
    lines: [[pt(0), pt(600), pt(1200)]],
    routeType: "linear",
    sacScale: null,
    trailVisibility: null,
    surfaces: [],
    activities: ["hiking"],
    description: null,
    dogPolicy: "unknown",
    wheelchair: "unknown",
    feeRequired: null,
    permitRequired: null,
    access: null,
    seasonality: null,
    operator: null,
    website: null,
    tags: {},
    sourceName: "OpenStreetMap contributors",
    sourceUrl: null,
    sourceLicense: "ODbL 1.0",
    sourceUpdatedAt: null,
  };
}

async function ingestJobs(t: Tile) {
  return sql()<{ id: number; status: string; attempts: number; delayed: boolean; lastError: string | null }[]>`
    select id, status::text as status, attempts, run_at > now() as delayed, last_error from public.jobs
     where kind = 'catalog.ingest_tile' and payload->>'tileKey' = ${t.key} order by id`;
}
async function tileState(t: Tile) {
  const [row] = await sql()<{ status: string; attempts: number; lastError: string | null }[]>`
    select status, attempts, last_error from public.catalog_tiles where layer = 'outdoor' and provider = 'osm' and tile_key = ${t.key}`;
  return row;
}
const runIngest = (handlers = createCatalogHandlers({ concurrencyCap: 1000 }), deadline?: Date) =>
  runDueJobs(handlers, { kinds: [repo.INGEST_JOB_KIND], limit: 50, deadline });

/** Cancel every queued catalog job except those of `keep` (keeps runs focused on one tile). */
async function onlyJobsOf(keep: Tile) {
  await sql()`update public.jobs set status = 'cancelled', finished_at = now()
               where kind like 'catalog.%' and status = 'queued' and coalesce(payload->>'tileKey', '') <> ${keep.key}`;
}

// ---------------------------------------------------------------------------
describe("catalog.ingest_tile handler", () => {
  it("loads a tile requested by a search", async () => {
    const t = freshTile();
    respondFor(t, () => ({ trails: [trailIn(t, "Job Loaded Track")], pois: [], dataTimestamp: null }));
    expect((await ensureCoverage("outdoor", inner(t))).state).toBe("loading");
    await onlyJobsOf(t);
    const s = await runIngest();
    expect(s).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await ingestJobs(t)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
    expect(await tileState(t)).toMatchObject({ status: "ready", attempts: 0 });
    expect((await ensureCoverage("outdoor", inner(t))).state).toBe("ready");
    const [row] = await sql()<{ lastError: string }[]>`select last_error from public.jobs where kind = 'catalog.ingest_tile' and payload->>'tileKey' = ${t.key}`;
    expect(row.lastError).toMatch(/1 trail\(s\): 1 new/);
  });

  it("defers (no attempt used) while OpenStreetMap's two fetch slots are taken, then runs", async () => {
    const [busy1, busy2] = [freshTile(), freshTile()];
    expect((await repo.claimTile("outdoor", "osm", busy1, 2)).status).toBe("claimed");
    expect((await repo.claimTile("outdoor", "osm", busy2, 2)).status).toBe("claimed");
    const t = freshTile();
    await ensureCoverage("outdoor", inner(t));
    await onlyJobsOf(t);
    const s = await runIngest(createCatalogHandlers());
    expect(s).toMatchObject({ claimed: 1, deferred: 1, retried: 0 });
    const [job] = await ingestJobs(t);
    expect(job).toMatchObject({ status: "queued", attempts: 0, delayed: true });
    expect(job.lastError).toMatch(/^deferred: osm concurrency limit reached/);
    expect(await tileState(t)).toMatchObject({ status: "pending" });

    await sql()`update public.catalog_tiles set status = 'failed' where provider = 'osm' and status = 'fetching'`;
    await sql()`update public.jobs set run_at = now() where id = ${job.id}`;
    expect(await runIngest(createCatalogHandlers())).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await tileState(t)).toMatchObject({ status: "ready" });
  });

  it("defers instead of starting when the runner's deadline is too close", async () => {
    const t = freshTile();
    await ensureCoverage("outdoor", inner(t));
    await onlyJobsOf(t);
    const s = await runIngest(undefined, new Date(Date.now() + 10_000));
    expect(s).toMatchObject({ claimed: 1, deferred: 1 });
    expect(await ingestJobs(t)).toMatchObject([{ status: "queued", attempts: 0 }]);
    expect(fake.calls).toHaveLength(0);
    expect(await tileState(t)).toMatchObject({ status: "pending" });
  });

  it("never starts a fetch that a full Overpass attempt could not finish before the deadline (100 s left)", async () => {
    const t = freshTile();
    await ensureCoverage("outdoor", inner(t));
    await onlyJobsOf(t);
    expect(MIN_INGEST_BUDGET_MS).toBeGreaterThan(100_000);
    const s = await runIngest(createCatalogHandlers(), new Date(Date.now() + 100_000));
    expect(s).toMatchObject({ claimed: 1, deferred: 1 });
    expect(fake.calls).toHaveLength(0);
    expect(await tileState(t)).toMatchObject({ status: "pending", attempts: 0 });
    // With enough time it runs.
    await sql()`update public.jobs set run_at = now() where kind = 'catalog.ingest_tile' and payload->>'tileKey' = ${t.key} and status = 'queued'`;
    expect(await runIngest(createCatalogHandlers(), new Date(Date.now() + 200_000))).toMatchObject({ claimed: 1, succeeded: 1 });
  });

  it("quick job retries during a short provider outage do not inflate the tile's backoff", async () => {
    const t = freshTile();
    respondFor(t, () => {
      throw new ProviderError("overpass", "HTTP 504", 504, true);
    });
    await ensureCoverage("outdoor", inner(t));
    await onlyJobsOf(t);
    // All four job attempts, 30 s – 2 min apart in production; here back to back.
    for (let i = 0; i < 4; i++) {
      await sql()`update public.jobs set run_at = now() where kind = 'catalog.ingest_tile' and payload->>'tileKey' = ${t.key} and status = 'queued'`;
      await runIngest();
    }
    expect(fake.calls).toHaveLength(4);
    expect((await ingestJobs(t)).map((j) => j.status)).toEqual(["dead"]);
    const [row] = await sql()<{ attempts: number; retryInMinutes: number }[]>`
      select attempts, extract(epoch from (next_refresh_at - now())) / 60 as retry_in_minutes
        from public.catalog_tiles where layer = 'outdoor' and provider = 'osm' and tile_key = ${t.key}`;
    // One escalation step (5 min), not five (80 min).
    expect(row.attempts).toBe(1);
    expect(row.retryInMinutes).toBeLessThanOrEqual(5.01);
    expect((await ensureCoverage("outdoor", inner(t))).state).toBe("failed");

    // Once that short backoff is over, a new search queues a new load.
    await sql()`update public.catalog_tiles set next_refresh_at = now() - interval '1 second' where layer = 'outdoor' and provider = 'osm' and tile_key = ${t.key}`;
    expect((await ensureCoverage("outdoor", inner(t))).state).toBe("loading");
    expect((await ingestJobs(t)).map((j) => j.status)).toEqual(["dead", "queued"]);
  });

  it("drops a load nobody asked about for 20 minutes (no fetch) and forgets its never-loaded tile", async () => {
    const t = freshTile();
    await ensureCoverage("outdoor", inner(t));
    await onlyJobsOf(t);
    await sql()`update public.jobs set payload = jsonb_set(payload, '{requestedAt}', to_jsonb(${Date.now() - repo.ABANDONED_REQUEST_MS - 1_000}::bigint))
                 where kind = 'catalog.ingest_tile' and payload->>'tileKey' = ${t.key}`;
    expect(await runIngest()).toMatchObject({ claimed: 1, noop: 1 });
    expect(fake.calls).toHaveLength(0);
    const [job] = await ingestJobs(t);
    expect(job.status).toBe("succeeded");
    expect(job.lastError).toMatch(/^skipped: nobody asked for this area in the last 20 minutes/);
    expect(await tileState(t)).toBeUndefined();

    // Background refreshes (requestedAt 0) are never dropped, however old.
    const bg = freshTile();
    respondFor(bg, () => ({ trails: [], pois: [], dataTimestamp: null }));
    await ensureCoverage("outdoor", inner(bg));
    await onlyJobsOf(bg);
    await sql()`update public.jobs set payload = jsonb_set(payload, '{requestedAt}', '0'::jsonb), created_at = now() - interval '2 days'
                 where kind = 'catalog.ingest_tile' and payload->>'tileKey' = ${bg.key}`;
    expect(await runIngest()).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await tileState(bg)).toMatchObject({ status: "ready" });
  });

  it("serves the most recently requested area first; background refreshes last", async () => {
    const [older, newer, background] = [freshTile(), freshTile(), freshTile()];
    for (const t of [older, newer, background]) await ensureCoverage("outdoor", inner(t));
    await sql()`update public.jobs set status = 'cancelled', finished_at = now()
                 where kind like 'catalog.%' and status = 'queued' and payload->>'tileKey' not in (${older.key}, ${newer.key}, ${background.key})`;
    const set = (t: Tile, ms: number) =>
      sql()`update public.jobs set payload = jsonb_set(payload, '{requestedAt}', to_jsonb(${ms}::bigint)) where kind = 'catalog.ingest_tile' and payload->>'tileKey' = ${t.key}`;
    await set(older, Date.now() - 5 * 60_000);
    await set(newer, Date.now());
    await set(background, 0);
    const handlers = createCatalogHandlers({ concurrencyCap: 1000 });
    for (let i = 0; i < 3; i++) await runDueJobs(handlers, { kinds: [repo.INGEST_JOB_KIND], limit: 1, order: "recent_request" });
    expect(fake.calls).toEqual([newer, older, background].map((t) => `${t.bbox[0]},${t.bbox[1]}`));
  });

  it("marks the tile failed and lets the queue retry a retryable failure", async () => {
    const t = freshTile();
    respondFor(t, () => {
      throw new ProviderError("overpass", "HTTP 503", 503, true);
    });
    await ensureCoverage("outdoor", inner(t));
    await onlyJobsOf(t);
    expect(await runIngest()).toMatchObject({ claimed: 1, retried: 1 });
    const [job] = await ingestJobs(t);
    expect(job).toMatchObject({ status: "queued", attempts: 1, delayed: true });
    expect(job.lastError).toMatch(/HTTP 503/);
    expect(await tileState(t)).toMatchObject({ status: "failed", attempts: 1 });
    // The coverage reports the queued retry as loading, not as a final failure.
    expect((await ensureCoverage("outdoor", inner(t))).state).toBe("loading");
  });

  it("ends the job on a non-retryable failure (tile failed with backoff) and on invalid payloads", async () => {
    const t = freshTile();
    respondFor(t, () => {
      throw new ProviderError("overpass", "HTTP 400", 400, false);
    });
    await ensureCoverage("outdoor", inner(t));
    await onlyJobsOf(t);
    expect(await runIngest()).toMatchObject({ claimed: 1, noop: 1 });
    const [job] = await ingestJobs(t);
    expect(job.status).toBe("succeeded");
    expect(job.lastError).toMatch(/failed, not retried: OpenStreetMap Overpass API: HTTP 400/);
    expect(await tileState(t)).toMatchObject({ status: "failed", attempts: 1 });

    for (const payload of [{}, { layer: "outdoor", provider: "osm", tileKey: "bogus" }, { layer: "moon", provider: "osm", tileKey: t.key }]) {
      const { id } = await enqueueJob(null, repo.INGEST_JOB_KIND, payload);
      const s = await runDueJobs(createCatalogHandlers(), { kinds: [repo.INGEST_JOB_KIND] });
      expect(s).toMatchObject({ claimed: 1, noop: 1 });
      const [row] = await sql()<{ status: string; lastError: string }[]>`select status::text as status, last_error from public.jobs where id = ${id}`;
      expect(row).toMatchObject({ status: "succeeded", lastError: "invalid payload (expected layer, provider, tileKey)" });
    }
  });
});

// ---------------------------------------------------------------------------
describe("catalog.refresh_stale", () => {
  it("enqueues due refreshes, due retries, crashed fetches and orphaned pending tiles — once each", async () => {
    const due = freshTile();
    const retry = freshTile();
    const fresh = freshTile();
    const crashed = freshTile();
    const orphan = freshTile();
    const waiting = freshTile();
    for (const t of [due, retry, fresh, crashed, orphan, waiting]) await ensureCoverage("outdoor", inner(t));
    await sql()`update public.jobs set status = 'succeeded', finished_at = now()
                 where kind = 'catalog.ingest_tile' and status = 'queued'
                   and payload->>'tileKey' in (${due.key}, ${retry.key}, ${fresh.key}, ${crashed.key}, ${orphan.key})`;
    await sql()`update public.catalog_tiles set status = 'ready', last_synced_at = now() - interval '31 days', next_refresh_at = now() - interval '1 day' where layer = 'outdoor' and tile_key = ${due.key}`;
    await sql()`update public.catalog_tiles set status = 'failed', attempts = 2, next_refresh_at = now() - interval '1 minute' where layer = 'outdoor' and tile_key = ${retry.key}`;
    await sql()`update public.catalog_tiles set status = 'ready', last_synced_at = now(), next_refresh_at = now() + interval '29 days' where layer = 'outdoor' and tile_key = ${fresh.key}`;
    await sql()`update public.catalog_tiles set status = 'fetching', fetch_started_at = now() - interval '20 minutes' where layer = 'outdoor' and tile_key = ${crashed.key}`;
    // `orphan` stays pending with its job finished; `waiting` stays pending with its job still queued.

    const r1 = await refreshStaleTiles(10_000);
    expect(r1.enqueued).toBeGreaterThanOrEqual(4);
    const queued = async (t: Tile) => (await ingestJobs(t)).filter((j) => j.status === "queued").length;
    expect(await queued(due)).toBe(1);
    expect(await queued(retry)).toBe(1);
    expect(await queued(crashed)).toBe(1);
    expect(await queued(orphan)).toBe(1);
    expect(await queued(fresh)).toBe(0);
    expect(await queued(waiting)).toBe(1);
    expect(await ingestJobs(waiting)).toHaveLength(1); // its original job, not a second one

    await refreshStaleTiles(10_000);
    for (const t of [due, retry, crashed, orphan, waiting]) expect(await queued(t)).toBe(1);

    // Background work: it runs after every live request and is never dropped as abandoned.
    const [bg] = await sql()<{ requestedAt: number }[]>`
      select (payload->>'requestedAt')::float8 as requested_at from public.jobs
       where kind = 'catalog.ingest_tile' and payload->>'tileKey' = ${due.key} and status = 'queued'`;
    expect(bg.requestedAt).toBe(0);
  });

  it("runs as a job and reports what it did", async () => {
    const { id } = await enqueueJob(null, "catalog.refresh_stale", {});
    await runDueJobs(createCatalogHandlers(), { kinds: ["catalog.refresh_stale"] });
    const [row] = await sql()<{ status: string; lastError: string }[]>`select status::text as status, last_error from public.jobs where id = ${id}`;
    expect(row.status).toBe("succeeded");
    expect(row.lastError).toMatch(/tile\(s\) enqueued of \d+ needing work/);
  });
});

// ---------------------------------------------------------------------------
describe("catalog.purge_caches", () => {
  it("deletes expired cache rows and old usage rows, keeps the rest", async () => {
    const k = `purge-${seq++}`;
    await sql()`insert into public.geocode_cache (provider, query_key, results, expires_at) values
                 ('nominatim', ${`${k}-old`}, '[]'::jsonb, now() - interval '1 minute'),
                 ('nominatim', ${`${k}-new`}, '[]'::jsonb, now() + interval '1 day')`;
    await sql()`insert into public.weather_cache (provider, cache_key, payload, expires_at) values
                 ('metno', ${`${k}-old`}, '{}'::jsonb, now() - interval '1 minute'),
                 ('metno', ${`${k}-new`}, '{}'::jsonb, now() + interval '1 hour')`;
    await sql()`insert into public.geo_admin_cache (provider, cell_key, expires_at) values
                 ('nominatim', ${`${k}-old`}, now() - interval '1 minute'),
                 ('nominatim', ${`${k}-new`}, now() + interval '100 days')`;
    await sql()`insert into public.external_api_usage (provider, day, requests) values
                 (${`${k}-p`}, (now() at time zone 'utc')::date - 401, 5),
                 (${`${k}-p`}, (now() at time zone 'utc')::date - 399, 5)
                on conflict do nothing`;

    const r = await purgeCatalogCaches();
    expect(r.geocode).toBeGreaterThanOrEqual(1);
    expect(r.weather).toBeGreaterThanOrEqual(1);
    expect(r.admin).toBeGreaterThanOrEqual(1);
    expect(r.usage).toBeGreaterThanOrEqual(1);
    const left = await sql()<{ t: string; key: string }[]>`
      select 'geocode' as t, query_key as key from public.geocode_cache where query_key like ${`${k}%`}
      union all select 'weather', cache_key from public.weather_cache where cache_key like ${`${k}%`}
      union all select 'admin', cell_key from public.geo_admin_cache where cell_key like ${`${k}%`}
      union all select 'usage', day::text from public.external_api_usage where provider = ${`${k}-p`}
      order by 1`;
    expect(left.map((l) => l.t)).toEqual(["admin", "geocode", "usage", "weather"]);
    expect(left.filter((l) => l.t !== "usage").every((l) => l.key.endsWith("-new"))).toBe(true);
  });
});

describe("periodic schedule", () => {
  it("refreshes stale tiles hourly and purges caches daily", () => {
    expect(PERIODIC_JOBS).toContainEqual({ kind: "catalog.refresh_stale", everyMinutes: 60 });
    expect(PERIODIC_JOBS).toContainEqual({ kind: "catalog.purge_caches", everyMinutes: 60 * 24 });
    expect(CATALOG_JOB_KINDS).toEqual(["catalog.ingest_tile", "catalog.refresh_stale", "catalog.purge_caches"]);
  });
});

// ---------------------------------------------------------------------------
describe("cron runners", () => {
  const call = (route: (r: Request) => Promise<Response>, auth?: string) =>
    route(new Request("http://localhost/api/cron/x", { headers: auth ? { authorization: auth } : {} }));

  it("both runners require the Bearer CRON_SECRET", async () => {
    for (const route of [catalogCron, jobsCron]) {
      expect((await call(route)).status).toBe(401);
      expect((await call(route, "Bearer wrong-secret-0123456789")).status).toBe(401);
      expect((await call(route, CRON_SECRET)).status).toBe(401);
    }
  });

  it("the catalog runner first drops loads nobody asked about for 20 minutes", async () => {
    const t = freshTile();
    await ensureCoverage("outdoor", inner(t));
    await onlyJobsOf(t);
    await sql()`update public.jobs set payload = jsonb_set(payload, '{requestedAt}', to_jsonb(${Date.now() - repo.ABANDONED_REQUEST_MS - 60_000}::bigint)),
                       run_at = now() + interval '1 hour'
                 where kind = 'catalog.ingest_tile' and payload->>'tileKey' = ${t.key}`;
    const res = await call(catalogCron, `Bearer ${CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { abandoned: number }).abandoned).toBeGreaterThanOrEqual(1);
    expect(await ingestJobs(t)).toMatchObject([{ status: "cancelled" }]);
    expect(await tileState(t)).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });

  it("the safety runner never runs catalog jobs; the catalog runner does", async () => {
    const t = freshTile();
    respondFor(t, () => ({ trails: [trailIn(t, "Cron Loaded Track")], pois: [], dataTimestamp: null }));
    await ensureCoverage("outdoor", inner(t));
    await onlyJobsOf(t);
    const purge = await enqueueJob(null, "catalog.purge_caches", {});
    // A harmless safety-runner job, to prove the route does run what it may run.
    const ops = await enqueueJob(null, "ops.purge_rate_limits", {}, { dedupKey: `test:catalog-jobs:${seq++}` });

    fake.routeScope = ["ops.purge_rate_limits", repo.INGEST_JOB_KIND, "catalog.purge_caches"];
    try {
      const jobsRes = await call(jobsCron, `Bearer ${CRON_SECRET}`);
      expect(jobsRes.status).toBe(200);
    } finally {
      fake.routeScope = null;
    }
    const [o1] = await sql()<{ status: string }[]>`select status::text as status from public.jobs where id = ${ops.id}`;
    expect(o1.status).toBe("succeeded");
    expect(await ingestJobs(t)).toMatchObject([{ status: "queued", attempts: 0 }]);
    const [p1] = await sql()<{ status: string }[]>`select status::text as status from public.jobs where id = ${purge.id}`;
    expect(p1.status).toBe("queued");
    expect(fake.calls).toHaveLength(0);

    const catRes = await call(catalogCron, `Bearer ${CRON_SECRET}`);
    expect(catRes.status).toBe(200);
    const body = (await catRes.json()) as { ok: boolean; claimed: number; succeeded: number };
    expect(body.ok).toBe(true);
    expect(body.claimed).toBeGreaterThanOrEqual(2);
    expect(await ingestJobs(t)).toMatchObject([{ status: "succeeded" }]);
    const [p2] = await sql()<{ status: string }[]>`select status::text as status from public.jobs where id = ${purge.id}`;
    expect(p2.status).toBe("succeeded");
    expect(await tileState(t)).toMatchObject({ status: "ready" });
    const [trail] = await sql()<{ name: string }[]>`select name from public.catalog_trails where name = 'Cron Loaded Track'`;
    expect(trail?.name).toBe("Cron Loaded Track");
  });
});
