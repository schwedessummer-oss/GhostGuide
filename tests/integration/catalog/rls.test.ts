import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withAnon, withSystem, withUser } from "@/server/db";
import { createCustomer } from "../../helpers/db";
import { addCommonsPhoto, addFact, addHike, addOsmRoute, addPublishedHike, addSourceRecord, expectDbError } from "./helpers";

afterAll(closeDb);

let published: Awaited<ReturnType<typeof addPublishedHike>>;
let draft: { hikeId: string; factId: string; factSource: string; photoId: string; routeId: string };

beforeAll(async () => {
  published = await addPublishedHike();
  draft = await withSystem(async (tx) => {
    const hikeId = await addHike(tx);
    const factSource = await addSourceRecord(tx);
    const factId = await addFact(tx, hikeId, "parking", "Paid lot at the trailhead.", { sourceRecordId: factSource });
    const photoId = await addCommonsPhoto(tx, hikeId);
    const routeId = await addOsmRoute(tx, hikeId, { metrics: { lengthM: 5000, gainM: 300, highPointM: 900 } });
    return { hikeId, factId, factSource, photoId, routeId };
  });
});

describe("catalog row-level security", () => {
  it("anon sees published hikes but not drafts", async () => {
    const rows = await withAnon((tx) => tx<{ id: string }[]>`
      select id from public.hikes where id in (${published.hikeId}, ${draft.hikeId})`);
    expect(rows.map((r) => r.id)).toEqual([published.hikeId]);
    const all = await withAnon((tx) => tx<{ status: string }[]>`select distinct status from public.hikes`);
    expect(all.map((r) => r.status)).toEqual(["published"]);
  });

  it("anon sees a published hike's facts, fees, photos, routes and their sources; nothing of a draft", async () => {
    const seen = await withAnon(async (tx) => ({
      facts: await tx`select id from public.hike_facts where hike_id in (${published.hikeId}, ${draft.hikeId})`,
      fees: await tx`select id from public.fees where hike_id in (${published.hikeId}, ${draft.hikeId})`,
      photos: await tx`select id from public.photos where id in (${published.photoId}, ${draft.photoId})`,
      links: await tx`select photo_id from public.photo_links where hike_id in (${published.hikeId}, ${draft.hikeId})`,
      routes: await tx`select id from osm.routes where id in (${published.routeId}, ${draft.routeId})`,
      hikeRoutes: await tx`select id from public.hike_routes where hike_id in (${published.hikeId}, ${draft.hikeId})`,
      metrics: await tx`select route_id from osm.route_metrics where route_id in (${published.routeId}, ${draft.routeId})`,
      elements: await tx`select osm_id from osm.elements e where exists (
        select 1 from osm.routes r where r.id in (${published.routeId}, ${draft.routeId}) and r.relation_ids @> array[e.osm_id])`,
      sources: await tx`select id from public.source_records where id in (${published.feeSource}, ${draft.factSource})`,
    }));
    expect(seen.facts.map((r) => r.id)).toEqual([published.factId]);
    expect(seen.fees).toHaveLength(1);
    expect(seen.photos.map((r) => r.id)).toEqual([published.photoId]);
    expect(seen.links.map((r) => r.photoId)).toEqual([published.photoId]);
    expect(seen.routes.map((r) => r.id)).toEqual([published.routeId]);
    expect(seen.hikeRoutes).toHaveLength(1);
    expect(seen.metrics.map((r) => r.routeId)).toEqual([published.routeId]);
    expect(seen.elements).toHaveLength(1);
    expect(seen.sources.map((r) => r.id)).toEqual([published.feeSource]);
  });

  it("anon does not see unverified or superseded facts of a published hike", async () => {
    const { unverified, superseded } = await withSystem(async (tx) => ({
      unverified: await addFact(tx, published.hikeId, "season_note", "Best in late summer.", { verified: false }),
      superseded: await addFact(tx, published.hikeId, "nearest_town", { name: "Mariposa" }).then(async (id) => {
        await tx`update public.hike_facts set superseded_at = now() where id = ${id}`;
        return id;
      }),
    }));
    const rows = await withAnon((tx) => tx`select id from public.hike_facts where id in (${unverified}, ${superseded})`);
    expect(rows).toEqual([]);
  });

  it("reference data is public; ingest logs and internal columns are not", async () => {
    const [{ n }] = await withAnon((tx) => tx<{ n: number }[]>`select count(*)::int as n from public.licenses where allowed`);
    expect(n).toBeGreaterThan(20);
    const sources = await withAnon((tx) => tx<{ key: string }[]>`select key from public.data_sources where key = 'osm'`);
    expect(sources).toHaveLength(1);
    await expectDbError(withAnon((tx) => tx`select * from public.ingest_runs limit 1`), /permission denied/);
    await expectDbError(withAnon((tx) => tx`select * from public.skipped_records limit 1`), /permission denied/);
    await expectDbError(withAnon((tx) => tx`select raw_ref from public.source_records limit 1`), /permission denied/);
    await expectDbError(withAnon((tx) => tx`select request_url from public.source_records limit 1`), /permission denied/);
    await expectDbError(withAnon((tx) => tx`select evidence from public.hike_facts limit 1`), /permission denied/);
    await expectDbError(withAnon((tx) => tx`select uploader_user_id from public.photos limit 1`), /permission denied/);
  });

  it("anon and signed-in users cannot write catalog, provenance or osm tables", async () => {
    const customer = await createCustomer("catalog");
    const attempts: [string, (tx: Parameters<Parameters<typeof withAnon>[0]>[0]) => Promise<unknown>][] = [
      ["insert hike", (tx) => tx`insert into public.hikes (slug, name) values ('test-sneaky', 'Sneaky')`],
      ["publish draft", (tx) => tx`update public.hikes set status = 'published' where id = ${draft.hikeId}`],
      ["edit published", (tx) => tx`update public.hikes set name = 'Renamed' where id = ${published.hikeId}`],
      ["delete published", (tx) => tx`delete from public.hikes where id = ${published.hikeId}`],
      ["insert licence", (tx) => tx`insert into public.licenses (code, name, commercial_ok, nc, nd, share_alike, attribution_required, allowed) values ('X', 'X', true, false, false, false, false, true)`],
      ["insert source record", (tx) => tx`insert into public.source_records (data_source_id, external_id, source_url, license_code, attribution_text, retrieved_at) select id, 'x', 'https://x.test', 'CC0-1.0', 'x', now() from public.data_sources limit 1`],
      ["insert fact", (tx) => tx`insert into public.hike_facts (hike_id, field, value, method, source_record_id, license_code) values (${published.hikeId}, 'parking', '"x"', 'curated', ${published.feeSource}, 'CITED-FACT')`],
      ["approve photo", (tx) => tx`update public.photos set status = 'published' where id = ${draft.photoId}`],
      ["insert osm element", (tx) => tx`insert into osm.elements (osm_type, osm_id, version, source_record_id) values ('n', 42, 1, ${published.feeSource})`],
      ["edit route metrics", (tx) => tx`update osm.route_metrics set gain_m = 1 where route_id = ${published.routeId}`],
    ];
    for (const [label, attempt] of attempts) {
      await expectDbError(withAnon(attempt), /permission denied/).catch((e: Error) => {
        throw new Error(`anon ${label}: ${e.message}`);
      });
      await expectDbError(withUser(customer, attempt), /permission denied/).catch((e: Error) => {
        throw new Error(`authenticated ${label}: ${e.message}`);
      });
    }
    const [row] = await withSystem((tx) => tx<{ name: string; status: string }[]>`
      select name, status from public.hikes where id = ${published.hikeId}`);
    expect(row).toEqual({ name: "Test hike", status: "published" });
  });

  it("uploaders see their own pending photos; others do not", async () => {
    const [owner, other] = [await createCustomer("uploader"), await createCustomer("other")];
    const [photo] = await withSystem((tx) => tx<{ id: string }[]>`
      insert into public.photos (origin, license_code, attribution_text, uploader_user_id, ownership_confirmed_at, license_grant_version)
      values ('user', 'GG-USER-GRANT-1', 'Photo by Hana', ${owner.id}, now(), '1') returning id`);
    expect(await withUser(owner, (tx) => tx`select id, status from public.photos where id = ${photo.id}`)).toHaveLength(1);
    expect(await withUser(other, (tx) => tx`select id from public.photos where id = ${photo.id}`)).toHaveLength(0);
    expect(await withAnon((tx) => tx`select id from public.photos where id = ${photo.id}`)).toHaveLength(0);
  });
});

