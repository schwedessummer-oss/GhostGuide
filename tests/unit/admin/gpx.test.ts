import { describe, expect, it } from "vitest";
import { parseGpx } from "@/server/admin/gpx";

const wrap = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1">${inner}</gpx>`;

describe("parseGpx", () => {
  it("reads track points with elevation in document order", () => {
    const r = parseGpx(
      wrap(`<trk><name>Ridge</name><trkseg>
        <trkpt lat="47.5" lon="-121.7"><ele>300.5</ele><time>2026-01-01T00:00:00Z</time></trkpt>
        <trkpt lon='-121.699' lat='47.501'><ele>305</ele></trkpt>
        <trkpt lat="47.502" lon="-121.698"><ele>-2.5</ele></trkpt>
      </trkseg></trk>`),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pointKind).toBe("trkpt");
    expect(r.hasElevation).toBe(true);
    expect(r.name).toBe("Ridge");
    expect(r.coordinates).toEqual([
      [-121.7, 47.5, 300.5],
      [-121.699, 47.501, 305],
      [-121.698, 47.502, -2.5],
    ]);
  });

  it("falls back to route points and supports self-closing points", () => {
    const r = parseGpx(wrap(`<rte><rtept lat="10" lon="20"/><rtept lat="10.001" lon="20.001" /></rte>`));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pointKind).toBe("rtept");
    expect(r.hasElevation).toBe(false);
    expect(r.coordinates).toEqual([
      [20, 10],
      [20.001, 10.001],
    ]);
  });

  it("drops elevation unless every point has it", () => {
    const r = parseGpx(wrap(`<trk><trkseg><trkpt lat="1" lon="2"><ele>5</ele></trkpt><trkpt lat="1.001" lon="2"></trkpt></trkseg></trk>`));
    expect(r.ok && r.coordinates).toEqual([
      [2, 1],
      [2, 1.001],
    ]);
  });

  it("ignores elements that merely start with the point tag name", () => {
    const r = parseGpx(wrap(`<trk><trkseg><trkptExtension lat="9" lon="9"/><trkpt lat="1" lon="2"/><trkpt lat="1.001" lon="2"/></trkseg></trk>`));
    expect(r.ok && r.coordinates.length).toBe(2);
  });

  it("rejects DOCTYPE and ENTITY declarations (no XXE surface)", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${wrap('<trk><trkseg><trkpt lat="1" lon="&xxe;"/></trkseg></trk>')}`;
    const r1 = parseGpx(xxe);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors[0]).toMatch(/DOCTYPE/);
    const r2 = parseGpx(`<gpx><!ENTITY a "b"><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1" lon="2.1"/></trkseg></trk></gpx>`);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors[0]).toMatch(/ENTITY/);
    expect(parseGpx(`<!doctype gpx>${wrap("")}`).ok).toBe(false);
  });

  it("rejects malformed documents with a clear error", () => {
    const cases: [string, RegExp][] = [
      ["", /empty/],
      ["<kml></kml>", /Not a GPX/],
      [`<gpx><trk><trkseg><trkpt lat="1" lon="2"/>`, /truncated/],
      [wrap(`<trk><trkseg><trkpt lat="1" lon="2"><ele>1</ele><trkpt lat="1.1" lon="2"></trkpt></trkseg></trk>`), /closing tag/],
      [wrap(`<trk><trkseg><trkpt lat="1"/><trkpt lat="1" lon="2"/></trkseg></trk>`), /lat\/lon/],
      [wrap(`<trk><trkseg><trkpt lat="abc" lon="2"/><trkpt lat="1" lon="2"/></trkseg></trk>`), /lat\/lon/],
      [wrap(`<trk><trkseg><trkpt lat="91" lon="2"/><trkpt lat="1" lon="2"/></trkseg></trk>`), /out of range/],
      [wrap(`<trk><trkseg><trkpt lat="1" lon="2"><ele>high</ele></trkpt><trkpt lat="1" lon="2"/></trkseg></trk>`), /elevation/],
      [wrap(`<trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk>`), /at least 2/],
      [wrap(`<trk><trkseg><trkpt lat="1" lon="2"`), /truncated|not closed|malformed/],
    ];
    for (const [xml, re] of cases) {
      const r = parseGpx(xml);
      expect(r.ok, xml).toBe(false);
      if (!r.ok) expect(r.errors.join(" "), xml).toMatch(re);
    }
  });

  it("handles large hostile input in linear time", () => {
    const many = Array.from({ length: 20000 }, () => `<trkpt lat="1" lon="2">`).join("");
    const t = Date.now();
    const r = parseGpx(wrap(`<trk><trkseg>${many}</trkseg></trk>`));
    expect(r.ok).toBe(false);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
