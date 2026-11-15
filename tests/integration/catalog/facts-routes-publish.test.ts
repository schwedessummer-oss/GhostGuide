import { afterAll, describe, expect, it } from "vitest";
import { closeDb, withSystem } from "@/server/db";
import {
  addCommonsPhoto,
  addFact,
  addHike,
  addOsmRoute,
  addOsmTrailhead,
  addSourceRecord,
  expectDbError,
} from "./helpers";

afterAll(closeDb);

describe("hike_facts", () => {
  it("allows one current value per single-valued field, keeping superseded history", async () => {
    const hikeId = await withSystem(async (tx) => {
      const id = await addHike(tx);
      await addFact(tx, id, "elevation_gain_m", 1463);
      return id;
    });
    await expectDbError(
      withSystem((tx) => addFact(tx, hikeId, "elevation_gain_m", 1500)),
      /hike_facts_one_current_value/,
    );
    await withSystem(async (tx) => {
      await tx`update public.hike_facts set superseded_at = now() where hike_id = ${hikeId} and field = 'elevation_gain_m' and superseded_at is null`;
      await addFact(tx, hikeId, "elevation_gain_m", 1500);
    });
    const rows = await withSystem((tx) => tx<{ value: number; superseded: boolean }[]>`
      select value, superseded_at is not null as superseded from public.hike_facts
      where hike_id = ${hikeId} and field = 'elevation_gain_m' order by created_at`);
    expect(rows).toEqual([
      { value: 1463, superseded: true },
      { value: 1500, superseded: false },
    ]);
  });

  it("multi-valued fields (fee, permit, hazard) keep one current value per key", async () => {
    const hikeId = await withSystem(async (tx) => {
      const id = await addHike(tx);
      await addFact(tx, id, "hazard", { type: "lightning", note: "Storms most summer afternoons." }, { valueKey: "lightning" });
      await addFact(tx, id, "hazard", { type: "exposure", note: "Steep cables section." }, { valueKey: "exposure" });
      await addFact(tx, id, "fee", { amount: 35, currency: "USD", unit: "per_vehicle" }, { valueKey: "Entry|all|per_vehicle" });
      return id;
    });
    await expectDbError(
      withSystem((tx) => addFact(tx, hikeId, "hazard", { type: "lightning", note: "Again." }, { valueKey: "lightning" })),
      /hike_facts_one_current_keyed_value/,
    );
    await expectDbError(withSystem((tx) => addFact(tx, hikeId, "hazard", { type: "heat" })), /hike_facts_value_key_multi/);
    await expectDbError(
      withSystem((tx) => addFact(tx, hikeId, "parking", "Small lot", { valueKey: "x" })),
      /hike_facts_value_key_multi/,
    );
  });

  it("rejects unknown fields, badly shaped values and a licence that differs from the source record", async () => {
    await withSystem(async (tx) => {
      const id = await addHike(tx);
      await addFact(tx, id, "best_months", [5, 6, 7, 8, 9, 10]);
    });
    await expectDbError(withSystem(async (tx) => addFact(tx, await addHike(tx), "rating", 5)), /hike_facts_field_check/);
    await expectDbError(withSystem(async (tx) => addFact(tx, await addHike(tx), "distance_km", "far")), /hike_facts_value_shape/);
    await expectDbError(withSystem(async (tx) => addFact(tx, await addHike(tx), "route_type", "zigzag")), /hike_facts_value_shape/);
    await expectDbError(
      withSystem(async (tx) => {
        const id = await addHike(tx);
        const record = await addSourceRecord(tx, { license: "CITED-FACT" });
        await tx`
          insert into public.hike_facts (hike_id, field, value, method, source_record_id, license_code)
          values (${id}, 'parking', ${tx.json("Large lot")}, 'curated', ${record}, 'CC0-1.0')`;
      }),
      /hike_facts_source_license/,
    );
  });
});

