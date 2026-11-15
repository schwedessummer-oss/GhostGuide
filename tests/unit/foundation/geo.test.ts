import { describe, expect, it } from "vitest";
import { haversineM, offsetMeters } from "@/domain/geo";

const origin = { lat: 47.5, lng: -121.7 };

describe("geo", () => {
  it("haversine matches known offsets", () => {
    const p = offsetMeters(origin, 0, 1000);
    expect(haversineM(origin, p)).toBeCloseTo(1000, 0);
    const q = offsetMeters(origin, 1000, 0);
    expect(haversineM(origin, q)).toBeCloseTo(1000, 0);
  });
});
