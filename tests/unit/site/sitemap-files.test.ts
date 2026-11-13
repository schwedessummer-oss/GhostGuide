import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MAX_SITEMAP_FILES, sitemapFileCount, sitemapIdRange } from "@/app/sitemap-files";

/*
 * Finding #35: sitemap files are id ranges (stable as the catalog grows), not
 * OFFSET pages over random uuids.
 */
describe("sitemapFileCount", () => {
  it("is a power of two keeping the mean file at or under the target", () => {
    expect(sitemapFileCount(0)).toBe(1);
    expect(sitemapFileCount(25_000)).toBe(1);
    expect(sitemapFileCount(25_001)).toBe(2);
    expect(sitemapFileCount(1_000_000)).toBe(64);
    expect(sitemapFileCount(Number.NaN)).toBe(1);
    expect(sitemapFileCount(1e12)).toBe(MAX_SITEMAP_FILES);
    expect(sitemapFileCount(10, 3)).toBe(4);
  });
});

describe("sitemapIdRange", () => {
  const inRange = (id: string, r: { from: string; to: string | null }) => id >= r.from && (r.to === null || id < r.to);

  it("one file covers every id", () => {
    expect(sitemapIdRange(0, 1)).toEqual({ from: "00000000-0000-0000-0000-000000000000", to: null });
  });

  it("cuts the id space into contiguous, equal ranges", () => {
    expect(sitemapIdRange(0, 2)).toEqual({ from: "00000000-0000-0000-0000-000000000000", to: "80000000-0000-0000-0000-000000000000" });
    expect(sitemapIdRange(1, 2)).toEqual({ from: "80000000-0000-0000-0000-000000000000", to: null });
    expect(sitemapIdRange(3, 16)).toEqual({ from: "30000000-0000-0000-0000-000000000000", to: "40000000-0000-0000-0000-000000000000" });
    expect(sitemapIdRange(4095, 4096).from).toBe("fff00000-0000-0000-0000-000000000000");
    for (const n of [2, 8, 64]) {
      for (let i = 0; i + 1 < n; i++) expect(sitemapIdRange(i, n).to).toBe(sitemapIdRange(i + 1, n).from);
    }
  });

  it("puts every id in exactly one file, and a file's ids never move when other ids are added", () => {
    const ids = Array.from({ length: 2000 }, () => randomUUID());
    for (const n of [1, 4, 32]) {
      for (const id of ids) {
        const files = Array.from({ length: n }, (_, i) => i).filter((i) => inRange(id, sitemapIdRange(i, n)));
        expect(files).toHaveLength(1);
        // The file is a function of the id alone (its leading bits).
        expect(files[0]).toBe(n === 1 ? 0 : Number.parseInt(id.slice(0, 8), 16) >>> (32 - Math.log2(n)));
      }
    }
  });

  it("rejects a file that does not exist", () => {
    expect(() => sitemapIdRange(2, 2)).toThrow(RangeError);
    expect(() => sitemapIdRange(-1, 4)).toThrow(RangeError);
    expect(() => sitemapIdRange(0, 3)).toThrow(RangeError);
  });
});
