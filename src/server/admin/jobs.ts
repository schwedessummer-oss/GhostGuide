import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import { retryJob } from "@/server/jobs/queue";
import { redact, redactString } from "@/server/log";
import { assertCan, auditInSystemTx, fail, guarded, ok, staffTx, systemTx, type ActionResult, type Page, type Paged } from "./common";

/**
 * Retry queue and integration health. `jobs` and `webhook_events` are
 * server-only tables (no API-role access), so they are read and written as
 * trusted code after the permission check; integration_events is read under
 * RLS.
 */
export const JOB_STATUSES = ["dead", "failed", "queued", "running", "succeeded", "cancelled"] as const;

export interface JobRow {
  id: number;
  kind: string;
  status: (typeof JOB_STATUSES)[number];
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lastError: string | null;
  dedupKey: string | null;
  payloadPreview: string;
  updatedAt: Date;
  finishedAt: Date | null;
}

export async function listJobs(user: SessionUser, f: { status?: string; kind?: string }, page: Page): Promise<Paged<JobRow> & { kinds: string[]; counts: Record<string, number> }> {
  assertCan(user, "jobs.manage");
  const status = z.enum(JOB_STATUSES).safeParse(f.status).data ?? null;
  const kind = typeof f.kind === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(f.kind) ? f.kind : null;
  return systemTx(async (tx) => {
    const rows = await tx<(JobRow & { payload: unknown; total: number })[]>`
      select id, kind, status, attempts, max_attempts, run_at, last_error, dedup_key, payload, updated_at, finished_at,
             count(*) over()::int as total
      from public.jobs
      where (${status}::public.job_status is null or status = ${status}::public.job_status)
        and (${kind}::text is null or kind = ${kind}::text)
      order by case status when 'dead' then 0 when 'failed' then 1 when 'running' then 2 when 'queued' then 3 else 4 end, updated_at desc
      limit ${page.limit} offset ${page.offset}`;
    const kinds = (await tx<{ kind: string }[]>`select distinct kind from public.jobs order by kind limit 200`).map((r) => r.kind);
    const countRows = await tx<{ status: string; n: number }[]>`select status, count(*)::int as n from public.jobs group by status`;
    return {
      rows: rows.map(({ payload, total: _total, ...r }) => {
        void _total;
        return { ...r, lastError: r.lastError ? redactString(r.lastError) : null, payloadPreview: JSON.stringify(redact(payload)).slice(0, 300) };
      }),
      total: rows[0]?.total ?? 0,
      ...page,
      kinds,
      counts: Object.fromEntries(countRows.map((c) => [c.status, c.n])),
    };
  });
}

/** Re-queue a dead/failed/cancelled job now (operator retry). */
export async function retryJobAsStaff(user: SessionUser, jobId: unknown): Promise<ActionResult> {
  assertCan(user, "jobs.manage");
  const id = z.coerce.number().int().positive().safeParse(jobId);
  if (!id.success) return fail("Job not found.");
  return guarded(() =>
    systemTx(async (tx) => {
      const [job] = await tx<{ kind: string; status: string; attempts: number }[]>`select kind, status, attempts from public.jobs where id = ${id.data} for update`;
      if (!job) return fail("Job not found.");
      const retried = await retryJob(tx, id.data);
      if (!retried) return fail(`Only dead, failed or cancelled jobs can be retried (this one is ${job.status}).`);
      await auditInSystemTx(tx, user, "job.retried", "job", String(id.data), { kind: job.kind, from: job.status, attempts: job.attempts });
      return ok(`Job #${id.data} (${job.kind}) re-queued. Its handler re-checks current state before acting.`);
    }),
  );
}

/** Cancel a queued/failed job, or dismiss a dead one. Running jobs cannot be cancelled. */
export async function cancelJobAsStaff(user: SessionUser, jobId: unknown): Promise<ActionResult> {
  assertCan(user, "jobs.manage");
  const id = z.coerce.number().int().positive().safeParse(jobId);
  if (!id.success) return fail("Job not found.");
  return guarded(() =>
    systemTx(async (tx) => {
      const [job] = await tx<{ kind: string; status: string }[]>`select kind, status from public.jobs where id = ${id.data} for update`;
      if (!job) return fail("Job not found.");
      if (!["queued", "failed", "dead"].includes(job.status)) return fail(`A ${job.status} job cannot be cancelled.`);
      await tx`
        update public.jobs set status = 'cancelled', finished_at = now(), locked_at = null,
          last_error = coalesce(last_error, '') || ${` [cancelled by staff ${new Date().toISOString()}]`}
        where id = ${id.data}`;
      await auditInSystemTx(tx, user, "job.cancelled", "job", String(id.data), { kind: job.kind, from: job.status });
      return ok(`Job #${id.data} cancelled.`);
    }),
  );
}

// ---------------------------------------------------------------------------
// Integration health
// ---------------------------------------------------------------------------
export interface IntegrationEventRow {
  id: number;
  providerKind: string;
  providerKey: string;
  operation: string;
  outcome: "success" | "failure" | "simulated";
  entityType: string | null;
  entityId: string | null;
  error: string | null;
  durationMs: number | null;
  createdAt: Date;
}

export async function listIntegrationEvents(user: SessionUser, f: { outcome?: string; kind?: string }, page: Page): Promise<Paged<IntegrationEventRow>> {
  assertCan(user, "integrations.view");
  const outcome = z.enum(["success", "failure", "simulated"]).safeParse(f.outcome).data ?? null;
  const kind = typeof f.kind === "string" && /^[a-z_]{1,40}$/.test(f.kind) ? f.kind : null;
  const rows = await staffTx(user, (tx) => tx<(IntegrationEventRow & { total: number })[]>`
    select id, provider_kind, provider_key, operation, outcome, entity_type, entity_id, error, duration_ms, created_at,
           count(*) over()::int as total
    from public.integration_events
    where (${outcome}::text is null or outcome = ${outcome}::text) and (${kind}::text is null or provider_kind = ${kind}::text)
    order by created_at desc
    limit ${page.limit} offset ${page.offset}`);
  return { rows, total: rows[0]?.total ?? 0, ...page };
}

export async function integrationSummary(user: SessionUser): Promise<{ providerKind: string; outcome: string; n: number; lastAt: Date }[]> {
  assertCan(user, "integrations.view");
  return staffTx(user, (tx) => tx<{ providerKind: string; outcome: string; n: number; lastAt: Date }[]>`
    select provider_kind, outcome, count(*)::int as n, max(created_at) as last_at
    from public.integration_events where created_at > now() - interval '24 hours'
    group by provider_kind, outcome order by provider_kind, outcome`);
}

export interface WebhookRow {
  id: string;
  provider: string;
  eventId: string;
  type: string;
  status: string;
  attempts: number;
  error: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}

export async function listFailedWebhooks(user: SessionUser, page: Page): Promise<Paged<WebhookRow>> {
  assertCan(user, "integrations.view");
  const rows = await systemTx((tx) => tx<(WebhookRow & { total: number })[]>`
    select id, provider, event_id, type, status, attempts, error, received_at, processed_at, count(*) over()::int as total
    from public.webhook_events where status = 'failed'
    order by received_at desc limit ${page.limit} offset ${page.offset}`);
  return { rows: rows.map((r) => ({ ...r, error: r.error ? redactString(r.error) : null })), total: rows[0]?.total ?? 0, ...page };
}
