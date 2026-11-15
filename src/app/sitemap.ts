import type { MetadataRoute } from "next";
import { env } from "@/config/env";

/**
 * /sitemap.xml: the public pages worth indexing. While the hike catalog is
 * being rebuilt that is only the home page (sign-in pages are noindex;
 * account and admin pages are private). Hike pages join this list when the
 * curated catalog is published (docs/PLAN.md, Phase 7).
 */
const PUBLIC_PAGES = ["/"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const base = env().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  return PUBLIC_PAGES.map((p) => ({ url: `${base}${p}` }));
}
