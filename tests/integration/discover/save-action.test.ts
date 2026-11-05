/**
 * The "Save this trip" server action, run outside Next.js: the cookie store
 * is mocked with a real signed demo session, and redirect() targets are read
 * from the thrown redirect error's digest.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, withUser } from "@/server/db";
import { signSession } from "@/server/auth/tokens";
import { DEMO_SESSION_COOKIE, type SessionUser } from "@/server/auth";
import { toPlanQuery } from "@/server/discover/preferences";
import type { TripPreferences } from "@/domain/types";
import { createCustomer, daysFromNow, trailBySlug } from "../../helpers/db";

const cookieJar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "gg_session" && cookieJar.token ? { name, value: cookieJar.token } : undefined),
    getAll: () => [],
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));

afterAll(closeDb);
beforeEach(() => {
  cookieJar.token = undefined;
});

function signIn(user: SessionUser) {
  cookieJar.token = signSession(process.env.AUTH_SECRET!, { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600 });
}

async function redirectTarget(p: Promise<unknown>): Promise<string> {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { digest?: string } | null;
  if (!err?.digest?.startsWith("NEXT_REDIRECT")) throw new Error(`expected a redirect, got ${String(err)}`);
  return err.digest.split(";").slice(2, -2).join(";");
}

const prefs: TripPreferences = {
  experience: "some",
  fitness: "moderate",
  preferredTerrain: ["forest"],
  pace: "steady",
  availableHours: 4,
  plannedDate: daysFromNow(10),
  startTime: "09:00",
  accessibilityNeeds: [],
  partySize: 2,
  equipment: [],
  bringingDog: false,
};

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

describe("saveTripAction", () => {
  it("sends signed-out visitors to sign in and back to the same results", async () => {
    expect(DEMO_SESSION_COOKIE).toBe("gg_session");
    const { saveTripAction } = await import("@/app/plan/actions");
    const lantern = await trailBySlug("lantern-creek-loop");
    const q = toPlanQuery(prefs);
    const to = await redirectTarget(saveTripAction(form({ q, trailId: lantern.id })));
    expect(to).toBe(`/login?next=${encodeURIComponent(`/plan/results?${q}`)}`);
  });

  it("saves for a signed-in customer and redirects to the trip, ignoring tampered fields", async () => {
    const { saveTripAction } = await import("@/app/plan/actions");
    const user = await createCustomer("action");
    signIn(user);
    const lantern = await trailBySlug("lantern-creek-loop");
    const fd = form({ q: `${toPlanQuery(prefs)}&score=100`, trailId: lantern.id, score: "100", userId: "00000000-0000-4000-8000-000000000000" });
    const to = await redirectTarget(saveTripAction(fd));
    expect(to).toMatch(/^\/trips\/[0-9a-f-]{36}$/);
    const tripId = to.split("/").pop()!;
    const [row] = await withUser(user, (tx) => tx<{ userId: string; recommendation: { score: number } }[]>`select user_id, recommendation from public.trips where id = ${tripId}`);
    expect(row.userId).toBe(user.id);
    expect(row.recommendation.score).not.toBe(100);
  });

  it("returns to the results with an error when the trail no longer fits", async () => {
    const { saveTripAction } = await import("@/app/plan/actions");
    const user = await createCustomer("action2");
    signIn(user);
    const whisper = await trailBySlug("whisper-falls");
    const q = toPlanQuery({ ...prefs, bringingDog: true });
    const to = await redirectTarget(saveTripAction(form({ q, trailId: whisper.id })));
    expect(to).toBe(`/plan/results?${q}&saveError=excluded&saveTrail=${whisper.id}#trail-${whisper.id}`);
    expect(await withUser(user, (tx) => tx`select id from public.trips`)).toHaveLength(0);
  });

  it("rejects malformed input without saving", async () => {
    const { saveTripAction } = await import("@/app/plan/actions");
    const user = await createCustomer("action3");
    signIn(user);
    expect(await redirectTarget(saveTripAction(form({ q: "experience=guru", trailId: "not-a-uuid" })))).toBe("/plan");
    expect(await redirectTarget(saveTripAction(form({ q: "experience=guru", trailId: "00000000-0000-4000-8000-000000000000" })))).toBe("/plan");
  });
});
