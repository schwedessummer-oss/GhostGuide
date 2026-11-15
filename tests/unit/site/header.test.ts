import { describe, expect, it } from "vitest";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SiteHeaderNav } from "@/components/site/site-header-nav";
import { SiteFooter } from "@/components/site/site-footer";

/*
 * Finding #3: the header is in the root layout, whose HTML is shared by
 * every visitor (cacheable pages). Its server render is the signed-out
 * chrome for everyone; the signed-in parts (Account, Sign out, Admin) come
 * from /api/session after hydration.
 */
const render = (el: ReactElement) => renderToStaticMarkup(h(AppRouterContext.Provider, { value: {} as never }, el));
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>/g)].map((m) => m[1]);

describe("site chrome server HTML", () => {
  it("header: home, Sign in and Create an account; no Account, Admin or Sign out", () => {
    const html = render(h(SiteHeaderNav));
    expect(hrefs(html)).toEqual(["/", "/login", "/login", "/signup"]);
    expect(html).toContain(">Sign in<");
    expect(html).toContain(">Create an account<");
    expect(html).not.toContain("/admin");
    expect(html).not.toContain("/account");
    expect(html).not.toContain("Sign out");
  });

  it("footer: links only to pages that exist", () => {
    expect(hrefs(render(h(SiteFooter)))).toEqual(["/status"]);
  });
});
