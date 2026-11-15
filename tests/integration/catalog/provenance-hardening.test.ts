import { afterAll, describe, expect, it } from "vitest";
import { closeDb, withSystem } from "@/server/db";
import {
  addCommonsPhoto, addFact, addHike, addOsmRoute, addOsmTrailhead, addSourceRecord, expectDbError, uniq,
} from "./helpers";

afterAll(closeDb);

describe("ODbL separation (PLAN §4.4)", () => {
  it("catalog tables reject a source record of the osm data source", async () => {
    await expectDbError(
      withSystem(async (tx) => {
        const hikeId = await addHike(tx);
        const osm = await addSourceRecord(tx, { source: "osm", license: "ODbL-1.0" });
        await addFact(tx, hikeId, "distance_km", 42.5, { sourceRecordId: osm });
      }),
      /OSM-derived values belong in schema osm/,
    );
  });

  it("catalog tables reject any ODbL-licensed source record, whatever its data source", async () => {
    await expectDbError(
      withSystem(async (tx) => {
        const record = await addSourceRecord(tx, { source: "wikidata", license: "ODbL-1.0" });
        await tx`insert into public.agencies (name, source_record_id) values ('Parks', ${record})`;
      }),
      /OSM-derived values belong in schema osm/,
    );
  });

  it("osm rows reject source records of other data sources, even when ODbL-licensed", async () => {
    await expectDbError(
      withSystem(async (tx) => {
        const record = await addSourceRecord(tx, { source: "wikidata", license: "ODbL-1.0" });
        await tx`insert into osm.elements (osm_type, osm_id, version, source_record_id) values ('n', 7, 1, ${record})`;
      }),
      /must cite source records of the osm data source/,
    );
    await expectDbError(
      withSystem(async (tx) => {
        const hikeId = await addHike(tx);
        const record = await addSourceRecord(tx, { source: "wikidata", license: "ODbL-1.0" });
        await tx`
          insert into osm.routes (hike_id, relation_ids, geom, geom_hash, built_from)
          values (${hikeId}, '{5}', extensions.st_geomfromtext('MULTILINESTRING((0 0, 1 1))', 4326), 'h', ${[record]}::uuid[])`;
      }),
      /must cite source records of the osm data source/,
    );
  });

  it("a source record's data source and licence cannot be changed", async () => {
    const id = await withSystem((tx) => addSourceRecord(tx, { source: "official_site", license: "CITED-FACT" }));
    await expectDbError(
      withSystem((tx) => tx`update public.source_records set license_code = 'CC0-1.0' where id = ${id}`),
      /immutable/,
    );
    await expectDbError(
      withSystem((tx) => tx`
        update public.source_records set data_source_id = (select id from public.data_sources where key = 'osm') where id = ${id}`),
      /immutable/,
    );
  });
});

