import type { MetadataRoute } from "next";
import { env } from "@/config/env";

/**
 * robots.txt: everything public may be crawled; private and per-user areas
 * may not. Lists the sitemap (sitemap.ts).
 *
 * /login and /signup are deliberately NOT disallowed: they are noindex
 * pages, and a crawler has to fetch a page to see its noindex (a disallowed
 * URL can still be indexed from links alone).
 */
const DISALLOW = ["/admin", "/api", "/account"];

export default function robots(): MetadataRoute.Robots {
  const base = env().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: DISALLOW }],
    sitemap: `${base}/sitemap.xml`,
  };
}
