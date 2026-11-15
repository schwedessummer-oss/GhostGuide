/**
 * Source-record writer: every stored value cites a public.source_records row
 * (source, URL, licence, attribution text, retrieved_at). The licence is
 * mapped by the licence mapper first; a licence we may not use is logged as a
 * skip and nothing is written. The database's licence gate (a foreign key to
 * allowed licences) remains the final check.
 *
 * Records are deduplicated on (data source, external id, content hash), the
 * table's own unique key: an unchanged upstream item maps to the same row.
 */
import { checkLicence } from "./licence";
import type { Db } from "./db";
import { sha256 } from "./http";
import type { SkipLogger } from "./skips";

/** Data source ids are stable for a database; a run uses one database, so cache them per process. */
const cache = new Map<string, { id: string; status: string }>();

async function lookupSource(db: Db, key: string): Promise<{ id: string; status: string }> {
  const hit = cache.get(key);
  if (hit) return hit;
  const [row] = await db<{ id: string; status: string }[]>`select id, status::text as status from public.data_sources where key = ${key}`;
  if (!row) throw new Error(`Unknown data source "${key}" (add it to public.data_sources in a migration first).`);
  cache.set(key, row);
  return row;
}

/** Clear the data-source id cache (tests that recreate the database). */
export function clearSourceCache(): void {
  cache.clear();
}

export async function dataSourceId(db: Db, key: string): Promise<string> {
  return (await lookupSource(db, key)).id;
}

export interface SourceRecordInput {
  /** data_sources key. */
  source: string;
  externalId: string;
  version?: string | null;
  /** Page or item title as shown upstream. */
  title?: string | null;
  sourceUrl: string;
  requestUrl?: string | null;
  /** The licence as found: one of our codes, a licence name or a licence URL. */
  licence: string;
  attributionText: string;
  retrievedAt: Date | string;
  /** Hash of the upstream content; with source and external id, the dedupe key. */
  contentHash?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  /** Path of the cached raw payload (relative to the ingest cache). */
  rawRef?: string | null;
  /** Apply the stricter photo licence list. */
  photo?: boolean;
}

export type SourceRecordResult =
  | { ok: true; id: string; licenseCode: string; created: boolean }
  | { ok: false; reason: string };

export class SourceRecordWriter {
  constructor(
    private readonly runId: string | null,
    private readonly skips: SkipLogger,
  ) {}

  async write(db: Db, input: SourceRecordInput): Promise<SourceRecordResult> {
    const source = await lookupSource(db, input.source);
    if (source.status === "skipped") {
      await this.skips.log(db, {
        source: input.source,
        externalId: input.externalId,
        sourceUrl: input.sourceUrl,
        reason: "source_excluded",
        detail: `data source ${input.source} is marked skipped`,
      });
      return { ok: false, reason: "source_excluded" };
    }
    const verdict = checkLicence(input.licence, { photo: input.photo });
    if (!verdict.ok) {
      await this.skips.log(db, {
        source: input.source,
        externalId: input.externalId,
        sourceUrl: input.sourceUrl,
        reason: verdict.reason,
        licenseText: input.licence,
        detail: verdict.code ? `licence ${verdict.code}` : null,
      });
      return { ok: false, reason: verdict.reason };
    }
    if (!input.attributionText.trim()) throw new Error(`Source record ${input.externalId} needs attribution text.`);

    const contentHash = input.contentHash ?? null;
    const retrievedAt = input.retrievedAt instanceof Date ? input.retrievedAt.toISOString() : input.retrievedAt;
    const inserted = await db<{ id: string; license_code: string }[]>`
      insert into public.source_records
        (data_source_id, external_id, version, title, source_url, request_url, license_code, attribution_text,
         retrieved_at, content_hash, etag, last_modified, raw_ref, ingest_run_id)
      values (${source.id}, ${input.externalId}, ${input.version ?? null}, ${input.title ?? null}, ${input.sourceUrl},
              ${input.requestUrl ?? null}, ${verdict.code}, ${input.attributionText}, ${retrievedAt}, ${contentHash},
              ${input.etag ?? null}, ${input.lastModified ?? null}, ${input.rawRef ?? null}, ${this.runId})
      on conflict on constraint source_records_content_unique do nothing
      returning id, license_code`;
    if (inserted.length) return { ok: true, id: inserted[0].id, licenseCode: inserted[0].license_code, created: true };
    const [existing] = await db<{ id: string; license_code: string }[]>`
      select id, license_code from public.source_records
      where data_source_id = ${source.id} and external_id = ${input.externalId}
        and content_hash is not distinct from ${contentHash}`;
    if (!existing) throw new Error(`Source record for ${input.externalId} vanished during upsert.`);
    return { ok: true, id: existing.id, licenseCode: existing.license_code, created: false };
  }
}

/**
 * A fact read on an official page (PLAN decision Q1): one record per page URL
 * and date checked, licence CITED-FACT, attribution naming the publisher and
 * the page title.
 */
export function citedPageRecord(page: {
  url: string;
  checkedAt: string;
  publisher: string;
  title?: string | null;
}): SourceRecordInput {
  return {
    source: "official_site",
    externalId: page.url,
    version: page.checkedAt,
    title: page.title ?? null,
    sourceUrl: page.url,
    licence: "CITED-FACT",
    attributionText: citedAttribution(page.publisher, page.title ?? null, page.url),
    retrievedAt: `${page.checkedAt}T00:00:00Z`,
    contentHash: sha256(`official_site|${page.url}|${page.checkedAt}`),
  };
}

export function citedAttribution(publisher: string, title: string | null, url: string): string {
  return title ? `${publisher.trim()}, "${title.trim()}"` : `${publisher.trim()}, ${url}`;
}
