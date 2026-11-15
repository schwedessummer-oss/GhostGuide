import { describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";

/*
 * While the hike catalog is rebuilt, the sitemap lists only the public pages
 * that exist (no trail or Explore URLs), and robots.txt points at it.
 */
describe("sitemap and robots", () => {
  it("lists only the home page", () => {
    expect(sitemap().map((e) => e.url)).toEqual(["http://localhost:3000/"]);
  });

  it("robots.txt names the one sitemap and keeps private areas out", () => {
    const r = robots();
    expect(r.sitemap).toBe("http://localhost:3000/sitemap.xml");
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    expect(rules).toEqual([{ userAgent: "*", allow: "/", disallow: ["/admin", "/api", "/account"] }]);
  });
});
