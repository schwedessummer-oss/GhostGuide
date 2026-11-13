import "server-only";
import { withSystem, type Tx } from "@/server/db";
import { env } from "@/config/env";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/**
 * Fixed-window rate limiter backed by Postgres, so limits hold across
 * serverless instances. `key` should include the scope and the subject,
 * e.g. `ai:explain:user:<id>` or `notify:checkin:<checkinId>`.
 */
export async function checkRateLimit(key: string, baseLimit: number, windowSec: number): Promise<RateLimitResult> {
  const limit = baseLimit * env().RATE_LIMIT_SCALE;
  const windowMs = windowSec * 1000;
  const start = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const [row] = await withSystem(
    (tx) => tx<{ count: number }[]>`
      insert into public.rate_limits (key, window_start, count)
      values (${key}, ${start}::timestamptz, 1)
      on conflict (key, window_start) do update set count = public.rate_limits.count + 1
      returning count`,
  );
  return {
    allowed: row.count <= limit,
    remaining: Math.max(0, limit - row.count),
    resetAt: new Date(start.getTime() + windowMs),
  };
}

export interface RateBudgetResult {
  /** Units granted now (0 … cost). */
  granted: number;
  /** Units left in this window after the grant. */
  remaining: number;
  resetAt: Date;
}

/**
 * Fixed-window WORK budget: atomically take up to `cost` units from the
 * subject's budget of `baseLimit` units per window (scaled by
 * RATE_LIMIT_SCALE like checkRateLimit). Grants what is left when less than
 * `cost` remains; never over-spends, even under concurrent calls (the
 * window row is locked). Use it where a request's cost varies, e.g. "new
 * tiles queued for loading", rather than counting requests.
 *
 * Pass a transaction to charge the budget atomically with the work it pays
 * for (rolled back together); without one, it runs in its own transaction.
 */
export async function consumeRateBudget(
  tx: Tx | null,
  key: string,
  cost: number,
  baseLimit: number,
  windowSec: number,
): Promise<RateBudgetResult> {
  const limit = Math.max(0, Math.floor(baseLimit * env().RATE_LIMIT_SCALE));
  const want = Math.max(0, Math.floor(Number.isFinite(cost) ? cost : 0));
  const windowMs = windowSec * 1000;
  const start = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const resetAt = new Date(start.getTime() + windowMs);
  const run = async (t: Tx): Promise<RateBudgetResult> => {
    await t`
      insert into public.rate_limits (key, window_start, count)
      values (${key}, ${start}::timestamptz, 0)
      on conflict (key, window_start) do nothing`;
    const [cur] = await t<{ count: number }[]>`
      select count from public.rate_limits where key = ${key} and window_start = ${start}::timestamptz for update`;
    const used = cur?.count ?? 0;
    const granted = Math.min(want, Math.max(0, limit - used));
    if (granted > 0) {
      await t`
        update public.rate_limits set count = count + ${granted}::int
         where key = ${key} and window_start = ${start}::timestamptz`;
    }
    return { granted, remaining: Math.max(0, limit - used - granted), resetAt };
  };
  if (want === 0) return { granted: 0, remaining: limit, resetAt };
  return tx ? run(tx) : withSystem(run);
}

/** Housekeeping: delete windows older than a day (called by a job). */
export async function purgeOldRateLimitWindows() {
  await withSystem((tx) => tx`delete from public.rate_limits where window_start < now() - interval '1 day'`);
}
