import { describe, expect, it } from "vitest";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SiteHeaderNav } from "@/components/site/site-header-nav";
import { TabBar } from "@/components/site/primary-nav";

/*
 * Finding #3: the header and tab bar are in the root layout, whose HTML is
 * shared by every visitor (cacheable pages). Their server render is the
 * signed-out chrome for everyone; the signed-in parts (Profile → account,
 * Sign out, Admin) come from /api/session after hydration.
 */
const render = (el: ReactElement) => renderToStaticMarkup(h(AppRouterContext.Provider, { value: {} as never }, el));
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>/g)].map((m) => m[1]);

describe("site chrome server HTML", () => {
  it("header: the five destinations, Sign in and Create an account; no Admin or Sign out", () => {
    const html = render(h(SiteHeaderNav));
    expect(hrefs(html).slice(0, 7)).toEqual(["/", "/explore", "/trips", "/hike", "/saved", "/login", "/login"]);
    expect(html).toContain(">Sign in<");
    expect(html).toContain(">Create an account<");
    expect(html).not.toContain("/admin");
    expect(html).not.toContain("Sign out");
  });

  it("tab bar: Profile signs in", () => {
    const html = render(h(TabBar));
    expect(hrefs(html)).toEqual(["/explore", "/trips", "/hike", "/saved", "/login"]);
  });
});
