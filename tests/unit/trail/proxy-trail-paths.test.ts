import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { lowerCaseTrailPath, proxy } from "@/proxy";

/**
 * Mixed-case trail paths are redirected by the proxy (no database), before
 * the ISR trail page: one clean 308 with a single Location.
 */
describe("lowerCaseTrailPath", () => {
  it("lower-cases a trail path written with capitals", () => {
    expect(lowerCaseTrailPath("/trail/US/South-Carolina/Table-Rock-Trail")).toBe("/trail/us/south-carolina/table-rock-trail");
    expect(lowerCaseTrailPath("/trail/us/south-carolina/Table-Rock-Trail")).toBe("/trail/us/south-carolina/table-rock-trail");
    expect(lowerCaseTrailPath("/trail/NZ/unknown/ridge-2")).toBe("/trail/nz/unknown/ridge-2");
  });
  it.each([
    "/trail/us/south-carolina/table-rock-trail", // already canonical
    "/trail/us/south-carolina/Table_Rock", // not a trail path shape: the page answers 404
    "/trail/USA/south-carolina/table-rock-trail",
    "/trail/US/South-Carolina",
    "/trail/US/South-Carolina/Table-Rock-Trail/extra",
    "/trail/US/South-Carolina/Table%20Rock",
    "/Trail/us/south-carolina/table-rock-trail",
    "/explore",
    "/trails/Table-Rock",
  ])("leaves %s alone", (path) => {
    expect(lowerCaseTrailPath(path)).toBeNull();
  });
});

describe("proxy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers a mixed-case trail path with one permanent redirect, keeping the query", async () => {
    vi.stubEnv("AUTH_PROVIDER", "demo");
    const res = await proxy(new NextRequest("http://localhost:3000/trail/US/South-Carolina/Table-Rock-Trail?ref=share"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("http://localhost:3000/trail/us/south-carolina/table-rock-trail?ref=share");
  });

  it("passes canonical trail paths and other pages through", async () => {
    vi.stubEnv("AUTH_PROVIDER", "demo");
    for (const url of ["http://localhost:3000/trail/us/south-carolina/table-rock-trail", "http://localhost:3000/explore?q=Boulder"]) {
      const res = await proxy(new NextRequest(url));
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });
});
