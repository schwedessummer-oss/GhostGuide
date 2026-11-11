import "server-only";
import { withSystem, type JsonValue } from "@/server/db";

/**
 * Job-runner heartbeat. Check-in reminders and overdue notices depend on the
 * runner being invoked about once a minute (Supabase pg_cron or Vercel Pro
 * cron; see docs/DEPLOYMENT.md). Every run records a heartbeat so operators
 * and customers can be told honestly when background checks are delayed.
 */
const KEY = "job_runner_heartbeat";
export const RUNNER_STALE_AFTER_MIN = 5;

export async function recordRunnerHeartbeat(summary: Record<string, number>) {
  const value = { at: new Date().toISOString(), summary };
  await withSystem(
    (tx) => tx`
      insert into public.app_settings (key, value, description)
      values (${KEY}, ${tx.json(value as JsonValue)}, 'Last background job runner invocation (written by the runner)')
      on conflict (key) do update set value = excluded.value, updated_at = now()`,
  );
}

export interface RunnerHealth {
  lastRunAt: Date | null;
  minutesSinceRun: number | null;
  /** true when the runner has not run within RUNNER_STALE_AFTER_MIN minutes (or never) */
  stale: boolean;
}

export async function getRunnerHealth(now = new Date()): Promise<RunnerHealth> {
  const [row] = await withSystem((tx) => tx<{ value: { at?: string } }[]>`select value from public.app_settings where key = ${KEY}`);
  const at = row?.value?.at ? new Date(row.value.at) : null;
  if (!at || Number.isNaN(at.getTime())) return { lastRunAt: null, minutesSinceRun: null, stale: true };
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  return { lastRunAt: at, minutesSinceRun: minutes, stale: minutes > RUNNER_STALE_AFTER_MIN };
}
