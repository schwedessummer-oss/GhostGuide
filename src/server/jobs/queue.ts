import "server-only";
import { sql, withSystem, type JsonValue, type Tx } from "@/server/db";
import { log } from "@/server/log";

/**
 * Durable Postgres-backed job queue.
 *
 *  - Enqueue inside the same transaction as the state change that requires
 *    it (outbox pattern), so a committed booking always has its fulfillment
 *    job and a rolled-back one never does.
 *  - `dedupKey` makes enqueue idempotent: a second enqueue with the same key
 *    is a no-op, even across concurrent requests / webhook redeliveries.
 *  - Jobs are claimed with FOR UPDATE SKIP LOCKED, so concurrent runners
 *    (overlapping cron invocations) never run the same job twice at once.
 *  - Failures retry with exponential backoff; after maxAttempts the job is
 *    marked `dead` and surfaces in the admin retry queue.
 *  - A job stuck in `running` (crashed worker) is reclaimed after
 *    LOCK_TIMEOUT. Handlers therefore MUST be idempotent and re-check current
 *    state (e.g. a check-in's version) before acting.
 */
export interface Job<P = Record<string, unknown>> {
  id: number;
  kind: string;
  payload: P;
  runAt: Date;
  status: "queued" | "running" | "succeeded" | "failed" | "dead" | "cancelled";
  attempts: number;
  maxAttempts: number;
  dedupKey: string | null;
  lastError: string | null;
  createdAt: Date;
}

export interface EnqueueOptions {
  runAt?: Date;
  dedupKey?: string;
  maxAttempts?: number;
}

export type JobOutcome = { outcome: "done" | "noop"; note?: string } | void;
export interface JobContext {
  now: Date;
  /** When set by the runner: the handler should finish (or give up) before this instant. */
  deadline?: Date;
}
export type JobHandler = (job: Job, ctx: JobContext) => Promise<JobOutcome>;
export type JobHandlers = Record<string, JobHandler>;

/**
 * Thrown by a handler that cannot run YET for reasons that are not a failure
 * of the job (e.g. a provider's global concurrency limit is reached, or the
 * runner has too little time left). The job is re-queued after `delayMs`
 * WITHOUT consuming an attempt. Handlers must only defer for conditions that
 * clear on their own, otherwise the job never finishes.
 */
export class JobDeferredError extends Error {
  readonly delayMs: number;
  constructor(delayMs: number, message = "deferred") {
    super(message);
    this.name = "JobDeferredError";
    this.delayMs = Number.isFinite(delayMs) ? Math.min(6 * 3600_000, Math.max(0, Math.round(delayMs))) : 60_000;
  }
}

export interface RunJobsOptions {
  limit?: number;
  workerId?: string;
  /** Only claim these kinds. */
  kinds?: string[];
  /** Never claim kinds starting with any of these prefixes (e.g. "catalog."). */
  excludeKindPrefixes?: string[];
  /** Passed to handlers as ctx.deadline. */
  deadline?: Date;
}

const LOCK_TIMEOUT_SEC = 300;

