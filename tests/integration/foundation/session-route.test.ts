/**
 * GET /api/session (finding #3): the site chrome learns the session here,
 * because the root layout reads no cookies. Run outside Next.js with the
 * cookie store mocked and a real signed demo session.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb } from "@/server/db";
import { signSession } from "@/server/auth/tokens";
import type { SessionUser } from "@/server/auth";
import { createCustomer, demoUser } from "../../helpers/db";

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

import { GET } from "@/app/api/session/route";

afterAll(closeDb);
beforeEach(() => {
  cookieJar.token = undefined;
});

function signIn(user: SessionUser) {
  cookieJar.token = signSession(process.env.AUTH_SECRET!, { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600 });
}

describe("GET /api/session", () => {
  it("signed out: { signedIn: false, canAdmin: false }, never cached", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(await res.json()).toEqual({ signedIn: false, canAdmin: false });
  });

  it("a customer is signed in without Admin, and nothing personal is returned", async () => {
    const user = await createCustomer("session");
    signIn(user);
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ signedIn: true, canAdmin: false });
    expect(JSON.stringify(body)).not.toContain(user.email);
    expect(JSON.stringify(body)).not.toContain(user.id);
  });

  it("staff who may open Admin get the Admin link", async () => {
    signIn(await demoUser("admin"));
    expect(await (await GET()).json()).toEqual({ signedIn: true, canAdmin: true });
  });

  it("a forged or expired session counts as signed out", async () => {
    cookieJar.token = "forged.token";
    expect(await (await GET()).json()).toEqual({ signedIn: false, canAdmin: false });
    const user = await createCustomer("expired");
    cookieJar.token = signSession(process.env.AUTH_SECRET!, { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) - 10 });
    expect(await (await GET()).json()).toEqual({ signedIn: false, canAdmin: false });
  });
});
