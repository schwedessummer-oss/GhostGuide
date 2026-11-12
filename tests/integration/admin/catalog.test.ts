/**
 * Admin "Trail data" (/admin/data) against Postgres: permission gates (views
 * need integrations.view, mutations catalog.manage), provider-usage
 * aggregation math, coverage / catalog / job overviews, the "Retry now"
 * action (enqueues through repository.requestTileIngest, makes ready tiles
 * due, expedites a load queued for later), and trail moderation (hide /
 * unhide by id, path or URL, audited with a reason, effective in public
 * reads through RLS). The page and its server actions are rendered outside
 * Next.js like tests/integration/admin/pages.test.ts.
 *
 * Rows use provider ids / areas no other test touches: tiles around
 * lng −40…−39, lat −60 (ocean), trails with provider "zzmod" in country "zz".
 */
import { randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import { prerenderToNodeStream } from "react-dom/static";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, sql, withSystem } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { signSession } from "@/server/auth/tokens";
import { offsetMeters } from "@/domain/geo";
import { tileForPoint } from "@/server/geo/tiles";
import { ingestTile } from "@/server/trails/ingest";
import type { NormalizedTrail, TrailDataProvider } from "@/server/trails/types";
import {
  buildProviderUsageRows,
  getCatalogJobs,
  getCatalogOverview,
  getCoverageOverview,
  getProviderUsage,
  hideCatalogTrail,
  parseTrailRef,
  requestTileRetry,
  unhideCatalogTrail,
} from "@/server/admin/catalog";
import { getTrailDetailById, getTrailDetailByPath, getTrailSummariesByIds } from "@/server/trails/read";
import * as repo from "@/server/trails/repository";
import { demoUser } from "../../helpers/db";
import { expectForbidden, expectOk } from "./helpers";

const jar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "gg_session" && jar.token ? { name, value: jar.token } : undefined),
    getAll: () => [],
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ refresh: () => {}, revalidatePath: () => {} }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/admin/data",
}));

const signIn = (user: SessionUser) => {
  jar.token = signSession(process.env.AUTH_SECRET!, { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600 });
};

async function render(el: ReactElement): Promise<string> {
  const { prelude } = await prerenderToNodeStream(el);
  let html = "";
  for await (const chunk of prelude) html += chunk.toString();
  return html.replaceAll("<!-- -->", "");
}

async function thrownDigest(p: Promise<unknown>): Promise<string> {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { digest?: string } | null;
  return err?.digest ?? `no digest: ${String(err)}`;
}

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

const MY_PROVIDER = "zzmod";
const createdTiles: { layer: string; provider: string; tileKey: string }[] = [];

beforeEach(() => {
  jar.token = undefined;
});

