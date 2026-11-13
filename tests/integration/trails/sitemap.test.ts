/**
 * Sitemaps (finding #35): files are stable id ranges (no OFFSET over random
 * uuids), hidden trails never appear, the count is not re-run per request,
 * and trail URLs carry no churning lastmod.
 *
 * Trail rows live around lng 170–175, lat -45 (no other test file uses this area).
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, withSystem, type JsonValue } from "@/server/db";
import { trailPath } from "@/domain/catalog";
import { sitemapIdRange, sitemapTrailRows, visibleTrailCount } from "@/app/sitemap-files";
import sitemap, { generateSitemaps } from "@/app/sitemap";

afterAll(closeDb);

async function insertTrail(opts: { hidden?: boolean } = {}) {
  const lng = 170 + Math.random() * 5;
  const geojson = JSON.stringify({ type: "MultiLineString", coordinates: [[[lng, -45], [lng + 0.01, -45.005]]] });
  const slug = `sitemap-${randomUUID().slice(0, 8)}`;
  const [row] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      with g as (select st_setsrid(st_geomfromgeojson(${geojson}), 4326) as geom)
      insert into public.catalog_trails (provider, provider_id, name, slug, country_code, region_slug, centroid, trailhead,
        trailhead_source, geom, distance_m, route_type, difficulty, source_name, source_license, hidden, tags)
      select 'osm', ${`way/${randomUUID()}`}, 'Sitemap Trail', ${slug}, 'nz', 'otago',
             st_centroid(g.geom)::geography, st_startpoint(st_geometryn(g.geom, 1))::geography, 'route_start',
             g.geom, 1000, 'linear', 'easy', 'OpenStreetMap', 'ODbL 1.0', ${opts.hidden ?? false},
             ${tx.json({} as JsonValue)}
        from g
      returning id`,
  );
  return { id: row.id, path: trailPath({ countryCode: "nz", regionSlug: "otago", slug }) };
}

const pathsOf = (rows: { countryCode: string; regionSlug: string; slug: string }[]) => rows.map((r) => trailPath(r));

describe("sitemap files", () => {
  it("each visible trail is in exactly the file its id range names; hidden trails in none", async () => {
    const visible = await Promise.all(Array.from({ length: 24 }, () => insertTrail()));
    const hidden = await insertTrail({ hidden: true });
    for (const files of [1, 2, 8]) {
      const all = (await Promise.all(Array.from({ length: files }, (_, i) => sitemapTrailRows(i, files)))).map(pathsOf);
      for (const t of visible) {
        const holders = all.flatMap((paths, i) => (paths.includes(t.path) ? [i] : []));
        expect(holders, `${t.path} with ${files} files`).toHaveLength(1);
        const r = sitemapIdRange(holders[0], files);
        expect(t.id >= r.from && (r.to === null || t.id < r.to)).toBe(true);
      }
      expect(all.flat()).not.toContain(hidden.path);
    }
  });

  it("adding trails never moves an existing trail to another file", async () => {
    const t = await insertTrail();
    const fileOf = async () => {
      for (let i = 0; i < 8; i++) if (pathsOf(await sitemapTrailRows(i, 8)).includes(t.path)) return i;
      return -1;
    };
    const before = await fileOf();
    await Promise.all(Array.from({ length: 20 }, () => insertTrail()));
    expect(await fileOf()).toBe(before);
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it("the visible-trail count is reused between requests", async () => {
    const first = await visibleTrailCount({ fresh: true });
    await insertTrail();
    expect(await visibleTrailCount()).toBe(first);
    expect(await visibleTrailCount({ fresh: true })).toBe(first + 1);
  });

  it("sitemap 0 lists home, Explore and trails without lastmod; unknown ids are empty", async () => {
    const t = await insertTrail();
    await visibleTrailCount({ fresh: true });
    const ids = await generateSitemaps();
    expect(ids[0]).toEqual({ id: 0 });
    const entries = (await Promise.all(ids.map(({ id }) => sitemap({ id: Promise.resolve(String(id)) })))).flat();
    const urls = entries.map((e) => new URL(e.url).pathname);
    expect(urls.slice(0, 2)).toEqual(["/", "/explore"]);
    expect(urls.filter((u) => u === t.path)).toHaveLength(1);
    for (const e of entries.filter((x) => x.url.includes("/trail/"))) expect(e.lastModified).toBeUndefined();
    for (const bad of [String(ids.length), "abc", "-1", "1.5", "99999"]) {
      expect(await sitemap({ id: Promise.resolve(bad) }), bad).toEqual([]);
    }
  });
});
