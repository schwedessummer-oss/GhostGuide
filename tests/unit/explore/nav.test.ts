import { describe, expect, it } from "vitest";
import { activeNavKey, isFullscreenRoute, primaryNav } from "@/components/site/nav";

describe("primary navigation", () => {
  it("has the four destinations; Profile goes to sign-in when signed out", () => {
    expect(primaryNav(false).map((i) => [i.label, i.href])).toEqual([
      ["Explore", "/explore"],
      ["Trips", "/trips"],
      ["Saved", "/saved"],
      ["Profile", "/login"],
    ]);
    expect(primaryNav(true).find((i) => i.key === "profile")?.href).toBe("/account");
  });

  it("highlights the destination a page belongs to", () => {
    expect(activeNavKey("/explore")).toBe("explore");
    expect(activeNavKey("/explore?bbox=1,2,3,4")).toBe("explore");
    expect(activeNavKey("/trail/us/south-carolina/table-rock-trail")).toBe("explore");
    expect(activeNavKey("/trails/echo-basin-traverse")).toBe("explore");
    expect(activeNavKey("/plan/results")).toBe("explore");
    expect(activeNavKey("/trips")).toBe("trips");
    expect(activeNavKey("/trips/abc")).toBe("trips");
    expect(activeNavKey("/trips/abc/checkout")).toBe("trips");
    expect(activeNavKey("/bookings/abc/receipt")).toBe("trips");
    expect(activeNavKey("/saved")).toBe("saved");
    expect(activeNavKey("/account")).toBe("profile");
    expect(activeNavKey("/login")).toBe("profile");
    expect(activeNavKey("/")).toBeNull();
    expect(activeNavKey("/admin")).toBeNull();
    expect(activeNavKey("/trailhead")).toBeNull();
    expect(activeNavKey(null)).toBeNull();
  });

  it("treats only Explore as a full-height app", () => {
    expect(isFullscreenRoute("/explore")).toBe(true);
    expect(isFullscreenRoute("/explore/")).toBe(true);
    expect(isFullscreenRoute("/trips")).toBe(false);
  });
});
