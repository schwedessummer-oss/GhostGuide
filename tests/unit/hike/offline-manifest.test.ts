import { describe, expect, it } from "vitest";
import { assetItems, canonicalManifestJson, checkCompleteness, describeCompleteness, type OfflineManifest } from "@/domain/offline-manifest";

const manifest: OfflineManifest = {
  version: 1,
  generatedAt: "2026-11-05T10:00:00Z",
  items: [
    { key: "page:hike", kind: "page", url: "/trips/t/hike", label: "Hike screen" },
    { key: "page:help", kind: "page", url: "/trips/t/help", label: "Help screen" },
    { key: "data:bundle", kind: "data", url: "/api/trips/t/bundle", label: "Trip data" },
    { key: "data:geometry", kind: "data", url: "/api/trips/t/bundle", sha256: "abc", label: "Route" },
    { key: "audio:n1", kind: "audio", url: "/api/media/a.mp3", label: "Narration: Falls" },
  ],
};
const allKeys = manifest.items.map((i) => i.key);

describe("offline manifest completeness", () => {
  it("is complete when everything is present and checksums verify", () => {
    expect(checkCompleteness(manifest, allKeys, { "data:geometry": true })).toEqual({ complete: true, missing: [], corrupted: [] });
  });

  it("reports missing items", () => {
    const r = checkCompleteness(manifest, allKeys.filter((k) => k !== "page:help" && k !== "audio:n1"), { "data:geometry": true });
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(["page:help", "audio:n1"]);
    expect(describeCompleteness(r, manifest)[0]).toMatch(/2 items missing: Help screen, Narration: Falls/);
  });

  it("reports corrupted (failed or unverified) checksums", () => {
    expect(checkCompleteness(manifest, allKeys, { "data:geometry": false }).corrupted).toEqual(["data:geometry"]);
    expect(checkCompleteness(manifest, allKeys, new Map()).corrupted).toEqual(["data:geometry"]);
    // a missing item is reported as missing, not corrupted
    const r = checkCompleteness(manifest, allKeys.filter((k) => k !== "data:geometry"), { "data:geometry": false });
    expect(r).toMatchObject({ missing: ["data:geometry"], corrupted: [] });
  });

  it("an empty manifest is never complete", () => {
    expect(checkCompleteness({ items: [] }, [], {}).complete).toBe(false);
  });

  it("asset items are deduplicated and the canonical JSON is order independent", () => {
    expect(assetItems(["/_next/static/b.js", "/_next/static/a.js", "/_next/static/a.js"]).map((i) => i.key)).toEqual([
      "asset:/_next/static/a.js",
      "asset:/_next/static/b.js",
    ]);
    const shuffled = { ...manifest, generatedAt: "other", items: [...manifest.items].reverse() };
    expect(canonicalManifestJson(shuffled)).toBe(canonicalManifestJson(manifest));
  });
});
