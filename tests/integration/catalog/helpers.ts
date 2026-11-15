/**
 * Builders for catalog integration tests. Everything is written through the
 * system connection (as ingestion does). Test hikes use the slug prefix
 * "test-" so the seed check can tell them apart.
 */
import { randomUUID } from "node:crypto";
import { withSystem, type Tx } from "@/server/db";

export const uniq = () => randomUUID().slice(0, 8);

const LINE = "MULTILINESTRING((-119.5579 37.7323, -119.5400 37.7400, -119.5331 37.7459))";
const POINT = "POINT(-119.5579 37.7323)";

/** A source record from `source` (a data_sources key) under `license`. Returns its id. */
export async function addSourceRecord(tx: Tx, opts: { source?: string; license?: string } = {}): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into public.source_records (data_source_id, external_id, source_url, license_code, attribution_text, retrieved_at, content_hash)
    select id, ${`test-${uniq()}`}, 'https://example.org/page', ${opts.license ?? "CITED-FACT"}, 'Example publisher', now(), ${uniq()}
    from public.data_sources where key = ${opts.source ?? "official_site"}
    returning id`;
  if (!row) throw new Error(`unknown data source ${opts.source}`);
  return row.id;
}

/** A draft hike that has everything the publish gate needs except a route or trailhead. */
export async function addHike(
  tx: Tx,
  fields: { officialUrl?: string | null; countryCode?: string | null; status?: string } = {},
): Promise<string> {
  const officialUrl = fields.officialUrl === undefined ? "https://www.nps.gov/yose/planyourvisit/halfdome.htm" : fields.officialUrl;
  const countryCode = fields.countryCode === undefined ? "US" : fields.countryCode;
  const [row] = await tx<{ id: string }[]>`
    insert into public.hikes (slug, name, countries, country_code, official_url, status)
    values (${`test-${uniq()}`}, 'Test hike', '{US}', ${countryCode}, ${officialUrl}, ${fields.status ?? "draft"}::public.publish_status)
    returning id`;
  return row.id;
}

/** An OSM route for the hike (linked through hike_routes), with metrics computed from a DEM. */
export async function addOsmRoute(
  tx: Tx,
  hikeId: string,
  opts: { primary?: boolean; metrics?: { lengthM: number; gainM: number; highPointM: number } } = {},
): Promise<string> {
  const osmRecord = await addSourceRecord(tx, { source: "osm", license: "ODbL-1.0" });
  const relationId = Math.floor(Math.random() * 1e9) + 1;
  const [route] = await tx<{ id: string }[]>`
    insert into osm.routes (hike_id, relation_ids, geom, geom_hash, length_m, built_from)
    values (${hikeId}, ${[relationId]}::bigint[], extensions.st_geomfromtext(${LINE}, 4326), 'hash-1', 12345, ${[osmRecord]}::uuid[])
    returning id`;
  await tx`
    insert into osm.elements (osm_type, osm_id, version, tags, source_record_id)
    values ('r', ${relationId}, 3, ${tx.json({ route: "hiking" })}, ${osmRecord})`;
  await tx`
    insert into public.hike_routes (hike_id, kind, osm_route_id, is_primary)
    values (${hikeId}, 'osm', ${route.id}, ${opts.primary ?? true})`;
  if (opts.metrics) {
    const dem = await addSourceRecord(tx, { source: "aws_terrain_tiles", license: "PD-USGov" });
    await tx`
      insert into osm.route_metrics (route_id, length_m, gain_m, loss_m, high_point_m, low_point_m, dem_source_record_id, method_version, geom_hash)
      values (${route.id}, ${opts.metrics.lengthM}, ${opts.metrics.gainM}, ${opts.metrics.gainM}, ${opts.metrics.highPointM}, ${opts.metrics.highPointM - opts.metrics.gainM}, ${dem}, 'test-1', 'hash-1')`;
  }
  return route.id;
}

/** An OSM trailhead node attached to the hike. */
export async function addOsmTrailhead(tx: Tx, hikeId: string): Promise<string> {
  const osmRecord = await addSourceRecord(tx, { source: "osm", license: "ODbL-1.0" });
  const [row] = await tx<{ id: string }[]>`
    insert into osm.points (osm_type, osm_id, kind, name, geom, hike_id, distance_to_route_m, source_record_id)
    values ('n', ${Math.floor(Math.random() * 1e9) + 1}, 'trailhead', 'Happy Isles', extensions.st_geomfromtext(${POINT}, 4326), ${hikeId}, 4, ${osmRecord})
    returning id`;
  return row.id;
}

/** A current verified fact. Returns its id. */
export async function addFact(
  tx: Tx,
  hikeId: string,
  field: string,
  value: unknown,
  opts: { valueKey?: string; sourceRecordId?: string; verified?: boolean } = {},
): Promise<string> {
  const sourceRecordId = opts.sourceRecordId ?? (await addSourceRecord(tx));
  const [row] = await tx<{ id: string }[]>`
    insert into public.hike_facts (hike_id, field, value_key, value, method, source_record_id, license_code, checked_at, verified)
    select ${hikeId}, ${field}, ${opts.valueKey ?? null}, ${tx.json(value as never)}, 'curated', sr.id, sr.license_code, now(), ${opts.verified ?? true}
    from public.source_records sr where sr.id = ${sourceRecordId}
    returning id`;
  return row.id;
}

/** A Commons photo under `license`, linked to the hike (as hero when it has none yet). */
export async function addCommonsPhoto(
  tx: Tx,
  hikeId: string,
  opts: { license?: string; status?: string } = {},
): Promise<string> {
  const license = opts.license ?? "CC-BY-SA-4.0";
  const record = await addSourceRecord(tx, { source: "commons", license });
  const [photo] = await tx<{ id: string }[]>`
    insert into public.photos (origin, file_page_url, image_url, title, author, license_url, license_code, attribution_text,
                               license_evidence, source_record_id, retrieved_at, status)
    values ('commons', ${`https://commons.wikimedia.org/wiki/File:Test_${uniq()}.jpg`}, 'https://upload.wikimedia.org/test.jpg',
            'Half Dome', 'A. Photographer', 'https://creativecommons.org/licenses/test/', ${license}, ${`A. Photographer, ${license}, via Wikimedia Commons`},
            ${tx.json({ LicenseShortName: license })}, ${record}, now(), ${opts.status ?? "published"}::public.photo_status)
    returning id`;
  await tx`
    insert into public.photo_links (photo_id, hike_id, is_hero)
    select ${photo.id}, ${hikeId}, not exists (select 1 from public.photo_links where hike_id = ${hikeId} and is_hero)`;
  return photo.id;
}

/** A published hike with an OSM route (and metrics), a fact, a fee and a photo. */
export async function addPublishedHike() {
  return withSystem(async (tx) => {
    const hikeId = await addHike(tx);
    const routeId = await addOsmRoute(tx, hikeId, { metrics: { lengthM: 12345, gainM: 800, highPointM: 2500 } });
    const factId = await addFact(tx, hikeId, "permit_required", "seasonal");
    const feeSource = await addSourceRecord(tx);
    await tx`
      insert into public.fees (hike_id, name, amount_minor, currency, unit, audience, source_record_id)
      values (${hikeId}, 'Park entry', 3500, 'USD', 'per_vehicle', 'all', ${feeSource})`;
    const photoId = await addCommonsPhoto(tx, hikeId);
    await tx`update public.hikes set status = 'published', permit_required = 'seasonal' where id = ${hikeId}`;
    return { hikeId, routeId, factId, feeSource, photoId };
  });
}

/** Rejects with a message matching `pattern`. */
export async function expectDbError(p: Promise<unknown>, pattern: RegExp) {
  let error: unknown;
  try {
    await p;
  } catch (e) {
    error = e;
  }
  if (!error) throw new Error(`Expected a database error matching ${pattern}`);
  const message = error instanceof Error ? error.message : String(error);
  if (!pattern.test(message)) throw new Error(`Expected ${pattern}, got: ${message}`);
}
