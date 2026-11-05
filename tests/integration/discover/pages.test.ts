/**
 * Render smoke tests for the discover pages: run the server components
 * against the seeded test database and render them to HTML with React's
 * server renderer (no Next.js server needed). Signed-out visitor.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { closeDb } from "@/server/db";
import { daysFromNow } from "../../helpers/db";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

afterAll(closeDb);

async function html(el: ReactElement): Promise<string> {
  const stream = await renderToReadableStream(el, { onError: (e) => console.error(e) });
  await stream.allReady;
  return new Response(stream).text();
}

const props = <P extends object, S extends object>(params: P, searchParams: S) =>
  ({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) }) as never;

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("discover pages render", () => {
  it("landing page explains the product honestly and links onward", async () => {
    const { default: HomePage } = await import("@/app/page");
    const out = await html(await HomePage());
    const t = text(out);
    expect(t).toMatch(/fictional/);
    expect(t).toMatch(/Discover a hike.*personalized itinerary.*Purchase.*Download.*audio narration.*check-ins/i);
    expect(out).toContain('href="/how-it-works"');
    expect(out).toContain('href="/trails"');
    expect(out).toContain('href="/plan"');
    expect(t).not.toMatch(/guaranteed rescue|satellite SOS/i);
  });

  it("trail list shows cards with demo labels, estimates, closure badges and prices", async () => {
    const { default: TrailsPage } = await import("@/app/trails/page");
    const t = text(await html(await TrailsPage(props({}, {}))));
    expect(t).toMatch(/6 trails/);
    expect(t).toContain("Lantern Creek Loop");
    expect(t).not.toContain("Cinder Spur");
    expect(t).toMatch(/Demo trail/);
    expect(t).toMatch(/est\./);
    expect(t).toMatch(/Partial closure/);
    expect(t).toMatch(/Advisory/);
    expect(t).toMatch(/from \$19\.00 \/ person/);
    expect(t).toMatch(/mi \(\s?\d+\.\d km\s?\)/);
  });

  it("filters via GET parameters and offers a map view with a text alternative", async () => {
    const { default: TrailsPage } = await import("@/app/trails/page");
    const filtered = text(await html(await TrailsPage(props({}, { difficulty: "easy", dogs: "yes" }))));
    expect(filtered).toMatch(/2 trails match your filters/);
    expect(filtered).not.toContain("Echo Basin Traverse");
    const map = await html(await TrailsPage(props({}, { view: "map" })));
    expect(map).toContain("<svg");
    expect(map).toMatch(/aria-current="page"[^>]*>.*Map/);
    expect(text(map)).toMatch(/Trails on the map/);
    expect(map).toContain('href="/trails/echo-basin-traverse"');
  });

  it("trail detail shows facts, provenance, freshness, permits, closures and narration", async () => {
    const { default: TrailPage } = await import("@/app/trails/[slug]/page");
    const signal = text(await html(await TrailPage(props({ slug: "old-signal-summit" }, {}))));
    expect(signal).toContain("Demonstration trail — fictional, not for navigation");
    expect(signal).toMatch(/Partial closure/);
    expect(signal).toMatch(/Upper switchbacks closed/);
    expect(signal).toMatch(/last verified 20 days ago/);
    expect(signal).toMatch(/Estimate: 4\.5 km\/h/);
    expect(signal).toMatch(/Demonstration/);
    expect(signal).toMatch(/The signal tower/);
    expect(signal).toMatch(/Personalize this hike/);
    const echo = await html(await TrailPage(props({ slug: "echo-basin-traverse" }, {})));
    expect(echo).toContain('href="https://example.org/demo-permits/echo-basin"');
    expect(text(echo)).toMatch(/at least 7 days ahead/);
    expect(echo).toContain('href="/plan?trail=echo-basin-traverse"');
  });

  it("returns 404 for unknown and draft trails", async () => {
    const { default: TrailPage } = await import("@/app/trails/[slug]/page");
    await expect(TrailPage(props({ slug: "cinder-spur-draft" }, {}))).rejects.toMatchObject({ digest: expect.stringMatching(/404/) });
    await expect(TrailPage(props({ slug: "no-such-trail" }, {}))).rejects.toMatchObject({ digest: expect.stringMatching(/404/) });
  });

  it("questionnaire renders labeled fields with defaults and the focus trail", async () => {
    const { default: PlanPage } = await import("@/app/plan/page");
    const out = await html(await PlanPage(props({}, { trail: "hollow-pine-ridge" })));
    expect(out).toContain('action="/plan/results"');
    expect(out).toContain('method="get"');
    for (const id of ["hours", "minMi", "maxMi", "maxGainFt", "date", "start", "party"]) {
      expect(out).toMatch(new RegExp(`<label[^>]*for="${id}"`));
    }
    expect(out).toContain('name="trail" value="hollow-pine-ridge"');
    expect(text(out)).toMatch(/check Hollow Pine Ridge first/);
  });

  it("results page ranks trails with breakdowns, itinerary, labeled AI text and save buttons", async () => {
    const { default: Results } = await import("@/app/plan/results/page");
    const q = {
      experience: "regular",
      fitness: "high",
      pace: "steady",
      hours: "8",
      date: daysFromNow(10),
      start: "08:00",
      party: "2",
      maxGainFt: "2000",
      trail: "old-signal-summit",
    };
    const out = await html(await Results(props({}, q)));
    const t = text(out);
    expect(t).toMatch(/Your hike suggestions/);
    expect(t).toMatch(/#\s*1 suggestion/);
    expect(t).toMatch(/Simulated AI \(template\)/);
    expect(t).toMatch(/How the score of \d+ was calculated/);
    expect(t).toMatch(/Turn around by \d\d:\d\d/);
    expect(t).toMatch(/Sign in to save this trip/);
    expect(t).toMatch(/Old Signal Summit doesn't fit your answers/);
    expect(t).toMatch(/Trails we excluded/);
    expect(out).toContain('name="trailId"');
  });

  it("results page says plainly when nothing fits and never invents a route", async () => {
    const { default: Results } = await import("@/app/plan/results/page");
    const t = text(
      await html(
        await Results(props({}, { experience: "new", fitness: "low", pace: "leisurely", hours: "1", date: daysFromNow(10), start: "15:30", party: "2", dog: "yes" })),
      ),
    );
    expect(t).toMatch(/No trail fits all of your answers/);
    expect(t).toMatch(/never invent one/);
    expect(t).toMatch(/What you could change/);
    expect(t).not.toMatch(/Save this trip/);
  });

  it("invalid answers re-render the form with an error summary", async () => {
    const { default: Results } = await import("@/app/plan/results/page");
    const out = await html(await Results(props({}, { experience: "some", fitness: "moderate", pace: "steady", hours: "40", date: "2020-01-01", start: "08:00", party: "2" })));
    expect(text(out)).toMatch(/Check your answers/);
    expect(out).toMatch(/role="alert"/);
    expect(out).toContain('href="#hours"');
  });
});
