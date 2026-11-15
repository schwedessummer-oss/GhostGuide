import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isRemovedTrailPath, proxy } from "@/proxy";

/**
 * The OpenStreetMap trail pages are gone: every old /trail/... URL answers
 * 410 Gone from the proxy (no database), so search engines drop them
 * (docs/PLAN.md §2 and §12).
 */
describe("isRemovedTrailPath", () => {
  it.each([
    "/trail",
    "/trail/",
    "/trail/us/south-carolina/table-rock-trail",
    "/trail/US/South-Carolina/Table-Rock-Trail",
    "/Trail/us/south-carolina/table-rock-trail",
    "/trail/us/south-carolina",
    "/trail/us/south-carolina/table-rock-trail/extra",
  ])("matches %s", (path) => {
    expect(isRemovedTrailPath(path)).toBe(true);
  });

  it.each(["/", "/trailhead", "/trails", "/trails/x", "/explore", "/account", "/admin/trail"])("leaves %s alone", (path) => {
    expect(isRemovedTrailPath(path)).toBe(false);
  });
});

describe("proxy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers an old trail URL with 410 Gone, a noindex page and a link home", async () => {
    vi.stubEnv("AUTH_PROVIDER", "demo");
    const res = await proxy(new NextRequest("http://localhost:3000/trail/US/South-Carolina/Table-Rock-Trail?ref=share"));
    expect(res.status).toBe(410);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('href="/"');
  });

  it("passes other pages through", async () => {
    vi.stubEnv("AUTH_PROVIDER", "demo");
    for (const url of ["http://localhost:3000/", "http://localhost:3000/login?next=%2Faccount", "http://localhost:3000/trailhead"]) {
      const res = await proxy(new NextRequest(url));
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });
});
