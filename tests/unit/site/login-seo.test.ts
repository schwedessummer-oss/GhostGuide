import { describe, expect, it } from "vitest";

/*
 * Finding #36: pages that need sign-in send visitors to their own
 * /login?next=… URL. Those must not become N indexable copies of the
 * sign-in page: /login is noindex (and stays crawlable, so the noindex is
 * seen).
 */
describe("/login", () => {
  it("is noindex, follow", async () => {
    const { metadata } = await import("@/app/(auth)/login/page");
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it("is not disallowed in robots.txt (a disallowed page's noindex is never seen)", async () => {
    const { default: robots } = await import("@/app/robots");
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    const disallow = rules.flatMap((x) => (Array.isArray(x.disallow) ? x.disallow : x.disallow ? [x.disallow] : []));
    expect(disallow).not.toContain("/login");
    expect(disallow).not.toContain("/signup");
    expect(disallow).toEqual(expect.arrayContaining(["/admin", "/api", "/account"]));
  });
});
