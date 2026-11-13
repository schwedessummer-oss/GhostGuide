/**
 * The DB-backed provider throttle (src/server/providers/http.ts) against
 * Postgres: a request that would wait longer than it accepts never takes a
 * slot (so a burst above the provider's rate sheds only the excess instead
 * of locking the provider out for as long as the phantom backlog takes to
 * drain), an unused slot is given back when the caller aborts, a legacy
 * runaway backlog is clamped, and every wait honours the abort signal.
 *
 * Uses the "nominatim" throttle row (other files reset it before use too).
 * `fetch` is stubbed: no network.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, sql } from "@/server/db";
import { MAX_THROTTLE_WAIT_MS, ProviderError, providerFetch, releaseThrottleSlot, reserveThrottleSlot } from "@/server/providers/http";

const P = "nominatim" as const;
const INTERVAL = 1_100;

const fetchMock = vi.fn(async (): Promise<Response> => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));

beforeEach(async () => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  await sql()`delete from public.provider_throttle where provider = ${P}`;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await sql()`delete from public.provider_throttle where provider = ${P}`;
  await closeDb();
});

/** Seconds from now until next_allowed_at (negative: in the past; null: no row). */
async function backlogSec(): Promise<number | null> {
  const [row] = await sql()<{ s: number }[]>`
    select extract(epoch from (next_allowed_at - now()))::float8 as s from public.provider_throttle where provider = ${P}`;
  return row ? row.s : null;
}
async function setBacklog(seconds: number) {
  await sql()`insert into public.provider_throttle (provider, next_allowed_at) values (${P}, now() + make_interval(secs => ${seconds}::float8))
              on conflict (provider) do update set next_allowed_at = excluded.next_allowed_at`;
}

describe("reserveThrottleSlot", () => {
  it("a burst above capacity reserves only the slots that start within the wait cap; rejections do not move the clock", async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => reserveThrottleSlot(P, INTERVAL, 10_000)));
    const accepted = results.filter((r) => r !== null);
    // Slots at 0, 1.1, …, 9.9 s fit in a 10 s wait: about ten of them.
    expect(accepted.length).toBeGreaterThanOrEqual(9);
    expect(accepted.length).toBeLessThanOrEqual(11);
    for (const r of accepted) expect(r!.waitMs).toBeLessThanOrEqual(10_000);
    const backlog = (await backlogSec())!;
    expect(backlog).toBeLessThanOrEqual(11.5);

    // 20 more callers who would have to wait too long: all rejected, the backlog is unchanged.
    const more = await Promise.all(Array.from({ length: 20 }, () => reserveThrottleSlot(P, INTERVAL, 10_000)));
    expect(more.every((r) => r === null)).toBe(true);
    expect(Math.abs((await backlogSec())! - backlog)).toBeLessThan(0.5);
  });

  it("serves the next caller as soon as the real backlog has drained (no lasting lockout)", async () => {
    await setBacklog(0.5);
    const slot = await reserveThrottleSlot(P, INTERVAL, 10_000);
    expect(slot).not.toBeNull();
    expect(slot!.waitMs).toBeLessThanOrEqual(600);
  });

  it("clamps a runaway backlog left by older code, so the provider is never locked out for hours", async () => {
    await setBacklog(4 * 3600);
    expect(await reserveThrottleSlot(P, INTERVAL, 10_000)).toBeNull();
    const healed = (await backlogSec())!;
    expect(healed).toBeLessThanOrEqual(MAX_THROTTLE_WAIT_MS / 1000 + INTERVAL / 1000 + 0.5);
    // About two minutes later (simulated), ordinary callers are served again.
    await sql()`update public.provider_throttle set next_allowed_at = next_allowed_at - interval '115 seconds' where provider = ${P}`;
    expect(await reserveThrottleSlot(P, INTERVAL, 10_000)).not.toBeNull();
  });
});

describe("releaseThrottleSlot", () => {
  it("gives back the last slot taken, but never one with later reservations behind it", async () => {
    const a = (await reserveThrottleSlot(P, INTERVAL, 10_000))!;
    expect(await releaseThrottleSlot(P, INTERVAL, a)).toBe(true);
    expect((await backlogSec())!).toBeLessThanOrEqual(0.2);

    const first = (await reserveThrottleSlot(P, INTERVAL, 10_000))!;
    const second = (await reserveThrottleSlot(P, INTERVAL, 10_000))!;
    const before = (await backlogSec())!;
    expect(await releaseThrottleSlot(P, INTERVAL, first)).toBe(false);
    expect(Math.abs((await backlogSec())! - before)).toBeLessThan(0.2);
    expect(await releaseThrottleSlot(P, INTERVAL, second)).toBe(true);
  });
});

describe("providerFetch with a throttle", () => {
  const call = (signal?: AbortSignal, maxThrottleWaitMs?: number) =>
    providerFetch({ provider: P, url: "https://nominatim.example.test/search?q=x", minIntervalMs: INTERVAL, timeoutMs: 2_000, retries: 1, signal, maxThrottleWaitMs });

  it("rejects 'busy' at once when the wait would be too long, without taking a slot or calling the provider", async () => {
    await setBacklog(30);
    const before = (await backlogSec())!;
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ message: "Provider is busy (rate limit queue full)", retryable: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Math.abs((await backlogSec())! - before)).toBeLessThan(0.5);
  });

  it("stops waiting for its slot as soon as the caller aborts, and gives the slot back", async () => {
    await setBacklog(8);
    const before = (await backlogSec())!;
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 150);
    const err = await call(controller.signal).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(err).toMatchObject({ name: "ProviderError", message: "Request aborted", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
    // The reserved slot was the last one: the clock is back where it was.
    expect(Math.abs((await backlogSec())! - before)).toBeLessThan(0.5);
  });

  it("does not start (or retry) when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(call(controller.signal)).rejects.toMatchObject({ message: "Request aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await backlogSec()).toBeNull();
  });

  it("aborting during the retry backoff ends the call without a second request", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("busy", { status: 503 }));
    const controller = new AbortController();
    const p = call(controller.signal).catch((e: unknown) => e);
    // The first attempt fails fast with 503; abort while the client waits to retry.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    const err = await p;
    expect(err).toMatchObject({ message: "Request aborted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the request once its slot comes up", async () => {
    await setBacklog(0.3);
    const res = await call();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
