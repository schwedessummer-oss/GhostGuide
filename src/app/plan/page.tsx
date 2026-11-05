import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Container, PageHeader } from "@/components/ui";
import { PlanForm } from "@/components/discover/plan-form";
import { getLaunchRegion, getTrailBySlug } from "@/server/catalog/trails";
import { defaultPlanValues, hasPlanInput, type RawParams } from "@/server/discover/preferences";
import { localDateInZone } from "@/lib/time";

export const metadata: Metadata = {
  title: "Plan your hike",
  description: "Tell us about your experience, time and needs, and get ranked trail suggestions with a personalized itinerary.",
};

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function PlanPage({ searchParams }: PageProps<"/plan">) {
  const raw = (await searchParams) as RawParams;
  const region = await getLaunchRegion();
  const today = localDateInZone(new Date(), region.timezone);
  const slug = firstParam(raw.trail);
  const focus = slug && /^[a-z0-9-]{1,80}$/.test(slug) ? await getTrailBySlug(slug) : null;
  // First visit: sensible defaults. Returning via "Edit answers": the answers in the URL.
  const values: RawParams = hasPlanInput(raw) ? raw : { ...defaultPlanValues(today), ...raw };

  return (
    <Container className="max-w-4xl py-10">
      <PageHeader
        eyebrow="Personalize"
        title="Plan your hike"
        description="A few questions so we can rank trails for you, estimate your timing, and show exactly why each trail fits or doesn't."
      />
      {focus ? (
        <Alert tone="blue" className="mb-6" title={`We'll check ${focus.name} first`}>
          Your results will show whether{" "}
          <Link href={`/trails/${focus.slug}`} className="font-semibold underline">
            {focus.name}
          </Link>{" "}
          fits your answers, alongside other suggestions.
        </Alert>
      ) : slug ? (
        <Alert tone="amber" className="mb-6">
          We couldn&apos;t find the trail you linked to, so we&apos;ll suggest trails from the whole catalog.
        </Alert>
      ) : null}
      {region.isDemo ? (
        <p className="mb-6 text-sm text-muted">
          Demo region: {region.name}. Trails are fictional; suggestions demonstrate how planning works and are not advice for a real hike.
        </p>
      ) : null}
      <PlanForm values={values} errors={{}} today={today} focusTrail={focus ? { slug: focus.slug, name: focus.name } : null} />
    </Container>
  );
}
