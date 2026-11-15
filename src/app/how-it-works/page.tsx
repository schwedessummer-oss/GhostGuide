import type { Metadata } from "next";
import { Bookmark, CloudSun, Compass, Database, ShieldCheck } from "lucide-react";
import { Card, Container, PageHeader } from "@/components/ui";

export const metadata: Metadata = {
  title: "How it works & limitations",
  description: "How Ghost Guide finds trails, where its data comes from, what its estimates mean and what it cannot do.",
};

const STEPS = [
  {
    icon: Compass,
    title: "Find a hike",
    body: "Search a town, park or mountain, or use your location. Trails come from OpenStreetMap and show on a map and in a list you can filter.",
  },
  {
    icon: CloudSun,
    title: "Plan the day",
    body: "Each trail page shows distance and climb measured from the mapped route, an estimated time, the forecast, daylight and services nearby.",
  },
  {
    icon: Bookmark,
    title: "Save it for later",
    body: "Sign in to keep a list of trails you want to hike.",
  },
];

export default function HowItWorksPage() {
  return (
    <Container className="max-w-4xl py-10">
      <PageHeader
        eyebrow="How it works"
        title="Find a hike and plan the day"
        description="What Ghost Guide does, where its data comes from, and what it can't do."
      />

      <section aria-labelledby="steps-heading">
        <h2 id="steps-heading" className="sr-only">
          Steps
        </h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-2xl border border-sand-200 bg-surface p-5">
              <p className="flex items-center gap-2 font-semibold text-forest-800">
                <s.icon aria-hidden className="size-5" /> {i + 1}. {s.title}
              </p>
              <p className="mt-1 text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <Card className="mt-8" aria-labelledby="data-heading">
        <h2 id="data-heading" className="flex items-center gap-2 text-2xl font-bold">
          <Database aria-hidden className="size-6" /> Where the data comes from
        </h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-[0.98rem]">
          <li>Trails, trailheads and nearby places come from OpenStreetMap contributors. Mapped data can be incomplete or out of date.</li>
          <li>Distance and climb are measured from the mapped route and elevation tiles. Times and difficulty are estimates, not promises.</li>
          <li>Forecasts come from MET Norway; official weather alerts in the US come from the National Weather Service.</li>
          <li>Every trail page lists its sources.</li>
        </ul>
      </Card>

      <Card className="mt-6" aria-labelledby="limits-heading">
        <h2 id="limits-heading" className="flex items-center gap-2 text-2xl font-bold">
          <ShieldCheck aria-hidden className="size-6" /> Limitations
        </h2>
        <ul className="mt-3 space-y-3 text-[0.98rem]">
          <li>
            <strong>Ghost Guide is not an emergency service.</strong> It does not track or monitor you and cannot contact Search and Rescue. In an
            emergency, call your local emergency number.
          </li>
          <li>
            <strong>Check before you go.</strong> Closures, permits, fees and conditions change. Confirm them with the land manager and official
            sources.
          </li>
          <li>
            <strong>Not for navigation.</strong> Carry a map you can use without signal; cell service is often unavailable on trails.
          </li>
        </ul>
      </Card>
    </Container>
  );
}