describe("fees", () => {
  it("rejects unknown currencies and accepts ISO currencies with their own decimals", async () => {
    await expectDbError(
      withSystem(async (tx) => {
        const id = await addHike(tx);
        await tx`
          insert into public.fees (hike_id, amount_minor, currency, unit, source_record_id)
          values (${id}, 1000, 'XXX', 'per_person', ${await addSourceRecord(tx)})`;
      }),
      /fees_currency_fkey/,
    );
    const decimals = await withSystem(async (tx) => {
      const id = await addHike(tx);
      await tx`
        insert into public.fees (hike_id, amount_minor, currency, unit, audience, source_record_id)
        values (${id}, 4000, 'JPY', 'per_person', 'all', ${await addSourceRecord(tx)})`;
      return tx<{ code: string; minorUnit: number }[]>`
        select code, minor_unit from public.currencies where code in ('JPY', 'USD', 'JOD') order by code`;
    });
    expect(decimals).toEqual([
      { code: "JOD", minorUnit: 3 },
      { code: "JPY", minorUnit: 0 },
      { code: "USD", minorUnit: 2 },
    ]);
  });

  it("belongs to exactly one hike or permit", async () => {
    await expectDbError(
      withSystem(async (tx) => tx`
        insert into public.fees (amount_minor, currency, unit, source_record_id)
        values (1000, 'USD', 'per_person', ${await addSourceRecord(tx)})`),
      /fees_one_owner/,
    );
  });
});

describe("hike_routes", () => {
  it("links exactly one OSM or official route of the matching kind", async () => {
    const { hikeId, routeId, officialId } = await withSystem(async (tx) => {
      const id = await addHike(tx);
      const route = await addOsmRoute(tx, id, { primary: false });
      const [official] = await tx<{ id: string }[]>`
        insert into public.official_routes (name, geom, geom_hash, source_record_id)
        values ('NPS trail line', extensions.st_geomfromtext('MULTILINESTRING((-119.55 37.73, -119.53 37.74))', 4326), 'h',
                ${await addSourceRecord(tx, { source: "nps_api", license: "PD-USGov" })})
        returning id`;
      return { hikeId: id, routeId: route, officialId: official.id };
    });
    await expectDbError(
      withSystem((tx) => tx`
        insert into public.hike_routes (hike_id, kind, osm_route_id, official_route_id)
        values (${hikeId}, 'osm', ${routeId}, ${officialId})`),
      /hike_routes_exactly_one/,
    );
    await expectDbError(
      withSystem((tx) => tx`insert into public.hike_routes (hike_id, kind) values (${hikeId}, 'official')`),
      /hike_routes_exactly_one/,
    );
    await expectDbError(
      withSystem((tx) => tx`insert into public.hike_routes (hike_id, kind, official_route_id) values (${hikeId}, 'osm', ${officialId})`),
      /hike_routes_kind_matches/,
    );
    await withSystem((tx) => tx`
      insert into public.hike_routes (hike_id, kind, official_route_id, is_primary) values (${hikeId}, 'official', ${officialId}, true)`);
    await expectDbError(
      withSystem((tx) => tx`update public.hike_routes set is_primary = true where hike_id = ${hikeId} and osm_route_id = ${routeId}`),
      /hike_routes_one_primary/,
    );
  });

  it("route metrics always describe the route's current geometry", async () => {
    const routeId = await withSystem(async (tx) =>
      addOsmRoute(tx, await addHike(tx), { metrics: { lengthM: 12345, gainM: 800, highPointM: 2500 } }),
    );
    await expectDbError(
      withSystem((tx) => tx`update osm.routes set geom_hash = 'hash-2' where id = ${routeId}`),
      /route_metrics_current_geometry/,
    );
    await withSystem(async (tx) => {
      await tx`delete from osm.route_metrics where route_id = ${routeId}`;
      await tx`update osm.routes set geom_hash = 'hash-2' where id = ${routeId}`;
    });
  });
});

