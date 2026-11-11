import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TripLogistics } from "@/components/hike/trip-logistics";
import { ClosureNotice } from "@/components/hike/closure-notice";
import { HikeCheckinCard } from "@/components/hike/hike-checkin";
import { SyncIssues } from "@/components/hike/hike-alerts";
import { SignOutButton } from "@/components/hike/sign-out-guard";
import type { HikeEngine, HikeSnapshot } from "@/components/hike/engine/hike-engine";
import type { BundleLogistics } from "@/lib/offline/wire";
import { makeBundle } from "./bundle-fixture";

const TZ = "America/Los_Angeles";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const logistics: BundleLogistics = {
  bookingStatus: "confirmed",
  addons: [
    {
      id: "f1",
      kind: "gear_locker",
      name: "Poles & pack",
      quantity: 1,
      status: "confirmed",
      statusText: "Gear locker: confirmed — code ready",
      simulated: true,
      locker: { name: "Trailhead Locker", location: "Next to the kiosk", items: ["Trekking poles"], accessCode: "123456", codeHint: null, codeExpiresAt: new Date().toISOString(), disclaimer: null },
      shuttle: null,
      meal: null,
    },
    {
      id: "f2",
      kind: "shuttle",
      name: "Shuttle",
      quantity: 1,
      status: "awaiting_customer",
      statusText: "Shuttle: awaiting your confirmation",
      simulated: true,
      locker: null,
      shuttle: { pickup: "Town square", dropoff: "Trailhead", pickupAt: new Date().toISOString(), confirmed: false },
      meal: null,
    },
  ],
  permits: [
    { name: "Day permit", authority: "Forest Service", officialUrl: "https://example.gov/permit", requirementSummary: "Required", howToObtain: "Online", status: "applied", confirmationRef: "APP-1" },
  ],
};

describe("round-2 hike components render", () => {
  it("booking details: locker code behind a disclosure, unconfirmed shuttle labelled as such, permit status", () => {
    const t = text(renderToStaticMarkup(createElement(TripLogistics, { logistics, timeZone: TZ })));
    expect(t).toMatch(/Gear, shuttle & meals/);
    expect(t).toMatch(/Trailhead Locker — Next to the kiosk/);
    expect(t).toMatch(/Show locker access code 123456/);
    expect(t).toMatch(/Proposed pickup \(not confirmed\): Town square/);
    expect(t).toMatch(/No ride is booked until you confirm it/);
    expect(t).toMatch(/Day permit Applied Confirmation: APP-1/);
    expect(text(renderToStaticMarkup(createElement(TripLogistics, { logistics: undefined, timeZone: TZ })))).toMatch(/Not in this download/);
  });

  it("closures: a full closure is an alert that says the hike can't be started; partial ones are listed", () => {
    const closed = { severity: "closed", reason: "Bridge out", startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: null };
    const partial = { severity: "partial", reason: "Upper loop closed", endsAt: null };
    const html = renderToStaticMarkup(createElement(ClosureNotice, { closures: [closed, partial], blocking: closed, timeZone: TZ, context: "start" }));
    expect(html).toMatch(/role="alert"/);
    const t = text(html);
    expect(t).toMatch(/Trail closed Bridge out\. until further notice\./);
    expect(t).toMatch(/can't be started/);
    expect(t).toMatch(/Partial closure: Upper loop closed/);
    expect(renderToStaticMarkup(createElement(ClosureNotice, { closures: [], blocking: null, timeZone: TZ, context: "active" }))).toBe("");
  });

  const snap = (over: Partial<HikeSnapshot>): HikeSnapshot =>
    ({
      now: Date.now(),
      bundle: makeBundle(),
      sync: { online: false, status: "offline", queued: 1, lastSyncAt: null, nextAttemptAt: null, message: null, dropped: 0 },
      syncIssues: { dropped: 0, droppedAt: null, reason: null, clockSkewMs: 0 },
      checkin: null,
      ...over,
    }) as HikeSnapshot;

  it("check-in card: expected return, when the contact is notified, extend controls and an honest offline status", () => {
    const at = Date.now() + 3600_000;
    const s = snap({
      checkin: {
        status: "active",
        open: true,
        expectedReturnAt: at + 1800_000,
        serverExpectedReturnAt: at,
        graceMinutes: 30,
        notifyAfter: at + 3600_000,
        extension: { id: "x", at: Date.now(), newExpectedReturnAt: at + 1800_000, state: "queued", reason: null },
      },
    });
    const t = text(renderToStaticMarkup(createElement(HikeCheckinCard, { snap: s, engine: {} as HikeEngine })));
    expect(t).toMatch(/Expected back by/);
    expect(t).toMatch(/your 30-minute grace period/);
    expect(t).toMatch(/nobody calls 911 automatically/);
    expect(t).toMatch(/\+30 min \+1 h \+2 h/);
    expect(t).toMatch(/saved on this device and will be sent when you're back online/);
    expect(renderToStaticMarkup(createElement(HikeCheckinCard, { snap: snap({}), engine: {} as HikeEngine }))).toBe("");
  });

  it("sync issues: refused updates and a wrong phone clock are reported", () => {
    const t = text(renderToStaticMarkup(createElement(SyncIssues, { snap: snap({ syncIssues: { dropped: 2, droppedAt: Date.now(), reason: "bad data", clockSkewMs: 6 * 60_000 } }) })));
    expect(t).toMatch(/2 hike updates could not be accepted by Ghost Guide and were removed from this device — bad data/);
    expect(t).toMatch(/about 6 min ahead/);
    expect(renderToStaticMarkup(createElement(SyncIssues, { snap: snap({}) }))).toBe("");
  });

  it("sign-out button (contract C) is a plain POST form to /auth/logout without JavaScript, with an accessible guard dialog", () => {
    const html = renderToStaticMarkup(createElement(SignOutButton, { className: "btn" }, "Sign out"));
    expect(html).toMatch(/<form action="\/auth\/logout" method="post">/);
    expect(html).toMatch(/<button class="btn"[^>]*>Sign out<\/button>/);
    expect(html).toMatch(/<dialog[^>]*aria-labelledby="signout-guard-title"/);
    const t = text(html);
    for (const label of ["Try sync again", "Sign out anyway", "Stay signed in"]) expect(t).toContain(label);
  });
});
