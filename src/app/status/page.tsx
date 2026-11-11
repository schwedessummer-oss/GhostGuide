import { Badge, Card, Container, PageHeader } from "@/components/ui";
import { integrationStatus } from "@/config/env";
import { getRunnerHealth, RUNNER_STALE_AFTER_MIN } from "@/server/jobs/health";
import { formatAge } from "@/lib/format";

export const metadata = { title: "Integration status" };
export const dynamic = "force-dynamic";

const LABELS: Record<string, string> = {
  mode: "App mode",
  auth: "Authentication",
  storage: "File storage",
  payments: "Payments",
  maps: "Maps",
  ai: "AI explanations",
  notifications: "Check-in notifications",
  weather: "Weather",
  partners: "Partner services (lockers, shuttle, meals, satellite rental)",
};

export default async function StatusPage() {
  const status = integrationStatus();
  const runner = await getRunnerHealth();
  return (
    <Container className="py-10">
      <PageHeader
        title="Integration status"
        description="Which parts of Ghost Guide are connected to real services in this deployment and which are simulated."
      />
      <Card className="mb-6">
        <h2 className="text-lg font-bold">Background checks</h2>
        <p className="mt-1 text-[0.95rem] text-muted">
          Check-in reminders and overdue notices are sent by a background job runner that should run about once a minute.
        </p>
        <p className="mt-3 flex flex-wrap items-center gap-2">
          <Badge tone={runner.stale ? "red" : "forest"}>{runner.stale ? "Delayed" : "Running"}</Badge>
          <span>
            {runner.lastRunAt
              ? `Last run ${formatAge(runner.lastRunAt)}.`
              : "The job runner has not run yet in this deployment."}
            {runner.stale ? ` Notices may be late until it runs again (expected at least every ${RUNNER_STALE_AFTER_MIN} minutes).` : ""}
          </span>
        </p>
      </Card>
      <Card>
        <dl className="divide-y divide-sand-200">
          {Object.entries(status).map(([key, value]) => (
            <div key={key} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <dt className="font-semibold">{LABELS[key] ?? key}</dt>
              <dd>
                <Badge tone={/^live/.test(value) ? "forest" : value === "demo" || /simulated|local|offline/.test(value) ? "amber" : "neutral"}>
                  {value}
                </Badge>
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </Container>
  );
}
