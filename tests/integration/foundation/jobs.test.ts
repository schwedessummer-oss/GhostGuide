import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb, sql, withSystem } from "@/server/db";
import { cancelQueuedJobs, enqueueJob, runDueJobs, retryJob } from "@/server/jobs/queue";
import { bucketKey } from "@/server/jobs/periodic";

afterAll(closeDb);

const uniqueKind = () => `test.${randomUUID().slice(0, 8)}`;

describe("durable job queue", () => {
  it("deduplicates enqueues with the same key (e.g. webhook redelivery)", async () => {
    const kind = uniqueKind();
    const key = `dedup:${randomUUID()}`;
    const a = await enqueueJob(null, kind, { n: 1 }, { dedupKey: key });
    const b = await enqueueJob(null, kind, { n: 2 }, { dedupKey: key });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    const rows = await sql()`select payload from public.jobs where dedup_key = ${key}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ n: 1 });
  });

  it("never runs the same job twice under concurrent runners", async () => {
    const kind = uniqueKind();
    for (let i = 0; i < 6; i++) await enqueueJob(null, kind, { i });
    const seen: number[] = [];
    const handlers = {
      [kind]: async (job: { payload: Record<string, unknown> }) => {
        seen.push(job.payload.i as number);
        await new Promise((r) => setTimeout(r, 20));
      },
    };
    await Promise.all([
      runDueJobs(handlers, { workerId: "a", kinds: [kind] }),
      runDueJobs(handlers, { workerId: "b", kinds: [kind] }),
      runDueJobs(handlers, { workerId: "c", kinds: [kind] }),
    ]);
    expect(seen.sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("retries failures with backoff and dead-letters after max attempts", async () => {
    const kind = uniqueKind();
    const { id } = await enqueueJob(null, kind, {}, { maxAttempts: 2 });
    const handlers = { [kind]: async () => { throw new Error("partner timeout"); } };
    const s1 = await runDueJobs(handlers, { kinds: [kind] });
    expect(s1.retried).toBe(1);
    let [job] = await sql()`select status, attempts, run_at > now() as delayed, last_error from public.jobs where id = ${id}`;
    expect(job.status).toBe("queued");
    expect(job.delayed).toBe(true);
    expect(job.lastError).toMatch(/partner timeout/);
    // make it due again and fail a second time -> dead
    await sql()`update public.jobs set run_at = now() where id = ${id}`;
    const s2 = await runDueJobs(handlers, { kinds: [kind] });
    expect(s2.dead).toBe(1);
    [job] = await sql()`select status from public.jobs where id = ${id}`;
    expect(job.status).toBe("dead");
    // operator retry re-queues it
    expect(await withSystem((tx) => retryJob(tx, id!))).toBe(true);
    [job] = await sql()`select status from public.jobs where id = ${id}`;
    expect(job.status).toBe("queued");
  });

  it("cancels superseded queued jobs by dedup-key prefix", async () => {
    const kind = uniqueKind();
    const prefix = `checkin:${randomUUID()}:v1:`;
    await enqueueJob(null, kind, {}, { dedupKey: `${prefix}reminder:60`, runAt: new Date(Date.now() + 3600_000) });
    await enqueueJob(null, kind, {}, { dedupKey: `${prefix}overdue`, runAt: new Date(Date.now() + 7200_000) });
    const cancelled = await withSystem((tx) => cancelQueuedJobs(tx, prefix));
    expect(cancelled).toBe(2);
  });

  it("does not run jobs scheduled in the future", async () => {
    const kind = uniqueKind();
    await enqueueJob(null, kind, {}, { runAt: new Date(Date.now() + 60_000) });
    let ran = false;
    const s = await runDueJobs({ [kind]: async () => { ran = true; } }, { kinds: [kind] });
    expect(s.claimed).toBe(0);
    expect(ran).toBe(false);
  });

  it("periodic bucket keys are stable within a bucket", () => {
    const t = new Date("2026-11-05T10:00:30Z");
    expect(bucketKey("x", 5, t)).toBe(bucketKey("x", 5, new Date("2026-11-05T10:04:59Z")));
    expect(bucketKey("x", 5, t)).not.toBe(bucketKey("x", 5, new Date("2026-11-05T10:05:00Z")));
  });
});
