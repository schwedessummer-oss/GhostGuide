import { afterAll, describe, expect, it } from "vitest";
import { closeDb, sql, withSystem } from "@/server/db";
import { planTrip } from "@/server/discover/plan";
import { getLatestFinishTable, loadCandidates } from "@/server/discover/catalog";
import { createCustomer } from "../../helpers/db";
import type { TripPreferences } from "@/domain/types";
import { daysFromNow, trailBySlug } from "../../helpers/db";

afterAll(closeDb);

function broadPrefs(overrides: Partial<TripPreferences> = {}): TripPreferences {
  return {
    experience: "expert",
    fitness: "high",
    preferredTerrain: [],
    pace: "steady",
    availableHours: 12,
    plannedDate: daysFromNow(10),
    startTime: "07:00",
    accessibilityNeeds: [],
    partySize: 2,
    equipment: [],
    bringingDog: false,
    ...overrides,
  };
}

async function withClosure<T>(slug: string, severity: "closed" | "partial", startsAt: string, endsAt: string | null, fn: () => Promise<T>): Promise<T> {
  const trail = await trailBySlug(slug);
  const [c] = await withSystem(
    (tx) => tx<{ id: string }[]>`
      insert into public.trail_closures (trail_id, severity, reason, starts_at, ends_at)
      values (${trail.id}, ${severity}, 'Test closure: bridge replacement (fictional)', ${startsAt}::timestamptz, ${endsAt}::timestamptz)
      returning id`,
  );
  try {
    return await fn();
  } finally {
    await sql()`delete from public.trail_closures where id = ${c.id}`;
  }
}

const slugs = (r: Awaited<ReturnType<typeof planTrip>>) => ({
  ranked: r.suggestions.map((s) => s.trail.slug),
  excluded: r.excluded.map((e) => e.trail.slug),
});

