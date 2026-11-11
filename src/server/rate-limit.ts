import "server-only";
import { withSystem } from "@/server/db";
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

/** Housekeeping: delete windows older than a day (called by a job). */
export async function purgeOldRateLimitWindows() {
  await withSystem((tx) => tx`delete from public.rate_limits where window_start < now() - interval '1 day'`);
}
