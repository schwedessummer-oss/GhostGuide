/**
 * Go-live path for the hosted database: a database built by the v0
 * migrations, with accounts and data, is archived by
 * scripts/db/archive-v0-hosted.sql and then migrated with the new
 * migrations. It must end up with the same public/osm schema as a fresh
 * database (the main test database), keep every account, and hide the
 * archive from the API roles.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { closeDb, sql as mainSql } from "@/server/db";
import { connect, migrate, MIGRATIONS_V0_DIR, recreateDatabase, ROOT } from "../../../scripts/db/lib";

const quiet = () => {};
const testUrl = new URL(process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/ghostguide_test");
const archiveUrl = new URL(testUrl.toString());
archiveUrl.pathname = `${testUrl.pathname}_v0archive`;
const ARCHIVE_SQL = readFileSync(path.join(ROOT, "scripts/db/archive-v0-hosted.sql"), "utf8");

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

let db: postgres.Sql;

beforeAll(async () => {
  await recreateDatabase(archiveUrl.toString(), quiet);
  await migrate(archiveUrl.toString(), quiet, MIGRATIONS_V0_DIR);
  db = connect(archiveUrl.toString());
  await db.unsafe(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${ALICE}', 'alice@v0.test', '{"full_name": "Alice"}'), ('${BOB}', 'bob@v0.test', '{}');
    update public.profiles set phone = '+15555550100', units = 'metric' where id = '${ALICE}';
    insert into public.staff_roles (user_id, role) values ('${ALICE}', 'admin'), ('${BOB}', 'safety');
    insert into public.regions (slug, name, center_lat, center_lng) values ('ghost-ridge', 'Ghost Ridge', 40.1, -105.2);
    insert into public.support_tickets (user_id, subject, body) values ('${BOB}', 'Help', 'Please');
    insert into public.jobs (kind) values ('checkins.sweep'), ('ops.purge_rate_limits');
  `).simple();
  await db.unsafe(ARCHIVE_SQL).simple();
  await migrate(archiveUrl.toString(), quiet);
}, 120_000);

afterAll(async () => {
  await db?.end({ timeout: 5 });
  await closeDb();
  const admin = new URL(testUrl.toString());
  admin.pathname = "/postgres";
  const a = connect(admin.toString());
  await a.unsafe(`drop database if exists ${archiveUrl.pathname.slice(1)} with (force)`);
  await a.end({ timeout: 5 });
});

/** Schema fingerprint of public + osm: columns, constraints, indexes, policies, grants, RLS, triggers. */
async function fingerprint(s: postgres.Sql): Promise<string[]> {
  const rows = await s.unsafe<{ line: string }[]>(`
    select 'col ' || table_schema || '.' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable
           || ' ' || coalesce(column_default, '') as line
    from information_schema.columns where table_schema in ('public', 'osm')
    union all
    select 'con ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
    from pg_constraint where connamespace in ('public'::regnamespace, 'osm'::regnamespace) and conrelid <> 0
    union all
    select 'idx ' || indexdef from pg_indexes where schemaname in ('public', 'osm')
    union all
    select 'pol ' || schemaname || '.' || tablename || ' ' || policyname || ' ' || cmd || ' ' || roles::text || ' '
           || coalesce(qual, '') || ' ' || coalesce(with_check, '')
    from pg_policies where schemaname in ('public', 'osm')
    union all
    select 'grant ' || table_schema || '.' || table_name || '.' || column_name || ' ' || grantee || ' ' || privilege_type
    from information_schema.column_privileges
    where table_schema in ('public', 'osm') and grantee in ('anon', 'authenticated', 'service_role')
    union all
    select 'rls ' || c.oid::regclass || ' ' || c.relrowsecurity
    from pg_class c where c.relnamespace in ('public'::regnamespace, 'osm'::regnamespace) and c.relkind in ('r', 'v')
    union all
    select 'trg ' || tgrelid::regclass || ' ' || tgname from pg_trigger
    where not tgisinternal and tgrelid in (
      select oid from pg_class where relnamespace in ('public'::regnamespace, 'osm'::regnamespace))
  `);
  return rows.map((r) => r.line).sort();
}

describe("archiving the hosted v0 database at go-live", () => {
  it("ends with the same public and osm schema as a fresh database", async () => {
    const [archived, fresh] = await Promise.all([fingerprint(db), fingerprint(mainSql())]);
    expect(archived.length).toBeGreaterThan(500);
    expect(archived.filter((l) => !fresh.includes(l))).toEqual([]);
    expect(fresh.filter((l) => !archived.includes(l))).toEqual([]);
  });

  it("keeps every account, profile and admin role", async () => {
    const users = await db`select email from auth.users order by email`;
    expect(users.map((u) => u.email)).toEqual(["alice@v0.test", "bob@v0.test"]);
    const [alice] = await db`select full_name, units from public.profiles where id = ${ALICE}`;
    expect(alice).toEqual({ full_name: "Alice", units: "metric" });
    const roles = await db`select user_id, role::text from public.staff_roles order by role`;
    expect(roles).toEqual([{ user_id: ALICE, role: "admin" }]);
  });

  it("moves v0 tables, functions and types into legacy_v0 and keeps the dropped values", async () => {
    const [counts] = await db`
      select (select count(*)::int from pg_tables where schemaname = 'legacy_v0') as legacy,
             to_regclass('public.trails') is null and to_regclass('public.catalog_trails') is null as public_free,
             to_regclass('legacy_v0.regions') is not null as regions_moved,
             to_regprocedure('legacy_v0.profile_phone(uuid)') is not null as function_moved,
             to_regtype('legacy_v0.hike_status') is not null as type_moved`;
    expect(counts).toEqual({ legacy: 50, public_free: true, regions_moved: true, function_moved: true, type_moved: true });
    expect(await db`select name from legacy_v0.regions`).toEqual([{ name: "Ghost Ridge" }]);
    expect(await db`select phone from legacy_v0.profiles_v0_columns where id = ${ALICE}`).toEqual([{ phone: "+15555550100" }]);
    expect(await db`select user_id from legacy_v0.staff_roles_safety`).toEqual([{ user_id: BOB }]);
    expect(await db`select kind, status::text from public.jobs order by kind`).toEqual([
      { kind: "checkins.sweep", status: "cancelled" },
      { kind: "ops.purge_rate_limits", status: "queued" },
    ]);
  });

  it("hides the archive from the API roles", async () => {
    const [p] = await db`
      select has_schema_privilege('anon', 'legacy_v0', 'USAGE') as anon_usage,
             has_schema_privilege('authenticated', 'legacy_v0', 'USAGE') as auth_usage,
             has_table_privilege('authenticated', 'legacy_v0.trips', 'SELECT') as auth_trips`;
    expect(p).toEqual({ anon_usage: false, auth_usage: false, auth_trips: false });
  });

  it("refuses to run twice", async () => {
    await expect(db.unsafe(ARCHIVE_SQL).simple()).rejects.toThrow(/schema "legacy_v0" already exists/);
    await db.unsafe("rollback");
    const [{ legacy }] = await db`select count(*)::int as legacy from pg_tables where schemaname = 'legacy_v0'`;
    expect(legacy).toBe(50);
  });
});