describe("recommendation over the seeded catalog", () => {
  it("evaluates every published trail and never recommends (or lists) the draft trail", async () => {
    const r = await planTrip(broadPrefs());
    const s = slugs(r);
    expect([...s.ranked, ...s.excluded].sort()).toEqual(
      ["echo-basin-traverse", "hollow-pine-ridge", "lantern-creek-loop", "miners-meadow-loop", "old-signal-summit", "whisper-falls"].sort(),
    );
    expect(s.ranked).not.toContain("cinder-spur-draft");
    expect(s.excluded).not.toContain("cinder-spur-draft");
    expect(r.noMatch).toBe(false);
    expect(r.region.slug).toBe("demo-ghost-ridge");
    // ranks are 1..n in score order
    expect(r.suggestions.map((x) => x.rank)).toEqual(r.suggestions.map((_, i) => i + 1));
    const scores = r.suggestions.map((x) => x.result.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    // the draft trail is not even loadable through the public read model
    const draft = await trailBySlug("cinder-spur-draft");
    const bundle = await loadCandidates({ trailId: draft.id }, daysFromNow(10), "America/Los_Angeles");
    expect(bundle.candidates).toHaveLength(0);
  });

  it("flags the partially closed trail with a warning and a score penalty", async () => {
    const r = await planTrip(broadPrefs());
    const signal = r.suggestions.find((s) => s.trail.slug === "old-signal-summit");
    expect(signal).toBeDefined();
    expect(signal!.result.warnings.some((w) => /^Partial closure: Upper switchbacks closed/.test(w))).toBe(true);
    expect(signal!.result.breakdown.find((f) => f.factor === "Closures & advisories")!.points).toBeLessThan(0);
    // out-and-back itinerary carries a turnaround time
    expect(signal!.itinerary.turnaroundBy).toMatch(/^\d{2}:\d{2}$/);
    expect(signal!.itinerary.stops.length).toBe(3);
    // the demo advisory on Whisper Falls is shown but does not exclude
    const whisper = r.suggestions.find((s) => s.trail.slug === "whisper-falls");
    expect(whisper!.result.warnings.some((w) => /^Advisory:/.test(w))).toBe(true);
  });

  it("excludes a trail with a full closure on the planned date", async () => {
    await withClosure("lantern-creek-loop", "closed", new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 30 * 86_400_000).toISOString(), async () => {
      const r = await planTrip(broadPrefs());
      expect(slugs(r).ranked).not.toContain("lantern-creek-loop");
      const ex = r.excluded.find((e) => e.trail.slug === "lantern-creek-loop");
      expect(ex?.codes).toContain("closure");
      expect(ex?.reasons.join(" ")).toMatch(/Fully closed.*bridge replacement/);
    });
  });

  it("ignores a full closure that ends before the planned date", async () => {
    await withClosure("lantern-creek-loop", "closed", new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 3 * 86_400_000).toISOString(), async () => {
      const r = await planTrip(broadPrefs({ plannedDate: daysFromNow(10) }));
      expect(slugs(r).ranked).toContain("lantern-creek-loop");
    });
  });

  it("warns about permits when lead time can be met and excludes when it cannot", async () => {
    const ok = await planTrip(broadPrefs({ plannedDate: daysFromNow(10) }));
    const echo = ok.suggestions.find((s) => s.trail.slug === "echo-basin-traverse");
    expect(echo?.result.warnings.join(" ")).toMatch(/Permit required: Echo Basin day-use permit/);
    expect(echo?.permits[0].officialUrl).toMatch(/^https:\/\//);
    const soon = await planTrip(broadPrefs({ plannedDate: daysFromNow(3) }));
    expect(soon.excluded.find((e) => e.trail.slug === "echo-basin-traverse")?.codes).toContain("permit");
  });

  it("says plainly when nothing matches and suggests what to relax", async () => {
    const r = await planTrip(broadPrefs({ availableHours: 1, startTime: "15:30", accessibilityNeeds: ["step_free", "avoid_exposure"], bringingDog: true }));
    expect(r.noMatch).toBe(true);
    expect(r.suggestions).toHaveLength(0);
    expect(r.excluded).toHaveLength(6);
    expect(r.relaxSuggestions.length).toBeGreaterThan(0);
    // Lantern Creek Loop (step-free, dog-friendly) is blocked only by the latest-finish estimate.
    expect(r.relaxSuggestions.join(" ")).toMatch(/Start earlier, by \d{2}:\d{2} at the latest, to finish Lantern Creek Loop before the latest-finish estimate for [A-Z][a-z]+ \(\d{2}:\d{2}\)/);
    // Every other trail lacks a needed accessibility feature, so it is never named.
    for (const name of ["Old Signal Summit", "Echo Basin Traverse", "Whisper Falls Trail", "Miner's Meadow Loop", "Hollow Pine Ridge"]) {
      expect(r.relaxSuggestions.join(" ")).not.toContain(name);
    }
  });

  it("never nudges a new, low-fitness hiker toward trails excluded by the experience rule or by access needs", async () => {
    const p = broadPrefs({
      experience: "new",
      fitness: "low",
      pace: "leisurely",
      availableHours: 1,
      startTime: "08:30",
      bringingDog: true,
      accessibilityNeeds: ["step_free", "avoid_exposure"],
      plannedDate: daysFromNow(14),
    });
    const r = await planTrip(p);
    expect(r.noMatch).toBe(true);
    const text = r.relaxSuggestions.join("\n");
    expect(text).toMatch(/Allow at least 1\.5 h to include Lantern Creek Loop\./);
    for (const name of ["Old Signal Summit", "Echo Basin Traverse", "Whisper Falls Trail", "Miner's Meadow Loop", "Hollow Pine Ridge"]) {
      expect(text).not.toContain(name);
    }
    // and the named change really includes it
    const again = await planTrip({ ...p, availableHours: 1.5 });
    expect(again.suggestions.map((s) => s.trail.slug)).toContain("lantern-creek-loop");
  });

  it("carries the partial closure into the itinerary of the partially closed trail only", async () => {
    const r = await planTrip(broadPrefs());
    const signal = r.suggestions.find((s) => s.trail.slug === "old-signal-summit")!;
    expect(signal.partialClosures).toEqual([expect.stringMatching(/^Upper switchbacks closed.*Turn around at the Signal Tower\.$/)]);
    expect(signal.itinerary.notes).toContainEqual(expect.stringMatching(/^Partial closure on your date: Upper switchbacks closed.*Follow the closure/));
    expect(signal.itinerary.notes.join(" ")).not.toMatch(/even if you have not reached it/);
    const hollow = r.suggestions.find((s) => s.trail.slug === "hollow-pine-ridge")!;
    expect(hollow.partialClosures).toEqual([]);
    expect(hollow.itinerary.notes.join(" ")).not.toMatch(/Partial closure/);
    // a partial closure that has ended by the planned date is not shown
    const later = await planTrip(broadPrefs({ plannedDate: daysFromNow(60) }));
    expect(later.suggestions.find((s) => s.trail.slug === "old-signal-summit")!.partialClosures).toEqual([]);
  });

  it("highlights a requested trail", async () => {
    const r = await planTrip(broadPrefs(), { focusSlug: "hollow-pine-ridge" });
    expect(r.focus).toEqual({ slug: "hollow-pine-ridge", status: "ranked" });
    const missing = await planTrip(broadPrefs(), { focusSlug: "cinder-spur-draft" });
    expect(missing.focus?.status).toBe("unknown");
  });

  it("checks remaining daily capacity from live bookings (advisory pre-check)", async () => {
    const lantern = await trailBySlug("lantern-creek-loop");
    const date = daysFromNow(12);
    const before = await loadCandidates({ trailId: lantern.id }, date, "America/Los_Angeles");
    expect(before.candidates[0].capacityRemaining).toBe(lantern.dailyCapacity);

    const owner = await createCustomer("capacity");
    const bookingId = await withSystem(async (tx) => {
      const [trip] = await tx<{ id: string }[]>`
        insert into public.trips (user_id, region_id, trail_id, planned_date, party_size)
        values (${owner.id}, ${lantern.regionId}, ${lantern.id}, ${date}::date, 12) returning id`;
      const [b] = await tx<{ id: string }[]>`
        insert into public.bookings (user_id, trip_id, trail_id, hike_date, party_size, status, subtotal_cents, total_cents, payment_provider, idempotency_key)
        values (${owner.id}, ${trip.id}, ${lantern.id}, ${date}::date, 12, 'confirmed', 0, 0, 'demo', ${`cap-${trip.id}`}) returning id`;
      await tx`insert into public.trail_day_inventory (trail_id, day, capacity) values (${lantern.id}, ${date}::date, 14)`;
      return b.id;
    });
    try {
      const after = await loadCandidates({ trailId: lantern.id }, date, "America/Los_Angeles");
      expect(after.candidates[0].capacityRemaining).toBe(2);
      const r = await planTrip(broadPrefs({ plannedDate: date, partySize: 3 }));
      expect(r.excluded.find((e) => e.trail.slug === "lantern-creek-loop")?.codes).toContain("capacity");
      const ok = await planTrip(broadPrefs({ plannedDate: date, partySize: 2 }));
      expect(slugs(ok).ranked).toContain("lantern-creek-loop");
    } finally {
      await sql()`delete from public.bookings where id = ${bookingId}`;
      await sql()`delete from public.trail_day_inventory where trail_id = ${lantern.id} and day = ${date}::date`;
    }
  });

  it("uses the operator-configurable latest-finish table (an estimate, not sunset)", async () => {
    const table = await getLatestFinishTable("demo-ghost-ridge");
    expect(table[11]).toBe("15:45");
    const [orig] = await sql()<{ value: unknown }[]>`select value from public.app_settings where key = 'latest_finish_by_month'`;
    const month = String(Number(daysFromNow(10).slice(5, 7)));
    await sql()`update public.app_settings set value = ${sql().json({ "demo-ghost-ridge": { [month]: "10:00" } })} where key = 'latest_finish_by_month'`;
    try {
      const r = await planTrip(broadPrefs({ startTime: "07:00" }));
      expect(r.latestFinishTime).toBe("10:00");
      expect(r.excluded.find((e) => e.trail.slug === "old-signal-summit")?.codes).toContain("latest_finish");
    } finally {
      await sql()`update public.app_settings set value = ${sql().json(orig.value as never)} where key = 'latest_finish_by_month'`;
    }
  });
});
