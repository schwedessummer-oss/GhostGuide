/**
 * Render smoke tests for every admin page and the main server actions,
 * outside Next.js: cookies carry a real signed demo session, refresh() is a
 * no-op, redirect()/notFound() are read from the thrown error digest. Pages
 * are async server components prerendered with React against the test DB.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { prerenderToNodeStream } from "react-dom/static";
import { closeDb, sql, withSystem } from "@/server/db";
import { signSession } from "@/server/auth/tokens";
import type { SessionUser } from "@/server/auth";
import { createNarration } from "@/server/admin/content";
import { createCustomer, demoUser, trailBySlug } from "../../helpers/db";
import { bookedTrip, consentedContact, optIn } from "../safety/helpers";

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
    expect(html).toContain('href="/admin/bookings"');
    expect(html).not.toContain('href="/admin/pricing"');
    expect(html).not.toContain('href="/admin/flags"');
    expect(html).not.toContain('href="/admin/safety"');
  });

  it("signed out: the layout leaves the redirect to the page, which keeps the deep link", async () => {
    const { default: Layout } = await import("@/app/admin/layout");
    // no redirect (and no admin chrome) from the layout itself…
    const html = await render(await Layout({ children: "child", params: params({}) } as never));
    expect(html).toBe("child");
    // …so the page's own redirect, with its own path, is the one that happens
    const { default: Pricing } = await import("@/app/admin/pricing/page");
    expect(await thrownDigest(Pricing())).toMatch(/NEXT_REDIRECT;[^;]*;\/login\?next=%2Fadmin%2Fpricing;/);
    const { default: Closures } = await import("@/app/admin/trails/[id]/closures/page");
    const trail = await trailBySlug("lantern-creek-loop");
    expect(await thrownDigest(Closures(props({ id: trail.id })))).toContain(`/login?next=${encodeURIComponent(`/admin/trails/${trail.id}/closures`)}`);
    // signed-in customers are still refused by the layout
    signIn(await demoUser("hiker"));
    expect(await thrownDigest(Layout({ children: "child", params: params({}) } as never))).toMatch(/NEXT_REDIRECT;.*\/forbidden/);
  });

  it("redirects customers and under-privileged staff to /forbidden, and signed-out users to login", async () => {
    const { default: Pricing } = await import("@/app/admin/pricing/page");
    expect(await thrownDigest(Pricing())).toMatch(/NEXT_REDIRECT;.*\/login/);
    signIn(await demoUser("support"));
    expect(await thrownDigest(Pricing())).toMatch(/NEXT_REDIRECT;.*\/forbidden/);
    signIn(await demoUser("hiker"));
    const { default: Overview } = await import("@/app/admin/page");
    expect(await thrownDigest(Overview())).toMatch(/NEXT_REDIRECT;.*\/forbidden/);
  });
});

describe("safety monitor page", () => {
  it("shows an overdue check-in in the trail's zone with a readable timeline and the staff follow-up form", async () => {
    const hiker = await createCustomer("safety-page");
    const trip = await bookedTrip(hiker, { status: "active" });
    const c = await optIn(hiker, trip.id, await consentedContact(hiker), { minutesAhead: 90 });
    await withSystem((tx) => tx`update public.trip_checkins set status = 'overdue', overdue_at = now() where id = ${c.id}`);
    signIn(await demoUser("safety"));
    const { default: Safety } = await import("@/app/admin/safety/page");
    const html = await render(await Safety());
    expect(html).toContain("Times are shown in the trail&#x27;s local time zone");
    expect(html).toMatch(/Expected back <time[^>]*>[^<]*\b(PST|PDT)\b/);
    expect(html).toContain("Check-ins turned on");
    expect(html).toContain("Record a staff follow-up");
    expect(html).toContain("never contacts emergency services or search and rescue");
    expect(html).toContain('value="hiker_confirmed_safe"');
    expect(html).toContain('value="note_only"');
    expect(html).not.toMatch(/opted_in|clientEventId/);
  });
});

describe("admin pages render for an admin", () => {
  it("overview, catalog and operations pages", async () => {
    const admin = await demoUser("admin");
    signIn(admin);
    const trail = await trailBySlug("lantern-creek-loop");
    const echo = await trailBySlug("echo-basin-traverse");
    const pages: [string, () => Promise<ReactElement>, string[]][] = [
      ["/admin", async () => (await import("@/app/admin/page")).default(), ["Needs attention", "Integration status", "Simulated", "dead job", "Background job runner"]],
      ["/admin/trails", async () => (await import("@/app/admin/trails/page")).default(props()), ["Lantern Creek Loop", "Cinder Spur", "No validated route"]],
      ["/admin/trails/new", async () => (await import("@/app/admin/trails/new/page")).default(), ["New draft trail", 'name="distanceKm"']],
      ["/admin/trails/[id]", async () => (await import("@/app/admin/trails/[id]/page")).default(props({ id: trail.id })), ["Facts and provenance", "Distance (km)", "Unpublish"]],
      ["/admin/trails/[id]/geometry", async () => (await import("@/app/admin/trails/[id]/geometry/page")).default(props({ id: trail.id })), ["Active geometry", "Upload and validate", "SHA-256"]],
      ["/admin/trails/[id]/sources", async () => (await import("@/app/admin/trails/[id]/sources/page")).default(props({ id: trail.id })), ["Sources linked to this trail", "Ghost Guide demonstration content"]],
      ["/admin/trails/[id]/closures", async () => (await import("@/app/admin/trails/[id]/closures/page")).default(props({ id: trail.id })), ["Add a closure or notice", 'type="datetime-local"']],
      ["/admin/trails/[id]/pois", async () => (await import("@/app/admin/trails/[id]/pois/page")).default(props({ id: trail.id })), ["Points of interest", "Mossy Footbridge", "m from route"]],
      ["/admin/trails/[id]/permits", async () => (await import("@/app/admin/trails/[id]/permits/page")).default(props({ id: echo.id })), ["Echo Basin day-use permit", "never automates permit"]],
      ["/admin/content", async () => (await import("@/app/admin/content/page")).default(props()), ["Narration review", "Creek insects (draft)"]],
      ["/admin/customers", async () => (await import("@/app/admin/customers/page")).default(props({}, { q: "hiker" })), ["hiker@demo.ghostguide.test"]],
      ["/admin/bookings", async () => (await import("@/app/admin/bookings/page")).default(props()), ["Echo Basin Traverse", "Simulated"]],
      ["/admin/gear", async () => (await import("@/app/admin/gear/page")).default(props()), ["Lantern Creek Locker Bank", "Simulated partner", "Daypack #6"]],
      ["/admin/fulfillment", async () => (await import("@/app/admin/fulfillment/page")).default(props()), ["Partner fulfillment", "staff cannot confirm on their behalf"]],
      ["/admin/safety", async () => (await import("@/app/admin/safety/page")).default(), ["It is not proof of an emergency", "does not contact emergency services automatically", "Active hikes"]],
      ["/admin/notifications", async () => (await import("@/app/admin/notifications/page")).default(props({}, { status: "failed" })), ["Notification delivery log"]],
      ["/admin/jobs", async () => (await import("@/app/admin/jobs/page")).default(props()), ["Run due jobs now", "Integration health", "Failed webhook deliveries", "evt_demo_admin_seed_failed"]],
      ["/admin/pricing", async () => (await import("@/app/admin/pricing/page")).default(), ["Live preview", "Weekend surcharge", "Trail base prices", "Add an add-on", "Daily capacity (units per day)", "Pricing unit", "Offered in"]],
      ["/admin/availability", async () => (await import("@/app/admin/availability/page")).default(props({}, { trail: trail.id })), ["Capacity", "Remaining", "(today)"]],
      ["/admin/flags", async () => (await import("@/app/admin/flags/page")).default(), ["checkout_enabled", "marketing_drafts"]],
      ["/admin/marketing", async () => (await import("@/app/admin/marketing/page")).default(props()), ["Generate a draft", "no AI"]],
      ["/admin/permits", async () => (await import("@/app/admin/permits/page")).default(props()), ["No permit bots", "Echo Basin Traverse", "Queue reminder run now"]],
      ["/admin/support", async () => (await import("@/app/admin/support/page")).default(props()), ["Do I need one permit per person? (demo)", "Update ticket"]],
      ["/admin/staff", async () => (await import("@/app/admin/staff/page")).default(), ["Grant a role", "Last admin — cannot be revoked"]],
      ["/admin/audit", async () => (await import("@/app/admin/audit/page")).default(props()), ["Audit log"]],
    ];
    for (const [path, page, expected] of pages) {
      const html = await render(await page());
      for (const text of expected) expect(html, `${path} should contain ${text}`).toContain(text);
    }
  });

  it("booking, customer, narration and marketing detail pages", async () => {
    const admin = await demoUser("admin");
    signIn(admin);
    const [booking] = await sql()<{ id: string }[]>`select id from public.bookings where receipt_number = 'GG-DEMO-ADMIN-0001'`;
    const bookingHtml = await render(await (await import("@/app/admin/bookings/[id]/page")).default(props({ id: booking.id })));
    for (const t of ["Price breakdown", "Payments and refunds", "Cancel booking", "Refund an amount", "Simulated payment"]) expect(bookingHtml).toContain(t);

    const hiker = await demoUser("hiker");
    const customerHtml = await render(await (await import("@/app/admin/customers/[id]/page")).default(props({ id: hiker.id })));
    expect(customerHtml).toContain("Show restricted details");

    const trail = await trailBySlug("whisper-falls");
    const created = await createNarration(admin, trail.id, { title: "Imported text", transcript: '<script>alert("x")</script> Imported narration text.', poiId: "", sourceId: "", sourceCitation: "", submit: true });
    if (!created.ok) throw new Error(created.error);
    const narrationHtml = await render(await (await import("@/app/admin/content/[id]/page")).default(props({ id: created.data!.id })));
    expect(narrationHtml).toContain("&lt;script&gt;");
    expect(narrationHtml).not.toContain('<script>alert("x")</script>');
    expect(narrationHtml).toContain("Approve narration");

    const { generateDraftAction } = await import("@/app/admin/marketing/actions");
    const digest = await thrownDigest(generateDraftAction(undefined, form({ trailId: trail.id, channel: "web" })));
    const draftId = /\/admin\/marketing\/([0-9a-f-]{36})/.exec(digest)?.[1];
    expect(draftId).toBeDefined();
    const draftHtml = await render(await (await import("@/app/admin/marketing/[id]/page")).default(props({ id: draftId! }, { generated: "1" })));
    for (const t of ["Freshness and honesty warnings", "Simulated weather", "Sources used", "Submit for review"]) expect(draftHtml).toContain(t);

    const missing = await thrownDigest((await import("@/app/admin/bookings/[id]/page")).default(props({ id: "00000000-0000-4000-8000-000000000000" })));
    expect(missing).toMatch(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("support staff see restricted placeholders instead of contacts and payments", async () => {
    const support = await demoUser("support");
    signIn(support);
    const hiker = await demoUser("hiker");
    const html = await render(await (await import("@/app/admin/customers/[id]/page")).default(props({ id: hiker.id })));
    expect(html).toContain("Restricted");
    expect(html).not.toContain("Show restricted details");
    expect(html).not.toContain("Casey Contact");
    const [booking] = await sql()<{ id: string }[]>`select id from public.bookings where receipt_number = 'GG-DEMO-ADMIN-0001'`;
    const bHtml = await render(await (await import("@/app/admin/bookings/[id]/page")).default(props({ id: booking.id })));
    expect(bHtml).toContain("payments and refunds are visible to operators and admins");
    expect(bHtml).not.toContain("Refund an amount");
    expect(bHtml).not.toContain("Cancel booking");
  });
});

describe("admin server actions (form field names)", () => {
  it("closure, flag, role and reveal actions work end to end", async () => {
    const admin = await demoUser("admin");
    signIn(admin);
    const trail = await trailBySlug("miners-meadow-loop");
    const { createClosureAction, endClosureAction } = await import("@/app/admin/trails/actions");
    const r = await createClosureAction(trail.id, undefined, form({ severity: "partial", reason: "Bridge inspection (test)", sourceId: "", startsAt: "", endsAt: "" }));
    expect(r).toMatchObject({ ok: true });
    const [c] = await sql()<{ id: string }[]>`select id from public.trail_closures where trail_id = ${trail.id} and reason = 'Bridge inspection (test)'`;
    expect(await endClosureAction(trail.id, c.id, undefined, form({}))).toMatchObject({ ok: true });

    const { setFlagAction } = await import("@/app/admin/flags/actions");
    expect(await setFlagAction("addon_meal_pack", false, undefined, form({}))).toMatchObject({ ok: true });
    expect(await setFlagAction("addon_meal_pack", true, undefined, form({}))).toMatchObject({ ok: true });

    const { revealCustomerAction } = await import("@/app/admin/customers/actions");
    const hiker = await demoUser("hiker");
    expect(await revealCustomerAction(hiker.id, undefined, form({ reason: "" }))).toMatchObject({ ok: false });
    const rev = await revealCustomerAction(hiker.id, undefined, form({ reason: "Support call about check-in contact" }));
    expect(rev).toMatchObject({ ok: true, data: { contacts: [expect.objectContaining({ name: "Casey Contact (demo)" })] } });
    const [a] = await sql()<{ action: string }[]>`
      select action from public.audit_logs where entity_id = ${hiker.id} and action = 'customer.view_emergency_contacts' order by id desc limit 1`;
    expect(a.action).toBe("customer.view_emergency_contacts");

    // a support user calling the reveal action is turned away (redirect to /forbidden)
    signIn(await demoUser("support"));
    expect(await thrownDigest(revealCustomerAction(hiker.id, undefined, form({ reason: "curious" })))).toMatch(/\/forbidden/);
  });

  it("the route upload handler validates, stores and reports", async () => {
    const editor = await demoUser("editor");
    signIn(editor);
    const trail = await trailBySlug("cinder-spur-draft");
    const { POST } = await import("@/app/admin/trails/[id]/geometry/upload/route");
    const body = new FormData();
    body.append("file", new File(['{"type":"Point","coordinates":[0,0]}'], "bad.geojson", { type: "application/geo+json" }));
    const res = await POST(new Request(`http://localhost/admin/trails/${trail.id}/geometry/upload`, { method: "POST", body, headers: { "x-gg-upload": "1", origin: "http://localhost", host: "localhost" } }), {
      params: params({ id: trail.id }),
    } as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data?: { status: string } };
    expect(json).toMatchObject({ ok: true, data: { status: "invalid" } });

    const cross = await POST(new Request(`http://localhost/admin/trails/${trail.id}/geometry/upload`, { method: "POST", body: new FormData(), headers: { origin: "https://evil.example", host: "localhost" } }), {
      params: params({ id: trail.id }),
    } as never);
    expect(cross.status).toBe(403);

    signIn(await demoUser("support"));
    const denied = await POST(new Request(`http://localhost/admin/trails/${trail.id}/geometry/upload`, { method: "POST", body: new FormData(), headers: { "x-gg-upload": "1" } }), {
      params: params({ id: trail.id }),
    } as never);
    expect(denied.status).toBe(403);
  });
});
