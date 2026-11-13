import { describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

/*
 * Finding #36: every trail page's Save button (signed out) links to its own
 * /login?next=<trail> URL. Those must not become N indexable copies of the
 * sign-in page: the link is rel=nofollow and /login is noindex (and stays
 * crawlable, so the noindex is seen).
 */
vi.mock("@/app/saved/actions", () => ({
  getTrailSaveState: () => new Promise(() => {}),
  setTrailSaved: async () => ({ ok: false, signedIn: false }),
}));

describe("signed-out Save link", () => {
  it("is nofollow and keeps the return path", async () => {
    const { SaveTrailButton } = await import("@/components/trail/save-button");
    const path = "/trail/us/south-carolina/table-rock-trail";
    const html = renderToStaticMarkup(
      h(AppRouterContext.Provider, { value: {} as never }, h(SaveTrailButton, { trailId: "00000000-0000-4000-8000-000000000000", trailName: "Table Rock Trail", path })),
    );
    const link = html.match(/<a [^>]*>/)?.[0] ?? "";
    expect(link).toContain(`href="/login?next=${encodeURIComponent(path)}"`);
    expect(link).toContain('rel="nofollow"');
  });
});

describe("/login", () => {
  it("is noindex, follow", async () => {
    const { metadata } = await import("@/app/(auth)/login/page");
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it("is not disallowed in robots.txt (a disallowed page's noindex is never seen)", async () => {
    vi.doMock("@/app/sitemap", () => ({ generateSitemaps: async () => [{ id: 0 }] }));
    const { default: robots } = await import("@/app/robots");
    const r = await robots();
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    const disallow = rules.flatMap((x) => (Array.isArray(x.disallow) ? x.disallow : x.disallow ? [x.disallow] : []));
    expect(disallow).not.toContain("/login");
    expect(disallow).toEqual(expect.arrayContaining(["/admin", "/api", "/saved"]));
  });
});
