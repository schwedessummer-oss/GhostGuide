import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createAreaClaims } from "@/components/explore/area-claims";

/*
 * Finding #30: a slow place lookup or Near me result must not override a
 * newer area choice.
 */
describe("area claims: the newest area choice wins", () => {
  it("a newer claim invalidates and aborts the older one", () => {
    const claims = createAreaClaims();
    const lookup = claims.claim();
    expect(lookup.isCurrent()).toBe(true);
    expect(lookup.signal.aborted).toBe(false);
    const searchThisArea = claims.claim();
    expect(lookup.isCurrent()).toBe(false);
    expect(lookup.signal.aborted).toBe(true);
    expect(searchThisArea.isCurrent()).toBe(true);
  });

  it("release (unmount) invalidates everything", () => {
    const claims = createAreaClaims();
    const c = claims.claim();
    claims.release();
    expect(c.isCurrent()).toBe(false);
    expect(c.signal.aborted).toBe(true);
  });

  it("a late answer checked against its claim is dropped", async () => {
    const claims = createAreaClaims();
    const moves: string[] = [];
    const slowLookup = async () => {
      const claim = claims.claim();
      await new Promise((r) => setTimeout(r, 5));
      if (claim.isCurrent()) moves.push("place");
    };
    const pending = slowLookup();
    claims.claim();
    moves.push("map area");
    await pending;
    expect(moves).toEqual(["map area"]);
  });
});

describe("Explore wires every area choice through a claim", () => {
  const src = readFileSync(path.resolve(import.meta.dirname, "../../../src/components/explore/explore-app.tsx"), "utf8");
  const body = (name: string) => {
    const start = src.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n  }\n", start));
  };

  it.each(["searchThisArea", "choosePlace", "locateMe"])("%s claims the area", (name) => {
    expect(body(name)).toContain("claimArea()");
  });

  it("the place lookup checks its claim before moving the map", () => {
    const fn = body("searchPlace");
    expect(fn).toContain("const claim = claimArea()");
    expect(fn).toMatch(/if \(!claim\.isCurrent\(\)\) return;[\s\S]*goToArea\(/);
  });

  it("back/forward claims the area; the Near me button goes through locateMe", () => {
    const pop = src.slice(src.indexOf("const onPopState"), src.indexOf("useEffect(() => {\n    const handler = () => onPopState();"));
    expect(pop.match(/claimArea\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src).toContain("onClick={locateMe}");
    expect(src).not.toContain("onClick={nearMe.locate}");
  });
});
