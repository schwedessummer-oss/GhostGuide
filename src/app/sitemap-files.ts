import "server-only";
import { withAnon } from "@/server/db";

/**
 * How catalog trail URLs are split into sitemap files (see sitemap.ts).
 *
 * Files partition the trail id space by its leading bits: with N files (a
 * power of two), file k holds the visible trails whose id lies in the k-th
 * of N equal uuid ranges. Ids are random (gen_random_uuid), so the files are
 * evenly filled, and:
 *  - a trail's file depends only on its id and N, so adding, hiding or
 *    removing trails never moves OTHER trails between files (OFFSET paging
 *    over random ids did, so a crawler could see a trail twice or not at all);
 *  - each file is one primary-key range scan (no OFFSET that reads and
 *    discards every earlier row).
 * N doubles only when the catalog outgrows TARGET_URLS_PER_FILE per file; at
 * that moment files are re-cut once (and settle within one revalidation).
 */

/** Mean URLs per file N aims for: half the protocol limit, so random spread never reaches it. */
export const TARGET_URLS_PER_FILE = 25_000;
/** Protocol limit per sitemap file. */
export const MAX_URLS_PER_FILE = 50_000;
/** Upper bound on N (2^12 files ≈ 100 million trails). */
export const MAX_SITEMAP_FILES = 4096;
/** How long the visible-trail count is reused (it only picks N). */
const COUNT_TTL_MS = 10 * 60_000;

/** N: the number of sitemap files (a power of two) for `count` trails. */
export function sitemapFileCount(count: number, perFile: number = TARGET_URLS_PER_FILE): number {
  const c = Number.isFinite(count) && count > 0 ? count : 0;
  let n = 1;
  while (n < MAX_SITEMAP_FILES && c / n > perFile) n *= 2;
  return n;
}

function toUuid(n: bigint): string {
  const hex = n.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The id range of file `index` of `files` (a power of two): ids >= from and
 * (when `to` is not null) < to. Postgres orders uuids bytewise, which is the
 * order of their hex text.
 */
export function sitemapIdRange(index: number, files: number): { from: string; to: string | null } {
  const bits = Math.log2(files);
  if (!Number.isInteger(bits) || bits < 0 || bits > 12) throw new RangeError(`files must be a power of two up to ${MAX_SITEMAP_FILES}`);
  if (!Number.isInteger(index) || index < 0 || index >= files) throw new RangeError(`no sitemap file ${index} of ${files}`);
  const shift = BigInt(128 - bits);
  return {
    from: toUuid(BigInt(index) << shift),
    to: index + 1 < files ? toUuid(BigInt(index + 1) << shift) : null,
  };
}

export type SitemapTrailRow = { countryCode: string; regionSlug: string; slug: string };

/** Visible trails of sitemap file `index` of `files`, in id order (at most `limit`). */
export async function sitemapTrailRows(index: number, files: number, limit: number = MAX_URLS_PER_FILE): Promise<SitemapTrailRow[]> {
  const { from, to } = sitemapIdRange(index, files);
  return withAnon(
    (tx) => tx<SitemapTrailRow[]>`
      select t.country_code, t.region_slug, t.slug
        from public.catalog_trails t
       where not t.hidden
         and t.id >= ${from}::uuid
         ${to ? tx`and t.id < ${to}::uuid` : tx``}
       order by t.id
       limit ${Math.max(0, Math.floor(limit))}::int`,
  );
}

let counted: { value: number; at: number } | null = null;

/**
 * Visible catalog trails, reused for COUNT_TTL_MS (Next calls
 * generateSitemaps on every sitemap request, including ids that do not
 * exist, so the count must not run per request).
 */
export async function visibleTrailCount(opts: { fresh?: boolean } = {}): Promise<number> {
  const now = Date.now();
  if (!opts.fresh && counted && now - counted.at < COUNT_TTL_MS) return counted.value;
  const [row] = await withAnon((tx) => tx<{ count: number }[]>`select count(*)::int as count from public.catalog_trails t where not t.hidden`);
  counted = { value: row?.count ?? 0, at: now };
  return counted.value;
}
