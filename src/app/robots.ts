import type { MetadataRoute } from "next";
import { env } from "@/config/env";
import { generateSitemaps } from "./sitemap";

/**
 * robots.txt: everything public may be crawled; private, per-user and
 * transactional areas may not. Lists every sitemap file (see sitemap.ts).
 *
 * /login and /signup are deliberately NOT disallowed: they are noindex
 * pages, and a crawler has to fetch a page to see its noindex (a disallowed
 * URL can still be indexed from links alone). Links to them from trail pages
 * are rel=nofollow.
 */
export const revalidate = 3600;

const DISALLOW = ["/admin", "/api", "/account", "/trips", "/share", "/saved", "/checkout", "/bookings"];

export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = env().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  let ids: { id: number }[];
  try {
    ids = await generateSitemaps();
  } catch {
    // The first sitemap file always exists; list it even when the count is unavailable.
    ids = [{ id: 0 }];
  }
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: DISALLOW }],
    sitemap: ids.map(({ id }) => `${base}/sitemap/${id}.xml`),
  };
}
