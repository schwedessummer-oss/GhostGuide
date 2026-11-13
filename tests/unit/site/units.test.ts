import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SiteUnitsToggle, browserUnits, unitsFromCookie } from "@/components/site/units-toggle";

/*
 * The footer's units switch is in the root layout, which must not read the
 * units cookie on the server (finding #3): the browser works the choice out.
 */
describe("units in the browser", () => {
  it("reads the saved choice from the cookie", () => {
    expect(unitsFromCookie("a=1; gg_units=metric")).toBe("metric");
    expect(unitsFromCookie("gg_units=imperial; b=2")).toBe("imperial");
    expect(unitsFromCookie("gg_units=furlongs")).toBeNull();
    expect(unitsFromCookie("")).toBeNull();
  });

  it("saved choice, else what the page shows, else the browser language", () => {
    expect(browserUnits("gg_units=metric", "imperial", "en-US")).toBe("metric");
    expect(browserUnits("", "metric", "en-US")).toBe("metric");
    expect(browserUnits("", null, "en-US")).toBe("imperial");
    expect(browserUnits("", null, "de-DE")).toBe("metric");
    expect(browserUnits(null, null, null)).toBe("imperial");
  });

  it("the server HTML of the footer switch is the same for everyone (neither option checked)", () => {
    const html = renderToStaticMarkup(h(AppRouterContext.Provider, { value: {} as never }, h(SiteUnitsToggle, { size: "sm" })));
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/aria-checked="false"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-checked="true"');
  });
});
