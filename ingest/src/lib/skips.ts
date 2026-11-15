/**
 * Skip logger: records items the pipeline refused (licence not allowed,
 * excluded source, ...) in public.skipped_records, from which
 * `npm run ingest -- report-skipped` regenerates docs/skipped-sources.md.
 *
 * Identical skips are recorded once (re-runs on unchanged input add nothing).
 */
import type { Db } from "./db";
import { dataSourceId } from "./sources";

export type SkipReason =
  | "license_not_allowed"
  | "license_unknown"
  | "photo_license_not_allowed"
  | "copyright_mark"
  | "source_excluded"
  | "robots_disallowed"
  | "terms_disallow"
  | "rights_claimed"
  | "not_found"
  | "invalid_data"
  | "duplicate"
  | "other";

export interface Skip {
  /** data_sources key, e.g. "commons", "official_site". */
  source: string;
  externalId?: string | null;
  sourceUrl?: string | null;
  reason: SkipReason;
  detail?: string | null;
  /** The licence text or code exactly as found upstream. */
  licenseText?: string | null;
}

export class SkipLogger {
  /** Skips seen in this process, for the run report. */
  readonly seen: Skip[] = [];

  constructor(private readonly runId: string | null) {}

  /** Record a skip. Returns true when a new row was written. */
  async log(db: Db, skip: Skip): Promise<boolean> {
    this.seen.push(skip);
    const sourceId = await dataSourceId(db, skip.source);
    const url = skip.sourceUrl && /^https?:\/\//.test(skip.sourceUrl) ? skip.sourceUrl : null;
    const rows = await db`
      insert into public.skipped_records (data_source_id, external_id, source_url, reason, detail, license_text, ingest_run_id)
      select ${sourceId}, ${skip.externalId ?? null}, ${url}, ${skip.reason}::public.skip_reason,
             ${skip.detail ?? null}, ${skip.licenseText ?? null}, ${this.runId}
      where not exists (
        select 1 from public.skipped_records s
        where s.data_source_id = ${sourceId}
          and s.external_id is not distinct from ${skip.externalId ?? null}
          and s.source_url is not distinct from ${url}
          and s.reason = ${skip.reason}::public.skip_reason
          and s.detail is not distinct from ${skip.detail ?? null}
          and s.license_text is not distinct from ${skip.licenseText ?? null}
      )
      returning id`;
    return rows.length > 0;
  }
}
