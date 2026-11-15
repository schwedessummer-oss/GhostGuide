import { describe, expect, it } from "vitest";
import { isCurrentPath, siteNav } from "@/components/site/nav";

describe("site navigation", () => {
  it("signed out: no header links (Sign in is rendered on its own)", () => {
    expect(siteNav({ signedIn: false, canAdmin: false })).toEqual([]);
    // Admin is never offered without a session.
    expect(siteNav({ signedIn: false, canAdmin: true })).toEqual([]);
  });

  it("signed in: Account, plus Admin for staff who may open it", () => {
    expect(siteNav({ signedIn: true, canAdmin: false }).map((l) => [l.label, l.href])).toEqual([["Account", "/account"]]);
    expect(siteNav({ signedIn: true, canAdmin: true }).map((l) => [l.label, l.href])).toEqual([
      ["Account", "/account"],
      ["Admin", "/admin"],
    ]);
  });

  it("marks the current page and the pages below it", () => {
    expect(isCurrentPath("/account", "/account")).toBe(true);
    expect(isCurrentPath("/account/", "/account")).toBe(true);
    expect(isCurrentPath("/admin/jobs?status=dead", "/admin")).toBe(true);
    expect(isCurrentPath("/accounts", "/account")).toBe(false);
    expect(isCurrentPath("/admin", "/account")).toBe(false);
    expect(isCurrentPath("/account", "/")).toBe(false);
    expect(isCurrentPath("/", "/")).toBe(true);
    expect(isCurrentPath(null, "/account")).toBe(false);
  });
});
