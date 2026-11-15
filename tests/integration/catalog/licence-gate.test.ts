import { afterAll, describe, expect, it } from "vitest";
import { closeDb, withSystem } from "@/server/db";
import { addCommonsPhoto, addHike, addSourceRecord, expectDbError, uniq } from "./helpers";

afterAll(closeDb);

const DISALLOWED = ["CC-BY-NC-4.0", "CC-BY-ND-4.0", "CC-BY-NC-SA-4.0", "PROPRIETARY", "UNKNOWN"];

describe("licence gate", () => {
  it("the allow-list never marks an NC, ND or non-commercial licence as allowed", async () => {
    const bad = await withSystem(
      (tx) => tx`select code from public.licenses where allowed and (nc or nd or not commercial_ok)`,
    );
    expect(bad).toEqual([]);
    await expectDbError(
      withSystem((tx) => tx`
        insert into public.licenses (code, name, commercial_ok, nc, nd, share_alike, attribution_required, allowed)
        values (${`TEST-NC-${uniq()}`}, 'Sneaky NC', false, true, false, false, true, true)`),
      /licenses_allowed_means_open/,
    );
  });

  it.each(DISALLOWED)("source_records rejects %s", async (license) => {
    await expectDbError(
      withSystem((tx) => addSourceRecord(tx, { license })),
      /source_records_license_gate/,
    );
  });

  it("source_records rejects a licence code that is not on the list", async () => {
    await expectDbError(withSystem((tx) => addSourceRecord(tx, { license: "WTFPL" })), /source_records_license_gate/);
  });

  it("source_records accepts allowed licences and cannot claim license_allowed = false", async () => {
    const id = await withSystem((tx) => addSourceRecord(tx, { license: "CC-BY-4.0" }));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await expectDbError(
      withSystem((tx) => tx`update public.source_records set license_allowed = false where id = ${id}`),
      /check constraint/,
    );
  });

  it("a licence in use cannot be switched to not allowed", async () => {
    await withSystem((tx) => addSourceRecord(tx, { license: "NLOD-2.0" }));
    await expectDbError(
      withSystem((tx) => tx`update public.licenses set allowed = false where code = 'NLOD-2.0'`),
      /source_records_license_gate/,
    );
  });

  it.each(DISALLOWED)("photos reject %s", async (license) => {
    await expectDbError(
      withSystem(async (tx) => {
        const hikeId = await addHike(tx);
        await tx`
          insert into public.photos (origin, file_page_url, license_code, attribution_text, license_evidence, source_record_id, retrieved_at)
          values ('commons', 'https://commons.wikimedia.org/wiki/File:X.jpg', ${license}, 'Someone',
                  ${tx.json({ LicenseShortName: license })}, ${await addSourceRecord(tx)}, now())`;
        return hikeId;
      }),
      /photos_(photo_)?license_gate/,
    );
  });

  it("photos accept CC0/PD/CC BY/CC BY-SA but not open-data licences such as OGL or ODbL (PLAN §4.2)", async () => {
    await withSystem(async (tx) => {
      const hikeId = await addHike(tx);
      for (const license of ["CC0-1.0", "PD-USGov", "CC-BY-2.0", "CC-BY-SA-3.0"]) await addCommonsPhoto(tx, hikeId, { license });
    });
    for (const license of ["OGL-UK-3.0", "ODbL-1.0", "CITED-FACT"]) {
      await expectDbError(
        withSystem(async (tx) => {
          const hikeId = await addHike(tx);
          await tx`
            insert into public.photos (origin, file_page_url, license_code, attribution_text, license_evidence, source_record_id, retrieved_at)
            values ('government', 'https://example.gov/photo', ${license}, 'Agency', ${tx.json({ license })},
                    ${await addSourceRecord(tx, { license })}, now())`;
          return hikeId;
        }),
        /photos_photo_license_gate/,
      );
    }
  });

  it("photos need attribution; uploads need the grant licence and an ownership confirmation", async () => {
    await expectDbError(
      withSystem((tx) => tx`
        insert into public.photos (origin, file_page_url, license_code, attribution_text, license_evidence, source_record_id, retrieved_at)
        select 'commons', 'https://commons.wikimedia.org/wiki/File:Y.jpg', 'CC0-1.0', '  ', '{}'::jsonb, id, now()
        from public.source_records limit 1`),
      /photos_attribution_text_check/,
    );
    await expectDbError(
      withSystem((tx) => tx`
        insert into public.photos (origin, license_code, attribution_text, license_grant_version)
        values ('user', 'GG-USER-GRANT-1', 'Photo by a GhostGuide user', '1')`),
      /photos_uploads_have_grant/,
    );
    await expectDbError(
      withSystem((tx) => tx`
        insert into public.photos (origin, license_code, attribution_text, ownership_confirmed_at, license_grant_version)
        values ('user', 'CC-BY-4.0', 'Photo by a GhostGuide user', now(), '1')`),
      /photos_grant_license_for_uploads_only/,
    );
    await withSystem((tx) => tx`
      insert into public.photos (origin, license_code, attribution_text, ownership_confirmed_at, license_grant_version)
      values ('user', 'GG-USER-GRANT-1', 'Photo by a GhostGuide user', now(), '1')`);
  });

  it.each(DISALLOWED)("area_texts rejects %s", async (license) => {
    await expectDbError(
      withSystem(async (tx) => {
        const hikeId = await addHike(tx);
        await tx`
          insert into public.area_texts (hike_id, source, page_title, revision_id, excerpt, license_code, attribution_text, url, retrieved_at)
          values (${hikeId}, 'wikivoyage', 'Yosemite National Park', 123, 'An excerpt.', ${license},
                  'Wikivoyage contributors', 'https://en.wikivoyage.org/wiki/Yosemite_National_Park', now())`;
      }),
      /area_texts_license_gate/,
    );
  });

  it("area_texts accepts CC BY-SA excerpts", async () => {
    await withSystem(async (tx) => {
      const hikeId = await addHike(tx);
      await tx`
        insert into public.area_texts (hike_id, source, page_title, revision_id, excerpt, license_code, modified, attribution_text, url, retrieved_at)
        values (${hikeId}, 'wikivoyage', 'Yosemite National Park', 123, 'An excerpt.', 'CC-BY-SA-4.0', true,
                'Wikivoyage contributors', 'https://en.wikivoyage.org/wiki/Yosemite_National_Park', now())`;
    });
  });

  it("OSM rows must come from an ODbL source record", async () => {
    await expectDbError(
      withSystem(async (tx) => {
        const cc0 = await addSourceRecord(tx, { source: "osm", license: "CC0-1.0" });
        await tx`insert into osm.elements (osm_type, osm_id, version, source_record_id) values ('n', 1, 1, ${cc0})`;
      }),
      /elements_odbl_source/,
    );
  });
});
