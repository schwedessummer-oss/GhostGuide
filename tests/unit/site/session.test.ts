import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hintFromCookie, parseSessionResponse } from "@/components/site/session";

/*
 * The header/tab bar learn the session in the browser (the root layout reads
 * no cookies so public pages stay cacheable; finding #3). These cover the
 * pure parts and the refresh rules: ask once per page load, again only when
 * the device's sign-in hint changes, never trust anything but the answer for
 * Admin, and keep a guess (never a crash) when the request fails.
 */
describe("hintFromCookie", () => {
  it("reads the gg_owner hint and ignores everything else", () => {
    expect(hintFromCookie("a=1; gg_owner=abcDEF012345_-xyz; b=2")).toBe("abcDEF012345_-xyz");
    expect(hintFromCookie("gg_owner=short")).toBeNull();
    expect(hintFromCookie("gg_owner=%E0%A4%A")).toBeNull();
    expect(hintFromCookie("gg_owner_x=abcdefghijkl")).toBeNull();
    expect(hintFromCookie("")).toBeNull();
    expect(hintFromCookie(undefined)).toBeNull();
  });
});

describe("parseSessionResponse", () => {
  it("accepts { signedIn, canAdmin }; Admin only with a session", () => {
    expect(parseSessionResponse({ signedIn: true, canAdmin: true })).toEqual({ signedIn: true, canAdmin: true });
    expect(parseSessionResponse({ signedIn: true })).toEqual({ signedIn: true, canAdmin: false });
    expect(parseSessionResponse({ signedIn: false, canAdmin: true })).toEqual({ signedIn: false, canAdmin: false });
    expect(parseSessionResponse({ error: "x" })).toBeNull();
    expect(parseSessionResponse(null)).toBeNull();
    expect(parseSessionResponse("yes")).toBeNull();
  });
});

describe("refreshSession", () => {
  const HINT = "hintABCDEFGH1234";
  const doc = { cookie: "", visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() };
  let fetchMock: ReturnType<typeof vi.fn>;

  async function load() {
    vi.resetModules();
    return import("@/components/site/session");
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const answer = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

  beforeEach(() => {
    doc.cookie = "";
    fetchMock = vi.fn(() => answer({ signedIn: false, canAdmin: false }));
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("document", doc);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts from the hint's guess, then shows the server's answer (Admin only from the answer)", async () => {
    doc.cookie = `gg_owner=${HINT}`;
    fetchMock.mockImplementation(() => answer({ signedIn: true, canAdmin: true }));
    const s = await load();
    expect(s.getSessionView()).toEqual({ status: "pending", signedIn: true, canAdmin: false });
    s.refreshSession();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/session");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store", credentials: "same-origin" });
    expect(s.getSessionView()).toEqual({ status: "known", signedIn: true, canAdmin: true });
  });

  it("asks once while the hint is unchanged, and again after signing in or out on this device", async () => {
    const s = await load();
    s.refreshSession();
    s.refreshSession();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(s.getSessionView()).toEqual({ status: "known", signedIn: false, canAdmin: false });

    // Sign-in sets the hint (then a client-side navigation runs the check).
    doc.cookie = `gg_owner=${HINT}`;
    fetchMock.mockImplementation(() => answer({ signedIn: true, canAdmin: false }));
    s.refreshSession();
    expect(s.getSessionView()).toEqual({ status: "pending", signedIn: true, canAdmin: false });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(s.getSessionView()).toEqual({ status: "known", signedIn: true, canAdmin: false });

    s.refreshSession();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    s.refreshSession(true);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("an expired session with a leftover hint ends signed out (the server decides)", async () => {
    doc.cookie = `gg_owner=${HINT}`;
    const s = await load();
    s.refreshSession();
    await flush();
    expect(s.getSessionView()).toEqual({ status: "known", signedIn: false, canAdmin: false });
  });

  it("a failed request keeps the guess and asks again on the next check", async () => {
    doc.cookie = `gg_owner=${HINT}`;
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("offline")));
    fetchMock.mockImplementationOnce(() => answer({ error: "x" }, 503));
    const s = await load();
    s.refreshSession();
    await flush();
    expect(s.getSessionView()).toEqual({ status: "pending", signedIn: true, canAdmin: false });
    s.refreshSession();
    await flush();
    expect(s.getSessionView()).toEqual({ status: "pending", signedIn: true, canAdmin: false });
    fetchMock.mockImplementation(() => answer({ signedIn: true, canAdmin: false }));
    s.refreshSession();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(s.getSessionView()).toEqual({ status: "known", signedIn: true, canAdmin: false });
  });
});
