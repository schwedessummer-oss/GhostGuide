/**
 * Saved catalog trails against Postgres with RLS: save / unsave /
 * idempotency, the per-user limit, owner isolation (another user can neither
 * see nor delete someone's saves, even with direct SQL as `authenticated`),
 * hidden and unknown trails, and newest-first ordering.
 *
 * Rows live around lng 30–33, lat -20 (no other test file uses this area).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withSystem, withUser } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { getTrailSummariesByIds } from "@/server/trails/read";
import { MAX_SAVED_TRAILS, isTrailSaved, listSavedTrailIds, listSavedTrails, saveTrail, unsaveTrail } from "@/server/trails/saved";
import { createCustomer } from "../../helpers/db";

afterAll(closeDb);

let seq = 0;
async function insertTrail(opts: { hidden?: boolean; name?: string } = {}): Promise<string> {
  const lng = 30 + (seq++ % 300) * 0.01;
  const lat = -20;
  const geom = JSON.stringify({
    type: "MultiLineString",
    coordinates: [
      [
        [lng, lat],
        [lng + 0.005, lat + 0.005],
      ],
    ],
  });
  const [row] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      with g as (select st_setsrid(st_geomfromgeojson(${geom}), 4326) as geom)
      insert into public.catalog_trails (provider, provider_id, name, slug, country_code, region_slug, centroid, geom,
                                         distance_m, route_type, source_name, source_license, hidden)
      select 'osm', ${`relation/${randomUUID()}`}, ${opts.name ?? "Saved Test Trail"}, ${`saved-test-${randomUUID().slice(0, 8)}`},
             'zw', 'saved-test', st_centroid(g.geom)::geography, g.geom, 700, 'linear', 'OpenStreetMap contributors', 'ODbL 1.0',
             ${opts.hidden ?? false}
        from g
      returning id`,
  );
  return row.id;
}

const setHidden = (id: string, hidden: boolean) =>
  withSystem((tx) => tx`update public.catalog_trails set hidden = ${hidden} where id = ${id}::uuid`);

/** All saved rows for a trail, bypassing RLS (ground truth). */
const savedRows = (trailId: string) =>
  withSystem((tx) => tx<{ userId: string }[]>`select user_id from public.saved_trails where trail_id = ${trailId}::uuid`);

let alice: SessionUser;
let bob: SessionUser;

beforeAll(async () => {
  alice = await createCustomer("saved-alice");
  bob = await createCustomer("saved-bob");
});

describe("saveTrail / unsaveTrail", () => {
  it("saves a visible trail once, however many times it is called", async () => {
    const trail = await insertTrail();
    expect(await isTrailSaved(alice, trail)).toBe(false);

    expect(await saveTrail(alice, trail)).toEqual({ ok: true, saved: true, alreadySaved: false });
    expect(await saveTrail(alice, trail)).toEqual({ ok: true, saved: true, alreadySaved: true });
    expect(await saveTrail(alice, trail.toUpperCase())).toEqual({ ok: true, saved: true, alreadySaved: true });

    expect(await isTrailSaved(alice, trail)).toBe(true);
    expect(await savedRows(trail)).toEqual([{ userId: alice.id }]);
  });

  it("keeps the first save date when saved again", async () => {
    const trail = await insertTrail();
    await saveTrail(alice, trail);
    const [first] = (await listSavedTrails(alice)).filter((s) => s.trailId === trail);
    await new Promise((r) => setTimeout(r, 20));
    await saveTrail(alice, trail);
    const [again] = (await listSavedTrails(alice)).filter((s) => s.trailId === trail);
    expect(again.savedAt).toBe(first.savedAt);
  });

  it("unsaves idempotently", async () => {
    const trail = await insertTrail();
    await saveTrail(alice, trail);
    expect(await unsaveTrail(alice, trail)).toBe(true);
    expect(await unsaveTrail(alice, trail)).toBe(false);
    expect(await isTrailSaved(alice, trail)).toBe(false);
    expect(await savedRows(trail)).toEqual([]);
  });

  it("answers not_found for unknown, malformed and hidden trails without writing", async () => {
    const hidden = await insertTrail({ hidden: true });
    expect(await saveTrail(alice, randomUUID())).toEqual({ ok: false, reason: "not_found" });
    expect(await saveTrail(alice, "not-a-uuid")).toEqual({ ok: false, reason: "not_found" });
    expect(await saveTrail(alice, "'; delete from public.saved_trails; --")).toEqual({ ok: false, reason: "not_found" });
    expect(await saveTrail(alice, hidden)).toEqual({ ok: false, reason: "not_found" });
    expect(await savedRows(hidden)).toEqual([]);
    expect(await unsaveTrail(alice, "nope")).toBe(false);
    expect(await isTrailSaved(alice, "nope")).toBe(false);
  });

  it("refuses to save beyond the per-user limit", async () => {
    const carol = await createCustomer("saved-carol");
    const fillers = await withSystem(
      (tx) => tx<{ id: string }[]>`select id from public.catalog_trails where not hidden limit ${MAX_SAVED_TRAILS}::int`,
    );
    // Top up with fresh trails when the catalog has fewer rows than the limit.
    const ids = fillers.map((f) => f.id);
    while (ids.length < MAX_SAVED_TRAILS) ids.push(await insertTrail());
    await withSystem((tx) => tx`insert into public.saved_trails (user_id, trail_id) select ${carol.id}::uuid, unnest(${ids}::uuid[])`);
    const extra = await insertTrail();
    expect(await saveTrail(carol, extra)).toEqual({ ok: false, reason: "limit_reached" });
    // Already-saved trails still answer saved.
    expect(await saveTrail(carol, ids[0])).toEqual({ ok: true, saved: true, alreadySaved: true });
    expect(await unsaveTrail(carol, ids[0])).toBe(true);
    expect(await saveTrail(carol, extra)).toEqual({ ok: true, saved: true, alreadySaved: false });
  });
});