export async function enqueueJob(
  tx: Tx | null,
  kind: string,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<{ id: number | null; deduped: boolean }> {
  const run = async (t: Tx) => {
    const rows = await t<{ id: number }[]>`
      insert into public.jobs (kind, payload, run_at, dedup_key, max_attempts)
      values (${kind}, ${t.json(payload as JsonValue)}, ${opts.runAt ?? new Date()}::timestamptz,
              ${opts.dedupKey ?? null}, ${opts.maxAttempts ?? 5})
      on conflict (dedup_key) where dedup_key is not null do nothing
      returning id`;
    return rows.length ? { id: rows[0].id, deduped: false } : { id: null, deduped: true };
  };
  return tx ? run(tx) : withSystem(run);
}

/** Cancel queued (not yet running) jobs whose dedup key starts with prefix. */
export async function cancelQueuedJobs(tx: Tx, dedupKeyPrefix: string): Promise<number> {
  const rows = await tx`
    update public.jobs set status = 'cancelled', finished_at = now(), last_error = 'cancelled: superseded'
    where status = 'queued' and dedup_key like ${dedupKeyPrefix.replace(/[%_]/g, "\\$&") + "%"}
    returning id`;
  return rows.length;
}

export function backoffSeconds(attempts: number): number {
  const base = Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** LIKE patterns matching kinds that start with each prefix (metacharacters escaped). */
function prefixPatterns(prefixes: string[] | undefined): string[] {
  return (prefixes ?? []).filter((p) => typeof p === "string" && p.length > 0).map((p) => p.replace(/[\\%_]/g, "\\$&") + "%");
}

export async function claimDueJobs(limit: number, workerId: string, kinds?: string[], excludeKindPrefixes?: string[]): Promise<Job[]> {
  const excluded = prefixPatterns(excludeKindPrefixes);
  return sql()<Job[]>`
    update public.jobs j
    set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = j.attempts + 1
    where j.id in (
      select id from public.jobs
      where (
        (status = 'queued' and run_at <= now())
        or (status = 'running' and locked_at < now() - make_interval(secs => ${LOCK_TIMEOUT_SEC}))
      )
      ${kinds?.length ? sql()`and kind = any(${kinds}::text[])` : sql()``}
      ${excluded.length ? sql()`and not (kind like any(${excluded}::text[]))` : sql()``}
      order by run_at
      for update skip locked
      limit ${limit}
    )
    returning j.*`;
}

async function markSucceeded(job: Job, note?: string) {
  await sql()`
    update public.jobs set status = 'succeeded', finished_at = now(), locked_at = null,
      last_error = ${note ?? null}
    where id = ${job.id} and status = 'running'`;
}

async function markFailed(job: Job, error: string) {
  const dead = job.attempts >= job.maxAttempts;
  const delay = backoffSeconds(job.attempts);
  await sql()`
    update public.jobs set
      status = ${dead ? "dead" : "queued"},
      run_at = case when ${dead}::boolean then run_at else now() + make_interval(secs => ${delay}) end,
      finished_at = case when ${dead}::boolean then now() else null end,
      locked_at = null,
      last_error = ${error.slice(0, 2000)}
    where id = ${job.id}`;
}

/** Re-queue a deferred job without consuming the attempt claimDueJobs counted. */
async function markDeferred(job: Job, delayMs: number, message: string) {
  await sql()`
    update public.jobs set
      status = 'queued',
      run_at = now() + make_interval(secs => ${delayMs / 1000}),
      attempts = greatest(0, attempts - 1),
      locked_at = null,
      last_error = ${`deferred: ${message}`.slice(0, 2000)}
    where id = ${job.id} and status = 'running'`;
}

export interface RunSummary {
  claimed: number;
  succeeded: number;
  noop: number;
  retried: number;
  dead: number;
  /** Re-queued by JobDeferredError (no attempt consumed). */
  deferred: number;
}

export async function runDueJobs(handlers: JobHandlers, opts: RunJobsOptions = {}): Promise<RunSummary> {
  const workerId = opts.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const jobs = await claimDueJobs(opts.limit ?? 25, workerId, opts.kinds, opts.excludeKindPrefixes);
  const summary: RunSummary = { claimed: jobs.length, succeeded: 0, noop: 0, retried: 0, dead: 0, deferred: 0 };
  for (const job of jobs) {
    const handler = handlers[job.kind];
    if (!handler) {
      await sql()`update public.jobs set status = 'dead', finished_at = now(), last_error = 'no handler registered' where id = ${job.id}`;
      summary.dead++;
      log.error("job.no_handler", { jobId: job.id, kind: job.kind });
      continue;
    }
    try {
      const result = await handler(job, { now: new Date(), deadline: opts.deadline });
      await markSucceeded(job, result?.note);
      if (result?.outcome === "noop") summary.noop++;
      else summary.succeeded++;
    } catch (err) {
      if (err instanceof JobDeferredError) {
        await markDeferred(job, err.delayMs, err.message);
        summary.deferred++;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      await markFailed(job, message);
      if (job.attempts >= job.maxAttempts) summary.dead++;
      else summary.retried++;
      log.warn("job.failed", { jobId: job.id, kind: job.kind, attempts: job.attempts, error: message });
    }
  }
  return summary;
}

/** Operator action: re-queue a dead/failed/cancelled job now. */
export async function retryJob(tx: Tx, jobId: number): Promise<boolean> {
  const rows = await tx`
    update public.jobs set status = 'queued', run_at = now(), finished_at = null,
      max_attempts = greatest(max_attempts, attempts + 1)
    where id = ${jobId} and status in ('dead', 'failed', 'cancelled')
    returning id`;
  return rows.length > 0;
}