describe("photo credit data (PLAN §4.3)", () => {
  const insertPhoto = (extra: { licenseUrl?: string | null; author?: string | null; title?: string | null; imageUrl?: string | null; status?: string; recordLicense?: string; photoLicense?: string }) =>
    withSystem(async (tx) => {
      const record = await addSourceRecord(tx, { source: "commons", license: extra.recordLicense ?? "CC-BY-4.0" });
      await tx`
        insert into public.photos (origin, file_page_url, image_url, title, author, license_url, license_code, attribution_text,
                                   license_evidence, source_record_id, retrieved_at, status)
        values ('commons', ${`https://commons.wikimedia.org/wiki/File:T_${uniq()}.jpg`}, ${extra.imageUrl === undefined ? "https://upload.wikimedia.org/t.jpg" : extra.imageUrl},
                ${extra.title === undefined ? "Title" : extra.title}, ${extra.author === undefined ? "Author" : extra.author},
                ${extra.licenseUrl === undefined ? "https://creativecommons.org/licenses/by/4.0/" : extra.licenseUrl},
                ${extra.photoLicense ?? "CC-BY-4.0"}, 'Author, CC BY 4.0', '{}'::jsonb, ${record}, now(), ${extra.status ?? "pending"}::public.photo_status)`;
    });

  it("imported photos need a title, an author or credit line, and a licence link", async () => {
    await insertPhoto({});
    await expectDbError(insertPhoto({ licenseUrl: null }), /photos_imported_have_credit/);
    await expectDbError(insertPhoto({ author: null }), /photos_imported_have_credit/);
    await expectDbError(insertPhoto({ title: null }), /photos_imported_have_credit/);
  });

  it("a published photo needs an image", async () => {
    await expectDbError(insertPhoto({ imageUrl: null, status: "published" }), /photos_published_have_image/);
    await insertPhoto({ imageUrl: null, status: "pending" });
  });

  it("a photo's licence must match its source record's licence", async () => {
    await expectDbError(insertPhoto({ recordLicense: "CC-BY-4.0", photoLicense: "CC0-1.0" }), /photos_source_license/);
  });

  it("the publish gate lists a published photo that lacks credit data", async () => {
    const hikeId = await withSystem(async (tx) => {
      const id = await addHike(tx);
      await addOsmTrailhead(tx, id);
      await addCommonsPhoto(tx, id);
      return id;
    });
    await withSystem(async (tx) => {
      // The CHECK makes this unreachable normally; drop it inside a rolled-back transaction to test the gate itself.
      await tx`alter table public.photos drop constraint photos_imported_have_credit`;
      await tx`update public.photos set license_url = null where id in (select photo_id from public.photo_links where hike_id = ${hikeId})`;
      const [r] = await tx<{ problems: string[] }[]>`select public.hike_publish_problems(${hikeId}) as problems`;
      expect(r.problems).toEqual(["every published photo needs an image, author or credit line, and a licence link"]);
      throw new Error("rollback");
    }).catch((e: Error) => {
      if (e.message !== "rollback") throw e;
    });
  });
});

describe("source records are required", () => {
  it("areas and agencies need one", async () => {
    await expectDbError(withSystem((tx) => tx`insert into public.agencies (name) values ('No source')`), /source_record_id/);
    await expectDbError(withSystem((tx) => tx`insert into public.areas (name) values ('No source')`), /source_record_id/);
  });

  it("an OSM route needs source records, and elevation values need a DEM record", async () => {
    await expectDbError(
      withSystem(async (tx) => {
        const hikeId = await addHike(tx);
        await tx`
          insert into osm.routes (hike_id, relation_ids, geom, geom_hash)
          values (${hikeId}, '{5}', extensions.st_geomfromtext('MULTILINESTRING((0 0, 1 1))', 4326), 'h')`;
      }),
      /routes_built_from_required/,
    );
    await expectDbError(
      withSystem(async (tx) => {
        const routeId = await addOsmRoute(tx, await addHike(tx));
        await tx`
          insert into osm.route_metrics (route_id, length_m, gain_m, method_version, geom_hash)
          values (${routeId}, 100, 10, 'test-1', 'hash-1')`;
      }),
      /route_metrics_dem_required/,
    );
    await withSystem(async (tx) => {
      const routeId = await addOsmRoute(tx, await addHike(tx));
      await tx`
        insert into osm.route_metrics (route_id, length_m, method_version, geom_hash) values (${routeId}, 100, 'test-1', 'hash-1')`;
    });
  });
});

describe("publish gate: published facts carry a source", () => {
  const withTrailhead = (tx: Parameters<Parameters<typeof withSystem>[0]>[0]) =>
    addHike(tx).then(async (id) => {
      await addOsmTrailhead(tx, id);
      return id;
    });
  const publish = (hikeId: string, set: string) =>
    withSystem((tx) => tx.unsafe(`update public.hikes set status = 'published', ${set} where id = '${hikeId}'`));

  it("refuses a published value with no current fact", async () => {
    const hikeId = await withSystem(withTrailhead);
    await expectDbError(publish(hikeId, "distance_km = 99.9"), /every published fact needs a current verified fact/);
    await expectDbError(publish(hikeId, "parking = 'secret parking'"), /every published fact needs/);
  });

  it("refuses a value that differs from the fact, or an unverified or superseded fact", async () => {
    const hikeId = await withSystem(async (tx) => {
      const id = await withTrailhead(tx);
      await addFact(tx, id, "distance_km", 12.5);
      await addFact(tx, id, "parking", "Lot A", { verified: false });
      return id;
    });
    await expectDbError(publish(hikeId, "distance_km = 13"), /every published fact needs/);
    await expectDbError(publish(hikeId, "parking = 'Lot A'"), /every published fact needs/);
    await withSystem((tx) => tx`update public.hike_facts set superseded_at = now() where hike_id = ${hikeId} and field = 'distance_km'`);
    await expectDbError(publish(hikeId, "distance_km = 12.5"), /every published fact needs/);
  });

  it("publishes values backed by current verified facts, and blocks later removal of that fact", async () => {
    const hikeId = await withSystem(async (tx) => {
      const id = await withTrailhead(tx);
      await addFact(tx, id, "distance_km", 12.5);
      await addFact(tx, id, "elevation_gain_m", 800);
      await addFact(tx, id, "permit_required", "yes");
      await addFact(tx, id, "best_months", [6, 7, 8]);
      return id;
    });
    await publish(hikeId, "distance_km = 12.5, elevation_gain_m = 800, permit_required = 'yes', best_months = '{6,7,8}'");
    await expectDbError(
      withSystem((tx) => tx`delete from public.hike_facts where hike_id = ${hikeId} and field = 'distance_km'`),
      /every published fact needs/,
    );
  });
});

describe("licence flags", () => {
  it("cannot be flipped on an existing licence", async () => {
    await expectDbError(
      withSystem((tx) => tx`update public.licenses set allowed = true, nc = false, commercial_ok = true where code = 'CC-BY-NC-4.0'`),
      /licence flags of CC-BY-NC-4.0 are fixed/,
    );
  });

  it("NC, ND, proprietary and unknown codes can never be allowed", async () => {
    await expectDbError(
      withSystem((tx) => tx`
        insert into public.licenses (code, name, commercial_ok, nc, nd, share_alike, attribution_required, allowed)
        values (${`CC-BY-NC-9.${uniq()}`.replace(/[^A-Za-z0-9.-]/g, "")}, 'Mislabelled', true, false, false, false, true, true)`),
      /licenses_nc_nd_unknown_not_allowed/,
    );
  });
});