describe("publish gate", () => {
  const publish = (hikeId: string) => withSystem((tx) => tx`update public.hikes set status = 'published' where id = ${hikeId}`);

  it("refuses a hike without an official URL or primary country", async () => {
    const noUrl = await withSystem(async (tx) => {
      const id = await addHike(tx, { officialUrl: null });
      await addOsmTrailhead(tx, id);
      return id;
    });
    await expectDbError(publish(noUrl), /cannot be published: official_url is required/);

    const noCountry = await withSystem(async (tx) => {
      const id = await addHike(tx, { countryCode: null });
      await addOsmTrailhead(tx, id);
      return id;
    });
    await expectDbError(publish(noCountry), /country_code is required/);
  });

  it("refuses a hike with neither a primary route nor an OSM trailhead", async () => {
    const hikeId = await withSystem(async (tx) => {
      const id = await addHike(tx);
      await addOsmRoute(tx, id, { primary: false });
      return id;
    });
    await expectDbError(publish(hikeId), /a primary route or an OSM trailhead is required/);
    const status = await withSystem((tx) => tx<{ status: string }[]>`select status from public.hikes where id = ${hikeId}`);
    expect(status[0].status).toBe("draft");
  });

  it("publishes with a primary route, or with an OSM trailhead", async () => {
    const withRoute = await withSystem(async (tx) => {
      const id = await addHike(tx);
      await addOsmRoute(tx, id);
      return id;
    });
    await publish(withRoute);
    const withTrailhead = await withSystem(async (tx) => {
      const id = await addHike(tx);
      await addOsmTrailhead(tx, id);
      return id;
    });
    await publish(withTrailhead);
    const rows = await withSystem((tx) => tx<{ status: string }[]>`
      select status from public.hikes where id in (${withRoute}, ${withTrailhead})`);
    expect(rows.map((r) => r.status)).toEqual(["published", "published"]);
  });

  it("is checked at commit, so ingestion can write a hike and its route in one transaction", async () => {
    const id = await withSystem(async (tx) => {
      const hikeId = await addHike(tx, { status: "published" });
      await addOsmRoute(tx, hikeId);
      await addCommonsPhoto(tx, hikeId);
      return hikeId;
    });
    const [row] = await withSystem((tx) => tx<{ status: string }[]>`select status from public.hikes where id = ${id}`);
    expect(row.status).toBe("published");
  });

  it("a published hike cannot lose its only route or trailhead, or its official URL", async () => {
    const { hikeId, trailheadId } = await withSystem(async (tx) => {
      const id = await addHike(tx);
      const th = await addOsmTrailhead(tx, id);
      await tx`update public.hikes set status = 'published' where id = ${id}`;
      return { hikeId: id, trailheadId: th };
    });
    await expectDbError(
      withSystem((tx) => tx`delete from osm.points where id = ${trailheadId}`),
      /a primary route or an OSM trailhead is required/,
    );
    await expectDbError(
      withSystem((tx) => tx`update public.hikes set official_url = null where id = ${hikeId}`),
      /official_url is required/,
    );
    // Replacing the trailhead inside one transaction is fine.
    await withSystem(async (tx) => {
      await tx`delete from osm.points where id = ${trailheadId}`;
      await addOsmTrailhead(tx, hikeId);
    });
  });

  it("refuses to publish when a linked published photo has no allowed licence", async () => {
    // The photo licence gates make this impossible to set up through normal
    // writes; prove the gate's own check by testing its problem list directly.
    const hikeId = await withSystem(async (tx) => {
      const id = await addHike(tx);
      await addOsmTrailhead(tx, id);
      await addCommonsPhoto(tx, id);
      return id;
    });
    const [ok] = await withSystem((tx) => tx<{ problems: string[] }[]>`select public.hike_publish_problems(${hikeId}) as problems`);
    expect(ok.problems).toEqual([]);
    await withSystem(async (tx) => {
      // Superuser-only escape hatch (local test DB): skip foreign-key triggers, then roll back.
      await tx`set local session_replication_role = replica`;
      await tx`update public.photos set license_code = 'CC-BY-NC-4.0' where id in (select photo_id from public.photo_links where hike_id = ${hikeId})`;
      const [bad] = await tx<{ problems: string[] }[]>`select public.hike_publish_problems(${hikeId}) as problems`;
      expect(bad.problems).toEqual(["every published photo needs an allowed licence and attribution"]);
      throw new Error("rollback");
    }).catch((e: Error) => {
      if (e.message !== "rollback") throw e;
    });
  });
});