describe("hike_public view", () => {
  it("merges OSM route metrics with official facts and labels each value's source and licence", async () => {
    const { hikeId } = await withSystem(async (tx) => {
      const id = await addHike(tx);
      await addOsmRoute(tx, id, { metrics: { lengthM: 12345, gainM: 800, highPointM: 2500 } });
      await addFact(tx, id, "distance_km", 26.4);
      await tx`update public.hikes set distance_km = 26.4, distance_basis = 'round_trip', status = 'published' where id = ${id}`;
      return { hikeId: id };
    });
    const [row] = await withAnon((tx) => tx<Record<string, unknown>[]>`select * from public.hike_public where id = ${hikeId}`);
    expect(row).toMatchObject({
      distanceKm: 26.4,
      distanceBasis: "round_trip",
      distanceSource: "official_site",
      distanceLicense: "CITED-FACT",
      distanceSourceUrl: "https://example.org/page",
      elevationGainM: 800,
      elevationGainSource: "osm",
      elevationGainLicense: "ODbL-1.0",
      elevationGainDemLicense: "PD-USGov",
      highPointM: 2500,
      highPointSource: "osm",
      highPointLicense: "ODbL-1.0",
      usesOsmValues: true,
    });
  });

  it("falls back to the OSM length when there is no official distance, and hides drafts", async () => {
    const [row] = await withAnon((tx) => tx<Record<string, unknown>[]>`
      select distance_km, distance_basis, distance_source, distance_license from public.hike_public where id = ${published.hikeId}`);
    expect(row).toEqual({ distanceKm: 12.35, distanceBasis: "one_way", distanceSource: "osm", distanceLicense: "ODbL-1.0" });
    expect(await withAnon((tx) => tx`select id from public.hike_public where id = ${draft.hikeId}`)).toHaveLength(0);
    expect(await withSystem((tx) => tx`select id from public.hike_public where id = ${draft.hikeId}`)).toHaveLength(0);
  });
});