describe("owner isolation (RLS)", () => {
  it("another user cannot see or delete someone's saves", async () => {
    const trail = await insertTrail();
    await saveTrail(alice, trail);

    expect(await isTrailSaved(bob, trail)).toBe(false);
    expect(await listSavedTrailIds(bob)).not.toContain(trail);
    expect(await unsaveTrail(bob, trail)).toBe(false);
    expect(await savedRows(trail)).toEqual([{ userId: alice.id }]);

    // Bob saving the same trail creates his own row and leaves Alice's alone.
    await saveTrail(bob, trail);
    await unsaveTrail(bob, trail);
    expect(await savedRows(trail)).toEqual([{ userId: alice.id }]);
  });

  it("RLS blocks direct SQL as another user (select, delete, insert for someone else)", async () => {
    const trail = await insertTrail();
    await saveTrail(alice, trail);

    const visible = await withUser(bob, (tx) => tx`select * from public.saved_trails where trail_id = ${trail}::uuid`);
    expect(visible).toHaveLength(0);
    const deleted = await withUser(bob, (tx) => tx`delete from public.saved_trails where trail_id = ${trail}::uuid returning trail_id`);
    expect(deleted).toHaveLength(0);
    await expect(
      withUser(bob, (tx) => tx`insert into public.saved_trails (user_id, trail_id) values (${alice.id}::uuid, ${trail}::uuid)`),
    ).rejects.toThrow(/row-level security|duplicate key/);
    expect(await savedRows(trail)).toEqual([{ userId: alice.id }]);
  });
});

describe("hidden after saving", () => {
  it("stays in the list (for 'No longer available') and can still be removed", async () => {
    const trail = await insertTrail({ name: "Soon Hidden" });
    await saveTrail(alice, trail);
    await setHidden(trail, true);

    expect(await isTrailSaved(alice, trail)).toBe(true);
    expect(await listSavedTrailIds(alice)).toContain(trail);
    // The public read model no longer returns it, which the /saved page shows as unavailable.
    expect(await getTrailSummariesByIds([trail])).toEqual([]);
    // Saving again is refused (not visible), but removing works.
    expect(await saveTrail(alice, trail)).toEqual({ ok: false, reason: "not_found" });
    expect(await unsaveTrail(alice, trail)).toBe(true);
    expect(await listSavedTrailIds(alice)).not.toContain(trail);
  });

  it("deleting the catalog trail removes the saved row (cascade)", async () => {
    const trail = await insertTrail();
    await saveTrail(alice, trail);
    await withSystem((tx) => tx`delete from public.catalog_trails where id = ${trail}::uuid`);
    expect(await isTrailSaved(alice, trail)).toBe(false);
  });
});

describe("listSavedTrails ordering", () => {
  it("lists newest first, ties broken by trail id", async () => {
    const dave = await createCustomer("saved-dave");
    const a = await insertTrail();
    const b = await insertTrail();
    const c = await insertTrail();
    for (const id of [a, b, c]) {
      await saveTrail(dave, id);
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(await listSavedTrailIds(dave)).toEqual([c, b, a]);

    // Same timestamp: deterministic order by trail id.
    await withSystem((tx) => tx`update public.saved_trails set created_at = '2026-01-01T00:00:00Z' where user_id = ${dave.id}::uuid`);
    expect(await listSavedTrailIds(dave)).toEqual([a, b, c].sort());

    const refs = await listSavedTrails(dave);
    expect(refs[0].savedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("summaries come back in saved order for the /saved page", async () => {
    const erin = await createCustomer("saved-erin");
    const first = await insertTrail({ name: "First Saved" });
    const second = await insertTrail({ name: "Second Saved" });
    await saveTrail(erin, first);
    await new Promise((r) => setTimeout(r, 15));
    await saveTrail(erin, second);
    const ids = await listSavedTrailIds(erin);
    const summaries = await getTrailSummariesByIds(ids);
    expect(summaries.map((s) => s.name)).toEqual(["Second Saved", "First Saved"]);
  });
});
