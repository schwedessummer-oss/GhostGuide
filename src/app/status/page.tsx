import { Badge, Card, Container, PageHeader } from "@/components/ui";
import { integrationStatus } from "@/config/env";

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

export default function StatusPage() {
  const status = integrationStatus();
  return (
    <Container className="py-10">
      <PageHeader
        title="Integration status"
        description="Which parts of Ghost Guide are connected to real services in this deployment and which are simulated."
      />
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