afterAll(async () => {
  // Leave no queued catalog work behind for other suites.
  for (const t of createdTiles) {
    await sql()`update public.jobs set status = 'cancelled', finished_at = now()
                 where kind = ${repo.INGEST_JOB_KIND} and status in ('queued', 'running')
                   and payload->>'tileKey' = ${t.tileKey} and payload->>'provider' = ${t.provider}`;
  }
  await sql()`delete from public.external_api_usage where provider like 'zz%'`;
  await closeDb();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let tileSeq = 0;
/** A fresh outdoor tile in the empty South Atlantic (no other test uses it). */
function freshTile() {
  const i = tileSeq++;
  return tileForPoint("outdoor", -40 + (i % 8) * 0.25 + 0.1, -60 + Math.floor(i / 8) * 0.25 + 0.1);
}

async function insertTile(opts: {
  status: repo.TileStatus;
  provider?: string;
  attempts?: number;
  lastError?: string | null;
  synced?: boolean;
  nextRefresh?: string;
}): Promise<{ layer: "outdoor"; provider: string; tileKey: string }> {
  const tile = freshTile();
  const provider = opts.provider ?? "osm";
  const [w, s, e, n] = tile.bbox;
  await withSystem(
    (tx) => tx`
      insert into public.catalog_tiles (layer, provider, tile_key, bounds, status, attempts, last_error, last_synced_at,
                                        next_refresh_at, trail_count, poi_count, requested_at)
      values ('outdoor', ${provider}, ${tile.key}, st_makeenvelope(${w}, ${s}, ${e}, ${n}, 4326), ${opts.status}, ${opts.attempts ?? 0},
              ${opts.lastError ?? null}, ${opts.synced ? new Date() : null}::timestamptz,
              now() + ${opts.nextRefresh ?? "1 hour"}::interval, ${opts.synced ? 3 : 0}, ${opts.synced ? 7 : 0},
              date_trunc('milliseconds', now() - interval '1 day'))`,
  );
  const t = { layer: "outdoor" as const, provider, tileKey: tile.key };
  createdTiles.push(t);
  return t;
}

async function readTile(t: { provider: string; tileKey: string }) {
  const [row] = await withSystem((tx) => repo.readTiles(tx, "outdoor", [{ provider: t.provider, tileKey: t.tileKey }]));
  return row;
}

async function insertTrail(opts: { hidden?: boolean; retired?: boolean; name?: string } = {}) {
  const slug = `mod-${randomUUID().slice(0, 8)}`;
  const lng = -39 + Math.random() * 0.5;
  const lat = -61;
  const [row] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      with g as (select st_setsrid(st_geomfromgeojson(${JSON.stringify({ type: "MultiLineString", coordinates: [[[lng, lat], [lng + 0.01, lat + 0.01]]] })}), 4326) as geom)
      insert into public.catalog_trails (provider, provider_id, name, slug, country_code, region_name, region_slug, centroid, geom,
                                         distance_m, route_type, source_name, source_license, hidden, hidden_reason, retired_at)
      select ${MY_PROVIDER}, ${`relation/${randomUUID()}`}, ${opts.name ?? "Moderation Test Trail"}, ${slug}, 'zz', 'Test Region', 'test-region',
             st_centroid(g.geom)::geography, g.geom, 1400, 'linear', 'Test source', 'ODbL 1.0',
             ${opts.hidden ?? opts.retired ?? false}, ${opts.retired ? "Not found in OpenStreetMap on 2026-11-01" : opts.hidden ? "Seeded hidden" : null},
             ${opts.retired ? new Date() : null}::timestamptz
        from g
      returning id`,
  );
  return { id: row.id, path: `/trail/zz/test-region/${slug}`, slug };
}

async function auditFor(entityId: string) {
  return sql()<{ action: string; actorId: string; actorRoles: string[]; entityType: string; metadata: Record<string, unknown> }[]>`
    select action, actor_id, actor_roles, entity_type, metadata from public.audit_logs where entity_id = ${entityId} order by id`;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------
describe("trail data: permissions", () => {
  it("support, safety and content editors can neither view nor change catalog data", async () => {
    const tile = await insertTile({ status: "failed", attempts: 1, lastError: "HTTP 504" });
    const trail = await insertTrail();
    for (const key of ["support", "safety", "editor"] as const) {
      const u = await demoUser(key);
      await expectForbidden(getProviderUsage(u));
      await expectForbidden(getCoverageOverview(u));
      await expectForbidden(getCatalogOverview(u));
      await expectForbidden(getCatalogJobs(u));
      await expectForbidden(requestTileRetry(u, tile));
      await expectForbidden(hideCatalogTrail(u, { trail: trail.id, reason: "Should not be allowed" }));
      await expectForbidden(unhideCatalogTrail(u, { trail: trail.id, reason: "Should not be allowed" }));
    }
    const [t] = await sql()<{ hidden: boolean }[]>`select hidden from public.catalog_trails where id = ${trail.id}`;
    expect(t.hidden).toBe(false);
    expect(await auditFor(trail.id)).toEqual([]);
    const [job] = await sql()`select 1 from public.jobs where payload->>'tileKey' = ${tile.tileKey} and status = 'queued'`;
    expect(job).toBeUndefined();
  });

  it("admins and operators can view and change it", async () => {
    for (const key of ["admin", "operator"] as const) {
      const u = await demoUser(key);
      await expect(getProviderUsage(u)).resolves.toBeInstanceOf(Array);
      await expect(getCoverageOverview(u)).resolves.toHaveProperty("counts");
      await expect(getCatalogOverview(u)).resolves.toHaveProperty("byProvider");
      await expect(getCatalogJobs(u)).resolves.toHaveProperty("failed");
      const trail = await insertTrail();
      expectOk(await hideCatalogTrail(u, { trail: trail.id, reason: `Hidden by ${key} in a test` }));
      expectOk(await unhideCatalogTrail(u, { trail: trail.id, reason: `Unhidden by ${key} in a test` }));
    }
  });

  it("the page needs integrations.view; its server actions need catalog.manage", async () => {
    const { default: Page } = await import("@/app/admin/data/page");
    expect(await thrownDigest(Page())).toMatch(/NEXT_REDIRECT;[^;]*;\/login\?next=%2Fadmin%2Fdata;/);
    signIn(await demoUser("support"));
    expect(await thrownDigest(Page())).toMatch(/NEXT_REDIRECT;.*\/forbidden/);

    const trail = await insertTrail();
    const { hideTrailAction } = await import("@/app/admin/data/actions");
    expect(await thrownDigest(hideTrailAction(undefined, form({ trail: trail.id, reason: "Support tries to hide" })))).toMatch(/NEXT_REDIRECT;.*\/forbidden/);
    const [t] = await sql()<{ hidden: boolean }[]>`select hidden from public.catalog_trails where id = ${trail.id}`;
    expect(t.hidden).toBe(false);

    signIn(await demoUser("admin"));
    const r = await hideTrailAction(undefined, form({ trail: trail.path, reason: "Admin hides via the form" }));
    expect(r).toMatchObject({ ok: true });
    expect(await getTrailDetailById(trail.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Provider usage
// ---------------------------------------------------------------------------
describe("trail data: provider usage aggregation", () => {
  it("sums today, the last 7 and the last 30 UTC days, and keeps the latest error and status", async () => {
    const admin = await demoUser("admin");
    const p = `zz${randomUUID().slice(0, 6).replace(/-/g, "")}`;
    await withSystem(async (tx) => {
      const today = tx`(now() at time zone 'utc')::date`;
      await tx`insert into public.external_api_usage (provider, day, requests, errors, cache_hits, bytes, last_status, last_error, last_request_at, last_success_at)
               values (${p}, ${today}, 10, 2, 5, 1000, 503, 'HTTP 503 for ops@example.com', now(), now() - interval '1 hour')`;
      await tx`insert into public.external_api_usage (provider, day, requests, errors, cache_hits, bytes, last_status, last_error, last_request_at, last_success_at)
               values (${p}, ${today} - 3, 20, 0, 1, 2000, 200, null, now() - interval '3 days', now() - interval '3 days')`;
      await tx`insert into public.external_api_usage (provider, day, requests, errors, cache_hits, bytes, last_status, last_error, last_request_at, last_success_at)
               values (${p}, ${today} - 10, 30, 3, 0, 3000, null, 'Timed out after 15000 ms', now() - interval '10 days', null)`;
      // Outside the 30-day window: counted nowhere except "last success".
      await tx`insert into public.external_api_usage (provider, day, requests, errors, cache_hits, bytes, last_status, last_error, last_request_at, last_success_at)
               values (${p}, ${today} - 30, 1000, 900, 0, 99999, 200, 'old', now() - interval '30 days', now() - interval '30 days')`;
      // Cache hits only (no request).
      await tx`insert into public.external_api_usage (provider, day, cache_hits) values (${p}, ${today} - 1, 4)`;
    });
    const rows = await getProviderUsage(admin);
    const row = rows.find((r) => r.provider === p)!;
    expect(row).toBeDefined();
    expect(row.today).toEqual({ requests: 10, errors: 2, cacheHits: 5, bytes: 1000, errorRate: 0.2 });
    expect(row.last7d).toEqual({ requests: 30, errors: 2, cacheHits: 10, bytes: 3000, errorRate: 2 / 30 });
    expect(row.last30d).toEqual({ requests: 60, errors: 5, cacheHits: 10, bytes: 6000, errorRate: 5 / 60 });
    expect(row.peakDayRequests7d).toBe(20);
    expect(row.lastStatus).toBe(503);
    expect(row.lastError).toBe("HTTP 503 for [email]");
    const [{ today }] = await sql()<{ today: string }[]>`select ((now() at time zone 'utc')::date)::text as today`;
    expect(row.lastErrorDay).toBe(today);
    expect(Date.now() - row.lastSuccessAt!.getTime()).toBeGreaterThan(55 * 60_000);
    expect(Date.now() - row.lastSuccessAt!.getTime()).toBeLessThan(65 * 60_000);
    // Unknown to provider-costs.ts: listed honestly without a cost.
    expect(row.policy).toBeNull();
    expect(row.estimatedMonthlyCostUsd).toBeNull();
    expect(row.label).toBe(p);
  });

  it("lists every known provider with its policy, $0 estimate, configuration state and limit warnings", async () => {
    const admin = await demoUser("admin");
    const saved = await sql()<Record<string, unknown>[]>`select * from public.external_api_usage where provider = 'overpass'`;
    try {
      await sql()`delete from public.external_api_usage where provider = 'overpass'`;
      await sql()`insert into public.external_api_usage (provider, day, requests, errors, bytes, last_status, last_request_at, last_success_at)
                  values ('overpass', (now() at time zone 'utc')::date, 8500, 10, 50000000, 200, now(), now())`;
      const rows = await getProviderUsage(admin);
      expect(rows.slice(0, 6).map((r) => r.provider)).toEqual(["overpass", "nominatim", "metno", "nws", "terrain_tiles", "ridb"]);
      const overpass = rows.find((r) => r.provider === "overpass")!;
      expect(overpass.today.requests).toBe(8500);
      expect(overpass.estimatedMonthlyCostUsd).toBe(0);
      expect(overpass.policy?.policy).toContain("10 000 queries/day");
      expect(overpass.warnings).toEqual([{ level: "warning", message: expect.stringContaining("8,500 requests today: 85 %") }]);
      const ridb = rows.find((r) => r.provider === "ridb")!;
      expect(ridb.configured).toBe(Boolean(process.env.RIDB_API_KEY));
      for (const r of rows.slice(0, 6)) expect(r.policy).not.toBeNull();
    } finally {
      await sql()`delete from public.external_api_usage where provider = 'overpass'`;
      for (const r of saved) await sql()`insert into public.external_api_usage ${sql()(r as Record<string, never>)}`;
    }
  });

  it("builds zero rows for providers without usage (pure)", () => {
    const rows = buildProviderUsageRows([]);
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.today).toEqual({ requests: 0, errors: 0, cacheHits: 0, bytes: 0, errorRate: null });
      expect(r.lastSuccessAt).toBeNull();
      expect(r.warnings).toEqual([]);
      expect(r.estimatedMonthlyCostUsd).toBe(0);
    }
  });

  it("flags a provider whose every request of the last 7 days failed (pure)", () => {
    const zero = Object.fromEntries(
      ["requestsToday", "errorsToday", "cacheHitsToday", "bytesToday", "requests7d", "errors7d", "cacheHits7d", "bytes7d", "peakDayRequests7d", "peakDayBytes7d", "requests30d", "errors30d", "cacheHits30d", "bytes30d"].map((k) => [k, 0]),
    );
    const agg = { ...zero, provider: "overpass", requestsToday: 18, errorsToday: 18, requests7d: 18, errors7d: 18, requests30d: 18, errors30d: 18, lastRequestAt: new Date(), lastSuccessAt: null, lastStatus: null, lastError: "fetch failed", lastErrorDay: "2026-11-12" };
    const [overpass] = buildProviderUsageRows([agg as never]);
    expect(overpass.warnings.map((w) => w.level)).toEqual(["warning", "critical"]);
    expect(overpass.warnings[0].message).toBe("100 % of today's requests failed (18 of 18).");
    expect(overpass.warnings[1].message).toMatch(/^All 18 request\(s\) of the last 7 days failed/);
  });
});

// ---------------------------------------------------------------------------
// Coverage and jobs overviews
// ---------------------------------------------------------------------------
describe("trail data: coverage, catalog and jobs overviews", () => {
  it("counts tiles by layer, provider and status, lists failures and recent syncs", async () => {
    const admin = await demoUser("admin");
    const before = await getCoverageOverview(admin, { failures: 100, recent: 100 });
    const failed = await insertTile({ status: "failed", provider: "zzcov", attempts: 3, lastError: "Overpass: HTTP 504", nextRefresh: "40 minutes" });
    const refreshFailing = await insertTile({ status: "ready", provider: "zzcov", attempts: 1, lastError: "Timed out", synced: true, nextRefresh: "-5 minutes" });
    await insertTile({ status: "pending", provider: "zzcov" });
    const after = await getCoverageOverview(admin, { failures: 100, recent: 100 });

    expect(after.counts.find((c) => c.provider === "zzcov")).toEqual({
      layer: "outdoor",
      provider: "zzcov",
      pending: 1,
      fetching: 0,
      ready: 1,
      failed: 1,
      total: 3,
      readyRefreshFailing: 1,
    });
    expect(after.dueNow).toBe(before.dueNow + 1);
    const f = after.failures.find((t) => t.tileKey === failed.tileKey)!;
    expect(f).toMatchObject({ provider: "zzcov", status: "failed", attempts: 3, lastError: "Overpass: HTTP 504", jobStatus: null, retryable: false });
    expect(f.bbox).toHaveLength(4);
    expect(after.failures.some((t) => t.tileKey === refreshFailing.tileKey)).toBe(true);
    expect(after.recentlySynced[0]).toMatchObject({ tileKey: refreshFailing.tileKey, trailCount: 3, poiCount: 7 });
    expect(after.oldestDueAt).not.toBeNull();
  });

  it("counts visible, hidden and retired trails by provider and country", async () => {
    const admin = await demoUser("admin");
    const before = await getCatalogOverview(admin);
    const prev = before.byProvider.find((r) => r.key === MY_PROVIDER) ?? { visible: 0, hidden: 0, retired: 0, total: 0 };
    await insertTrail({ name: "Newest visible" });
    await insertTrail({ hidden: true });
    await insertTrail({ retired: true });
    const after = await getCatalogOverview(admin);
    expect(after.byProvider.find((r) => r.key === MY_PROVIDER)).toEqual({
      key: MY_PROVIDER,
      visible: prev.visible + 1,
      hidden: prev.hidden + 1,
      retired: prev.retired + 1,
      total: prev.total + 3,
    });
    expect(after.byCountry.find((r) => r.key === "zz")?.total).toBe(prev.total + 3);
    expect(after.newest[0].state).toBe("retired");
    expect(after.newest.map((t) => t.name)).toContain("Newest visible");
    expect(after.newest[0].path).toMatch(/^\/trail\/zz\/test-region\/mod-/);
    expect(after.hidden.some((t) => t.hiddenReason === "Seeded hidden")).toBe(true);
    expect(after.hidden.every((t) => t.state === "hidden")).toBe(true);
  });

  it("summarizes catalog jobs and shows only the tile reference of a payload", async () => {
    const admin = await demoUser("admin");
    const tileKey = freshTile().key;
    const [dead] = await sql()<{ id: number }[]>`
      insert into public.jobs (kind, payload, status, attempts, max_attempts, last_error, finished_at)
      values (${repo.INGEST_JOB_KIND}, ${sql().json({ layer: "outdoor", provider: "osm", tileKey, note: "SECRET-PAYLOAD-VALUE" })}, 'dead', 4, 4,
              'OpenStreetMap Overpass API: HTTP 504 (contact ops@example.com)', now())
      returning id`;
    const [retrying] = await sql()<{ id: number }[]>`
      insert into public.jobs (kind, payload, status, attempts, max_attempts, last_error, run_at)
      values ('catalog.refresh_stale', ${sql().json({})}, 'queued', 1, 5, 'connection reset', now() + interval '10 minutes')
      returning id`;
    const [deferred] = await sql()<{ id: number }[]>`
      insert into public.jobs (kind, payload, status, attempts, max_attempts, last_error, run_at)
      values ('catalog.purge_caches', ${sql().json({})}, 'queued', 1, 5, 'deferred: osm concurrency limit reached', now() + interval '1 minute')
      returning id`;
    const [waiting] = await sql()<{ id: number }[]>`
      insert into public.jobs (kind, payload, status, run_at)
      values ('catalog.refresh_stale', ${sql().json({})}, 'queued', now() - interval '25 minutes')
      returning id`;
    try {
      const jobs = await getCatalogJobs(admin);
      expect(jobs.runnerLooksStopped).toBe(true);
      expect(Date.now() - jobs.oldestDueQueuedAt!.getTime()).toBeGreaterThanOrEqual(25 * 60_000 - 5_000);
      expect(jobs.counts.find((c) => c.kind === repo.INGEST_JOB_KIND && c.status === "dead")?.n).toBeGreaterThanOrEqual(1);
      const d = jobs.failed.find((j) => j.id === dead.id)!;
      expect(d).toMatchObject({ kind: repo.INGEST_JOB_KIND, status: "dead", retrying: false, attempts: 4, maxAttempts: 4, target: `outdoor · osm · ${tileKey}` });
      expect(d.lastError).toBe("OpenStreetMap Overpass API: HTTP 504 (contact [email])");
      expect(JSON.stringify(jobs)).not.toContain("SECRET-PAYLOAD-VALUE");
      expect(jobs.failed.find((j) => j.id === retrying.id)).toMatchObject({ retrying: true, target: null });
      expect(jobs.failed.some((j) => j.id === deferred.id)).toBe(false);
    } finally {
      await sql()`update public.jobs set status = 'cancelled', finished_at = now() where id = any(${[dead.id, retrying.id, deferred.id, waiting.id]}::bigint[])`;
    }
  });
});

// ---------------------------------------------------------------------------
// Retry now
// ---------------------------------------------------------------------------
describe("trail data: retry now", () => {
  it("queues a load for a failed tile through requestTileIngest and audits it", async () => {
    const admin = await demoUser("admin");
    const tile = await insertTile({ status: "failed", attempts: 2, lastError: "Overpass: HTTP 429", nextRefresh: "3 hours" });
    const before = await readTile(tile);
    const r = await requestTileRetry(admin, { ...tile, reason: "Provider is back up" });
    expectOk(r);
    const after = await readTile(tile);
    expect(Number(after.requestGen)).toBeGreaterThan(Number(before.requestGen));
    expect(after.jobStatus).toBe("queued");
    const [job] = await sql()<{ id: number; kind: string; payload: unknown; runAt: Date; status: string }[]>`
      select id, kind, payload, run_at, status from public.jobs where dedup_key = ${repo.ingestJobKey("outdoor", tile.provider, tile.tileKey, after.requestGen)}`;
    expect(job).toMatchObject({ kind: repo.INGEST_JOB_KIND, status: "queued", payload: { layer: "outdoor", provider: "osm", tileKey: tile.tileKey } });
    expect(job.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(r.data?.jobId).toBe(job.id);
    expect(r.message).toContain(`job #${job.id}`);

    const audit = await auditFor(`outdoor:osm:${tile.tileKey}`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "catalog.tile_retry_requested", actorId: admin.id, entityType: "catalog_tile" });
    expect(audit[0].actorRoles).toContain("admin");
    expect(audit[0].metadata).toMatchObject({ reason: "Provider is back up", mode: "requested", fromStatus: "failed", attempts: 2, tileKey: tile.tileKey, jobId: job.id });

    // A second click while the load is queued for later brings it forward instead of queueing another.
    await sql()`update public.jobs set run_at = now() + interval '30 minutes' where id = ${job.id}`;
    const again = await requestTileRetry(admin, tile);
    expectOk(again);
    const jobs = await sql()<{ id: number; runAt: Date }[]>`
      select id, run_at from public.jobs where kind = ${repo.INGEST_JOB_KIND} and payload->>'tileKey' = ${tile.tileKey} and status = 'queued'`;
    expect(jobs.map((j) => j.id)).toEqual([job.id]);
    expect(jobs[0].runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const audit2 = await auditFor(`outdoor:osm:${tile.tileKey}`);
    expect(audit2).toHaveLength(2);
    expect(audit2[1].metadata).toMatchObject({ mode: "expedited", jobId: job.id, reason: "Manual retry from the Trail data page" });
  });

  it("makes a loaded tile due so the queued load can claim it", async () => {
    const operator = await demoUser("operator");
    const tile = await insertTile({ status: "ready", attempts: 1, lastError: "Timed out", synced: true, nextRefresh: "20 days" });
    expectOk(await requestTileRetry(operator, tile));
    const row = await readTile(tile);
    expect(row.due).toBe(true);
    expect(row.jobStatus).toBe("queued");
    expect(repo.tileNeedsWork(row)).toBe(true);
  });

  it("refuses tiles that are loading, unknown, invalid or whose provider is disabled — without auditing", async () => {
    const admin = await demoUser("admin");
    const running = await insertTile({ status: "failed", attempts: 1 });
    const row = await readTile(running);
    await withSystem((tx) => repo.requestTileIngest(tx, "outdoor", running.provider, running.tileKey, row.requestGen));
    await sql()`update public.jobs set status = 'running', locked_at = now()
                 where kind = ${repo.INGEST_JOB_KIND} and payload->>'tileKey' = ${running.tileKey} and status = 'queued'`;
    const r1 = await requestTileRetry(admin, running);
    expect(r1).toMatchObject({ ok: false, error: "This tile is being loaded right now." });

    const fetching = await insertTile({ status: "fetching" });
    await sql()`update public.catalog_tiles set fetch_started_at = now() where tile_key = ${fetching.tileKey} and provider = 'osm'`;
    expect(await requestTileRetry(admin, fetching)).toMatchObject({ ok: false, error: "This tile is being loaded right now." });

    expect(await requestTileRetry(admin, { layer: "outdoor", provider: "osm", tileKey: freshTile().key })).toMatchObject({ ok: false, error: "Tile not found." });
    expect(await requestTileRetry(admin, { layer: "outdoor", provider: "osm", tileKey: "0.5/1/1" })).toMatchObject({ ok: false });
    expect(await requestTileRetry(admin, { layer: "trails", provider: "osm", tileKey: "0.25/1/1" })).toMatchObject({ ok: false });
    expect(await requestTileRetry(admin, { layer: "outdoor", provider: "nope", tileKey: "0.25/1/1" })).toMatchObject({ ok: false, error: expect.stringContaining("Unknown provider") });

    const ridbTile = await insertTile({ status: "failed", provider: "ridb", attempts: 1, lastError: "HTTP 401" });
    const saved = process.env.RIDB_API_KEY;
    delete process.env.RIDB_API_KEY;
    const { resetEnvCache } = await import("@/config/env");
    resetEnvCache();
    try {
      expect(await requestTileRetry(admin, ridbTile)).toMatchObject({ ok: false, error: expect.stringContaining("not enabled") });
    } finally {
      if (saved !== undefined) process.env.RIDB_API_KEY = saved;
      resetEnvCache();
    }
    for (const t of [running, fetching, ridbTile]) expect(await auditFor(`outdoor:${t.provider}:${t.tileKey}`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------
describe("trail data: moderation", () => {
  it("hides a trail by path, which public reads then exclude, and audits who, what and why", async () => {
    const admin = await demoUser("admin");
    const trail = await insertTrail({ name: "Dangerous Shortcut" });
    expect((await getTrailDetailById(trail.id))?.name).toBe("Dangerous Shortcut");

    const r = await hideCatalogTrail(admin, { trail: `https://ghostguide.example/trail/zz/test-region/${trail.slug}?ref=x#map`, reason: "Crosses private land; landowner request" });
    expectOk(r);
    expect(r.data?.id).toBe(trail.id);

    expect(await getTrailDetailById(trail.id)).toBeNull();
    expect(await getTrailDetailByPath("zz", "test-region", trail.slug)).toBeNull();
    expect(await getTrailSummariesByIds([trail.id])).toEqual([]);
    const [row] = await sql()<{ hidden: boolean; hiddenReason: string; retiredAt: Date | null }[]>`
      select hidden, hidden_reason, retired_at from public.catalog_trails where id = ${trail.id}`;
    expect(row).toEqual({ hidden: true, hiddenReason: "Crosses private land; landowner request", retiredAt: null });

    const audit = await auditFor(trail.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "catalog.trail_hidden", actorId: admin.id, entityType: "catalog_trail" });
    expect(audit[0].metadata).toMatchObject({
      reason: "Crosses private land; landowner request",
      name: "Dangerous Shortcut",
      path: trail.path,
      provider: MY_PROVIDER,
      previousState: "visible",
    });

    // Hiding twice is refused (nothing changes, nothing is audited).
    expect(await hideCatalogTrail(admin, { trail: trail.id, reason: "Again, just in case" })).toMatchObject({ ok: false, error: expect.stringContaining("already hidden") });
    expect(await auditFor(trail.id)).toHaveLength(1);
  });

  it("unhides a moderated trail with a reason, making it public again", async () => {
    const admin = await demoUser("admin");
    const trail = await insertTrail();
    expectOk(await hideCatalogTrail(admin, { trail: trail.id, reason: "Suspected duplicate" }));
    expect(await getTrailDetailById(trail.id)).toBeNull();
    expectOk(await unhideCatalogTrail(admin, { trail: trail.path, reason: "Not a duplicate after review" }));
    expect((await getTrailDetailById(trail.id))?.id).toBe(trail.id);
    const [row] = await sql()<{ hidden: boolean; hiddenReason: string | null }[]>`select hidden, hidden_reason from public.catalog_trails where id = ${trail.id}`;
    expect(row).toEqual({ hidden: false, hiddenReason: null });
    const audit = await auditFor(trail.id);
    expect(audit.map((a) => a.action)).toEqual(["catalog.trail_hidden", "catalog.trail_unhidden"]);
    expect(audit[1].metadata).toMatchObject({ reason: "Not a duplicate after review", previousReason: "Suspected duplicate" });
    expect(await unhideCatalogTrail(admin, { trail: trail.id, reason: "Once more please" })).toMatchObject({ ok: false, error: expect.stringContaining("is not hidden") });
  });

  it("never unhides a retired trail by hand; hiding one turns it into a moderation hide", async () => {
    const admin = await demoUser("admin");
    const trail = await insertTrail({ retired: true });
    const r = await unhideCatalogTrail(admin, { trail: trail.id, reason: "Want it back" });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("retired automatically") });
    expect(await auditFor(trail.id)).toEqual([]);

    expectOk(await hideCatalogTrail(admin, { trail: trail.id, reason: "Keep hidden even if OSM restores it" }));
    const [row] = await sql()<{ hidden: boolean; retiredAt: Date | null; hiddenReason: string }[]>`
      select hidden, retired_at, hidden_reason from public.catalog_trails where id = ${trail.id}`;
    expect(row).toEqual({ hidden: true, retiredAt: null, hiddenReason: "Keep hidden even if OSM restores it" });
    expect((await auditFor(trail.id))[0].metadata).toMatchObject({ previousState: "retired" });
  });

  it("requires a reason and a valid trail reference", async () => {
    const admin = await demoUser("admin");
    const trail = await insertTrail();
    const noReason = await hideCatalogTrail(admin, { trail: trail.id, reason: "  " });
    expect(noReason).toMatchObject({ ok: false, fieldErrors: { reason: [expect.stringContaining("Reason is required")] } });
    expect(await hideCatalogTrail(admin, { trail: trail.id })).toMatchObject({ ok: false });
    expect(await hideCatalogTrail(admin, { trail: "/trails/zz/test-region/x", reason: "Valid reason here" })).toMatchObject({ ok: false, error: expect.stringContaining("page path") });
    expect(await hideCatalogTrail(admin, { trail: "/trail/zz/test-region/does-not-exist", reason: "Valid reason here" })).toMatchObject({
      ok: false,
      error: "No catalog trail has that id or path.",
    });
    expect(await hideCatalogTrail(admin, { trail: randomUUID(), reason: "Valid reason here" })).toMatchObject({ ok: false, error: "No catalog trail has that id or path." });
    const [row] = await sql()<{ hidden: boolean }[]>`select hidden from public.catalog_trails where id = ${trail.id}`;
    expect(row.hidden).toBe(false);
    expect(await auditFor(trail.id)).toEqual([]);
  });

  it("keeps a moderated trail hidden through refreshes of its tile, even when the source drops it", async () => {
    const admin = await demoUser("admin");
    const tile = freshTile();
    const c = { lng: (tile.bbox[0] + tile.bbox[2]) / 2, lat: (tile.bbox[1] + tile.bbox[3]) / 2 };
    const end = offsetMeters(c, 1200, 0);
    const providerId = `relation/${randomUUID()}`;
    const source: NormalizedTrail = {
      provider: "osm", providerId, name: "Refresh Test Route", nameEn: null, lines: [[[c.lng, c.lat], [end.lng, end.lat]]],
      routeType: "linear", sacScale: null, trailVisibility: null, surfaces: [], activities: ["hiking"], description: null,
      dogPolicy: "unknown", wheelchair: "unknown", feeRequired: null, permitRequired: null, access: null, seasonality: null,
      operator: null, website: null, tags: { route: "hiking" }, sourceName: "OpenStreetMap contributors", sourceUrl: null,
      sourceLicense: "ODbL 1.0", sourceUpdatedAt: null,
    };
    let trails: NormalizedTrail[] = [source];
    const provider: TrailDataProvider = {
      id: "osm", label: "OpenStreetMap", homepage: "https://www.openstreetmap.org", license: "ODbL 1.0", attribution: "© OpenStreetMap contributors",
      layers: ["outdoor", "services"], isEnabled: () => true, covers: () => true,
      fetchArea: async () => ({ trails, pois: [], dataTimestamp: null }),
    };
    const deps = { provider, elevation: async () => null, reverseAdmin: async () => null, timezone: () => null, concurrencyCap: 1000 };
    const makeDue = () => sql()`update public.catalog_tiles set next_refresh_at = now() - interval '1 second'
                                 where layer = 'outdoor' and provider = 'osm' and tile_key = ${tile.key}`;
    vi.stubGlobal("fetch", async () => {
      throw new Error("network access is disabled in tests");
    });
    try {
      expect(await ingestTile("outdoor", "osm", tile.key, deps)).toMatchObject({ outcome: "done", inserted: 1 });
      const [{ id }] = await sql()<{ id: string }[]>`select id from public.catalog_trails where provider = 'osm' and provider_id = ${providerId}`;
      expectOk(await hideCatalogTrail(admin, { trail: id, reason: "Closed by the landowner" }));

      await makeDue();
      expect(await ingestTile("outdoor", "osm", tile.key, deps)).toMatchObject({ outcome: "done", updated: 1 });
      const state = () => sql()<{ hidden: boolean; hiddenReason: string | null; retiredAt: Date | null }[]>`
        select hidden, hidden_reason, retired_at from public.catalog_trails where id = ${id}`;
      expect((await state())[0]).toEqual({ hidden: true, hiddenReason: "Closed by the landowner", retiredAt: null });
      expect(await getTrailDetailById(id)).toBeNull();

      trails = [];
      await makeDue();
      expect(await ingestTile("outdoor", "osm", tile.key, deps)).toMatchObject({ outcome: "done", retired: 0 });
      expect((await state())[0]).toEqual({ hidden: true, hiddenReason: "Closed by the landowner", retiredAt: null });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("parses ids, paths and page URLs", () => {
    const id = randomUUID();
    expect(parseTrailRef(id.toUpperCase())).toEqual({ id });
    expect(parseTrailRef(" /trail/US/colorado/hanging-lake/ ")).toEqual({ countryCode: "us", regionSlug: "colorado", slug: "hanging-lake" });
    expect(parseTrailRef("https://ghostguide.app/trail/ch/valais/hohenweg?x=1#top")).toEqual({ countryCode: "ch", regionSlug: "valais", slug: "hohenweg" });
    for (const bad of ["", "abc", "/trail/usa/colorado/x", "/trail/us/colorado", "/trail/us/Colo rado/x", "/trail/us/c/x/y", "ftp://x/trail/us/c/x", "/trail/us/c/%E0%A4%A"]) {
      expect(parseTrailRef(bad), bad).toBeNull();
    }
    expect(parseTrailRef(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
describe("trail data page", () => {
  it("renders every section for an admin, with retry and moderation controls", async () => {
    await insertTile({ status: "failed", attempts: 2, lastError: "Overpass: HTTP 504" });
    const hidden = await insertTrail({ hidden: true, name: "Hidden For Page Test" });
    signIn(await demoUser("admin"));
    const { default: Page } = await import("@/app/admin/data/page");
    const html = await render(await Page());
    for (const text of [
      "Trail data",
      "Providers",
      "OpenStreetMap Overpass API",
      "Nominatim: max 1 req/s, no autocomplete",
      "MET Norway: ≤ 20 req/s, must cache",
      "Estimated monthly cost",
      "$0.00",
      "Coverage and loading",
      "Recent failures (latest 20)",
      "Retry now",
      "Recently synced (latest 10)",
      "Trails by provider",
      "Newest trails",
      "Catalog jobs",
      "Moderation",
      "Hide a trail",
      "Hidden For Page Test",
    ]) {
      expect(html, text).toContain(text.replaceAll("'", "&#x27;"));
    }
    expect(html).toContain(hidden.id);
  });

  it("is in the admin menu for roles with integrations.view only", async () => {
    const { default: Layout } = await import("@/app/admin/layout");
    signIn(await demoUser("operator"));
    expect(await render(await Layout({ children: "x", params: Promise.resolve({}) } as never))).toContain('href="/admin/data"');
    signIn(await demoUser("support"));
    expect(await render(await Layout({ children: "x", params: Promise.resolve({}) } as never))).not.toContain('href="/admin/data"');
  });
});
