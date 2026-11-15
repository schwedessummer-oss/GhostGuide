import { afterAll, describe, expect, it } from "vitest";
import { closeDb, withSystem } from "@/server/db";

afterAll(closeDb);

describe("catalog schema", () => {
  it("keeps OSM tables in schema osm only", async () => {
    const rows = await withSystem((tx) => tx<{ schema: string; name: string }[]>`
      select table_schema as schema, table_name as name from information_schema.tables
      where table_name in ('elements', 'routes', 'points', 'route_metrics')
         or table_name like 'osm%' or table_name like '%osm'
      order by 1, 2`);
    expect(rows).toEqual([
      { schema: "osm", name: "elements" },
      { schema: "osm", name: "points" },
      { schema: "osm", name: "route_metrics" },
      { schema: "osm", name: "routes" },
    ]);
  });

  it("stores geometry in public only for non-OSM sources (official routes, places)", async () => {
    const rows = await withSystem((tx) => tx<{ col: string }[]>`
      select f_table_schema || '.' || f_table_name || '.' || f_geometry_column as col
      from extensions.geometry_columns where f_table_schema in ('public', 'osm') order by 1`);
    expect(rows.map((r) => r.col)).toEqual([
      "osm.elements.geom",
      "osm.points.geom",
      "osm.routes.geom",
      "osm.routes.geom_simplified",
      "public.official_routes.geom",
      "public.places.geom",
    ]);
  });

  it("only hike_routes references osm from the public schema", async () => {
    const rows = await withSystem((tx) => tx<{ name: string }[]>`
      select conrelid::regclass::text || ' -> ' || confrelid::regclass::text as name
      from pg_constraint
      where contype = 'f' and connamespace = 'public'::regnamespace
        and confrelid in (select oid from pg_class where relnamespace = 'osm'::regnamespace)`);
    expect(rows.map((r) => r.name)).toEqual(["hike_routes -> osm.routes"]);
  });

  it("enables row-level security on every public and osm table", async () => {
    const rows = await withSystem((tx) => tx<{ name: string }[]>`
      select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'osm') and c.relkind = 'r' and not c.relrowsecurity
        and c.relname <> 'spatial_ref_sys'`);
    expect(rows).toEqual([]);
  });

  it("seeds demo users including an admin, and no hikes (hikes come from the ingest pipeline)", async () => {
    const [counts] = await withSystem((tx) => tx<{ users: number; admins: number; hikes: number }[]>`
      select (select count(*)::int from auth.users where email like '%@demo.ghostguide.test') as users,
             (select count(*)::int from public.staff_roles sr join auth.users u on u.id = sr.user_id
              where sr.role = 'admin' and u.email = 'admin@demo.ghostguide.test') as admins,
             (select count(*)::int from public.hikes where slug not like 'test-%') as hikes`);
    expect(counts).toEqual({ users: 6, admins: 1, hikes: 0 });
  });
});
