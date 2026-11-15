/**
 * Render smoke tests for every admin page and the main server actions,
 * outside Next.js: cookies carry a real signed demo session, refresh() is a
 * no-op, redirect()/notFound() are read from the thrown error digest. Pages
 * are async server components prerendered with React against the test DB.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { prerenderToNodeStream } from "react-dom/static";
import { randomUUID } from "node:crypto";
import { closeDb, withSystem } from "@/server/db";
import { signSession } from "@/server/auth/tokens";
import type { SessionUser } from "@/server/auth";
import { demoUser } from "../../helpers/db";

const jar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "gg_session" && jar.token ? { name, value: jar.token } : undefined),
    getAll: () => [],
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ refresh: () => {}, revalidatePath: () => {} }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/admin",
}));

afterAll(closeDb);
beforeEach(() => {
  jar.token = undefined;
});

function signIn(user: SessionUser) {
  jar.token = signSession(process.env.AUTH_SECRET!, { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600 });
}

async function render(el: ReactElement | ReactNode): Promise<string> {
  const { prelude } = await prerenderToNodeStream(el as ReactElement);
  let html = "";
  for await (const chunk of prelude) html += chunk.toString();
  return html.replaceAll("<!-- -->", "");
}

async function thrownDigest(p: Promise<unknown>): Promise<string> {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { digest?: string } | null;
  return err?.digest ?? `no digest: ${String(err)}`;
}

const params = <T,>(v: T) => Promise.resolve(v);
const props = (p: Record<string, string> = {}, s: Record<string, string> = {}) => ({ params: params(p), searchParams: params(s) }) as never;

function form(fields: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

describe("admin layout and access", () => {
  it("shows only the sections a role can access", async () => {
    const support = await demoUser("support");
    signIn(support);
    const { default: Layout } = await import("@/app/admin/layout");
    const html = await render(await Layout({ children: "child", params: params({}) } as never));
    expect(html).toContain("Admin menu");
    expect(html).toContain('href="/admin/support"');
    expect(html).toContain('href="/admin/customers"');
    expect(html).not.toContain('href="/admin/staff"');
    expect(html).not.toContain('href="/admin/flags"');
    expect(html).not.toContain('href="/admin/jobs"');
  });

  it("signed out: the layout leaves the redirect to the page, which keeps the deep link", async () => {
    const { default: Layout } = await import("@/app/admin/layout");
    // no redirect (and no admin chrome) from the layout itself…
    const html = await render(await Layout({ children: "child", params: params({}) } as never));
    expect(html).toBe("child");
    // …so the page's own redirect, with its own path, is the one that happens
    const { default: Flags } = await import("@/app/admin/flags/page");
    expect(await thrownDigest(Flags())).toMatch(/NEXT_REDIRECT;[^;]*;\/login\?next=%2Fadmin%2Fflags;/);
    const { default: Customer } = await import("@/app/admin/customers/[id]/page");
    const hiker = await demoUser("hiker");
    expect(await thrownDigest(Customer(props({ id: hiker.id })))).toContain(`/login?next=${encodeURIComponent(`/admin/customers/${hiker.id}`)}`);
    // signed-in customers are still refused by the layout
    signIn(hiker);
    expect(await thrownDigest(Layout({ children: "child", params: params({}) } as never))).toMatch(/NEXT_REDIRECT;.*\/forbidden/);
  });

  it("redirects customers and under-privileged staff to /forbidden, and signed-out users to login", async () => {
    const { default: Flags } = await import("@/app/admin/flags/page");
    expect(await thrownDigest(Flags())).toMatch(/NEXT_REDIRECT;.*\/login/);
    signIn(await demoUser("support"));
    expect(await thrownDigest(Flags())).toMatch(/NEXT_REDIRECT;.*\/forbidden/);
    signIn(await demoUser("hiker"));
    const { default: Overview } = await import("@/app/admin/page");
    expect(await thrownDigest(Overview())).toMatch(/NEXT_REDIRECT;.*\/forbidden/);
  });
});

describe("admin pages render for an admin", () => {
  it("overview, operations and system pages", async () => {
    const admin = await demoUser("admin");
    signIn(admin);
    const pages: [string, () => Promise<ReactElement>, string[]][] = [
      ["/admin", async () => (await import("@/app/admin/page")).default(), ["Needs attention", "Integration status", "Simulated", "dead job", "Background job runner"]],
      ["/admin/customers", async () => (await import("@/app/admin/customers/page")).default(props({}, { q: "hiker" })), ["hiker@demo.ghostguide.test"]],
      ["/admin/jobs", async () => (await import("@/app/admin/jobs/page")).default(props()), ["Run due jobs now", "Integration health", "Simulated outage (demo seed)"]],
      ["/admin/flags", async () => (await import("@/app/admin/flags/page")).default(), ["No feature flags are defined."]],
      ["/admin/support", async () => (await import("@/app/admin/support/page")).default(props()), ["I cannot sign in on my phone (demo)", "Update ticket"]],
      ["/admin/staff", async () => (await import("@/app/admin/staff/page")).default(), ["Grant a role", "Last admin — cannot be revoked"]],
      ["/admin/audit", async () => (await import("@/app/admin/audit/page")).default(props()), ["Audit log"]],
    ];
    for (const [path, page, expected] of pages) {
      const html = await render(await page());
      for (const text of expected) expect(html, `${path} should contain ${text}`).toContain(text);
    }
  });

  it("customer detail page", async () => {
    const admin = await demoUser("admin");
    signIn(admin);
    const hiker = await demoUser("hiker");
    const customerHtml = await render(await (await import("@/app/admin/customers/[id]/page")).default(props({ id: hiker.id })));
    for (const t of ["hiker@demo.ghostguide.test", "Support tickets", "Can I change the email on my account? (demo)"]) expect(customerHtml).toContain(t);

    const missing = await thrownDigest((await import("@/app/admin/customers/[id]/page")).default(props({ id: "00000000-0000-4000-8000-000000000000" })));
    expect(missing).toMatch(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });
});

describe("admin server actions (form field names)", () => {
  it("flag actions work end to end", async () => {
    const admin = await demoUser("admin");
    signIn(admin);
    const key = `test_flag_${randomUUID().slice(0, 6)}`;
    await withSystem((tx) => tx`insert into public.feature_flags (key, enabled, description) values (${key}, true, 'Test flag')`);
    try {
      const html = await render(await (await import("@/app/admin/flags/page")).default());
      expect(html).toContain(key);
      expect(html).toContain("(not read by this version of the app)");
      const { setFlagAction } = await import("@/app/admin/flags/actions");
      expect(await setFlagAction(key, false, undefined, form({}))).toMatchObject({ ok: true });
      expect(await setFlagAction(key, true, undefined, form({}))).toMatchObject({ ok: true });
    } finally {
      await withSystem((tx) => tx`delete from public.feature_flags where key = ${key}`);
    }
  });
});
