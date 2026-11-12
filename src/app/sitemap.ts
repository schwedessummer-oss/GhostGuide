import type { MetadataRoute } from "next";
import { env } from "@/config/env";
import { trailPath } from "@/domain/catalog";
import { withAnon } from "@/server/db";
import { log } from "@/server/log";

/**
 * Sitemaps: /sitemap/0.xml, /sitemap/1.xml, … (listed in robots.txt).
 *
 * Every visible catalog trail page (lastModified = when Ghost Guide last
 * synced it from its provider) in chunks of 45 000 URLs (under the 50 000
 * per-file limit), plus the home and Explore pages in the first file.
 * Reads run as `anon`, so moderated (hidden) trails never appear.
 *
 * Regenerated at most hourly. During `next build` a database error falls
 * back to the static pages only (the hourly revalidation then fills it in);
 * at runtime errors propagate, so the last good sitemap keeps being served.
 */
export const revalidate = 3600;

/** URLs per sitemap file (protocol limit: 50 000). */
const CHUNK_SIZE = 45_000;

const isBuild = () => process.env.NEXT_PHASE === "phase-production-build";

async function duringBuildOr<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isBuild()) throw err;
    log.warn("sitemap.build_fallback", { error: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}

export async function generateSitemaps(): Promise<{ id: number }[]> {
  const count = await duringBuildOr(async () => {
    const [row] = await withAnon(
      (tx) => tx<{ count: number }[]>`select count(*)::int as count from public.catalog_trails t where not t.hidden`,
    );
    return row?.count ?? 0;
  }, 0);
  const files = Math.max(1, Math.ceil(count / CHUNK_SIZE));
  return Array.from({ length: files }, (_, id) => ({ id }));
}

export default async function sitemap(props: { id: Promise<string> }): Promise<MetadataRoute.Sitemap> {
  const id = Number(await props.id);
  if (!Number.isInteger(id) || id < 0) return [];
  const base = env().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");

  type Row = { countryCode: string; regionSlug: string; slug: string; lastSyncedAt: Date };
  const rows = await duringBuildOr<Row[]>(
    () =>
      withAnon(
        async (tx) => tx<Row[]>`
          select t.country_code, t.region_slug, t.slug, t.last_synced_at
            from public.catalog_trails t
           where not t.hidden
           order by t.id
           limit ${CHUNK_SIZE}::int offset ${id * CHUNK_SIZE}::int`,
      ),
    [],
  );

  const trails: MetadataRoute.Sitemap = rows.map((r) => ({
    url: `${base}${trailPath(r)}`,
    lastModified: new Date(r.lastSyncedAt),
    changeFrequency: "monthly",
  }));
  if (id !== 0) return trails;
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/explore`, changeFrequency: "weekly", priority: 0.9 },
    ...trails,
  ];
}
