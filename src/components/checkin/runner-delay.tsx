import { Alert } from "@/components/ui";
import type { RunnerHealth } from "@/server/jobs/health";

/**
 * Honest warning when the background job runner (reminders, overdue checks,
 * notices) has not run recently (getRunnerHealth().stale): check-ins still
 * work, but notices may go out late. Renders nothing while the runner is healthy.
 */
export function RunnerDelayNotice({ health }: { health: RunnerHealth }) {
  if (!health.stale) return null;
  const since =
    health.minutesSinceRun != null
      ? `haven't run for ${health.minutesSinceRun >= 120 ? `about ${Math.round(health.minutesSinceRun / 60)} hours` : `${health.minutesSinceRun} minutes`}`
      : "haven't run recently";
  return (
    <Alert tone="amber" title="Background checks are delayed right now; notices may be late">
      Ghost Guide&apos;s background checks {since}, so reminders to you and a notice to your contact could go out later than planned. Your
      check-in is saved and will be processed when they resume. Please also tell someone you trust where you&apos;re going and when you&apos;ll be
      back.
    </Alert>
  );
}
