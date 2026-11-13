import type { MetadataRoute } from "next";
import { env } from "@/config/env";
import { trailPath } from "@/domain/catalog";
import { log } from "@/server/log";
import { MAX_URLS_PER_FILE, sitemapFileCount, sitemapTrailRows, visibleTrailCount, type SitemapTrailRow } from "./sitemap-files";

/**
 * Sitemaps: /sitemap/0.xml, /sitemap/1.xml, … (listed in robots.txt).
 *
 * Every visible catalog trail page, split into files by id range (see
 * sitemap-files.ts: a trail stays in the same file as the catalog grows),
 * plus the home and Explore pages in the first file. Reads run as `anon`, so
 * moderated (hidden) trails never appear.
 *
 * No lastmod for trail pages: the catalog has no "content changed" date
 * (every refresh rewrites last_synced_at, source_updated_at and updated_at
 * even when nothing changed), and a lastmod that moves every ~30 days for
 * unchanged pages teaches search engines to ignore it. Add one only from a
 * timestamp that changes when the page's content does.
 *
 * Regenerated at most hourly. During `next build` a database error falls
 * back to the static pages only (the hourly revalidation then fills it in);
 * at runtime errors propagate, so the last good sitemap keeps being served.
 */
export const revalidate = 3600;

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

const fileCount = async () => sitemapFileCount(await duringBuildOr(() => visibleTrailCount(), 0));

export async function generateSitemaps(): Promise<{ id: number }[]> {
  return Array.from({ length: await fileCount() }, (_, id) => ({ id }));
}

const STATIC_PAGES = 2;

export default async function sitemap(props: { id: Promise<string> }): Promise<MetadataRoute.Sitemap> {
  const raw = String(await props.id);
  const id = /^\d{1,4}$/.test(raw) ? Number(raw) : -1;
  const files = await fileCount();
  if (id < 0 || id >= files) return [];
  const base = env().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");

  const limit = MAX_URLS_PER_FILE - STATIC_PAGES;
  const rows = await duringBuildOr<SitemapTrailRow[]>(() => sitemapTrailRows(id, files, limit), []);
  if (rows.length >= limit) log.warn("sitemap.file_full", { file: id, files });

  const trails: MetadataRoute.Sitemap = rows.map((r) => ({ url: `${base}${trailPath(r)}` }));
  if (id !== 0) return trails;
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/explore`, changeFrequency: "weekly", priority: 0.9 },
    ...trails,
  ];
}
