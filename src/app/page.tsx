import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, BellRing, Compass, Download, Headphones, Info, ShieldCheck, SlidersHorizontal, Ticket } from "lucide-react";
import { ButtonLink, Container } from "@/components/ui";
import { HeroArt } from "@/components/discover/hero-art";
import { TrailCard, type TrailCardData } from "@/components/discover/trail-card";
import { getLaunchRegion, listTrails } from "@/server/catalog/trails";
import { log } from "@/server/log";

export const metadata: Metadata = {
  title: { absolute: "Ghost Guide — personalized self-guided hikes with an audio companion" },
  description:
    "Discover a hike, get a personalized itinerary, purchase a self-guided experience, download your trip info, and hike with GPS-triggered audio narration and optional check-ins.",
};

/** Buttons on dark forest backgrounds (the shared variants assume light backgrounds). */
const LIGHT_BUTTON =
  "inline-flex min-h-13 items-center justify-center gap-2 rounded-xl bg-white px-6 py-3 text-base font-semibold text-forest-900 transition-colors hover:bg-forest-50 active:bg-forest-100";
const OUTLINE_BUTTON =
  "inline-flex min-h-13 items-center justify-center gap-2 rounded-xl px-6 py-3 text-base font-semibold text-white ring-1 ring-white/60 transition-colors hover:bg-white/10";

const STEPS = [
  {
    icon: Compass,
    title: "Discover a hike",
    body: "Browse trails by distance, climbing, terrain, accessibility and dog policy, with sources and freshness shown for every fact.",
  },
  {
    icon: SlidersHorizontal,
    title: "Get a personalized itinerary",
    body: "Tell us your experience, pace, time and needs. Clear rules rank the trails, explain why, and build a timed plan with a turnaround time.",
  },
  {
    icon: Ticket,
    title: "Purchase a self-guided experience",
    body: "Book your date with transparent pricing and optional add-ons such as gear lockers or a shuttle.",
  },
  {
    icon: Download,
    title: "Download your trip",
    body: "Save the route, stops and narration to your phone before you leave, because signal on trails is unreliable.",
  },
  {
    icon: Headphones,
    title: "Hike with audio narration",
    body: "Stories and tips play when your phone's GPS reports you near a stop. Keep the companion open: background GPS and locked-screen audio aren't guaranteed on every phone.",
  },
  {
    icon: BellRing,
    title: "Optional check-ins",
    body: "Set an expected return time. If we don't receive your confirmation, we notify the contact you chose. That is not an emergency service.",
  },
] as const;

async function featuredTrails(): Promise<{ trails: TrailCardData[]; regionName: string | null }> {
  try {
    const region = await getLaunchRegion();
    const trails = await listTrails(region.id);
    const open = trails.filter((t) => t.status === "published" && !t.activeClosures.some((c) => c.severity === "closed"));
    const order = ["easy", "moderate", "hard", "strenuous"];
    // One of each difficulty first, for variety.
    const picked: TrailCardData[] = [];
    for (const d of order) {
      const t = open.find((x) => x.difficulty === d && !picked.includes(x));
      if (t) picked.push(t);
    }
    return { trails: picked.slice(0, 3), regionName: region.name };
  } catch (err) {
    log.warn("landing.featured_trails_failed", { error: err instanceof Error ? err.message : String(err) });
    return { trails: [], regionName: null };
  }
}

export default async function HomePage() {
  const { trails, regionName } = await featuredTrails();
  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-b from-forest-900 via-forest-800 to-forest-700 text-white">
        <HeroArt className="pointer-events-none absolute inset-x-0 bottom-0 h-[60%] w-full sm:h-[70%]" />
        <Container className="relative pt-14 pb-40 sm:pt-20 sm:pb-56">
          <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-sm font-semibold ring-1 ring-white/20">
            <Headphones aria-hidden className="size-4" /> Self-guided hikes with an audio companion
          </p>
          <h1 className="mt-5 max-w-3xl text-4xl font-bold leading-tight sm:text-5xl lg:text-6xl">
            Your hike, planned around you. Your guide, in your pocket.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-forest-100 sm:text-xl">
            Ghost Guide helps you choose a trail that fits your time, pace and needs, builds a personal itinerary, and narrates the stories of the
            trail as you walk.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/plan" className={LIGHT_BUTTON}>
              Plan my hike <ArrowRight aria-hidden className="size-5" />
            </Link>
            <Link href="/trails" className={OUTLINE_BUTTON}>
              Browse trails
            </Link>
          </div>
          <p className="mt-6 max-w-2xl text-sm text-forest-100">
            <Info aria-hidden className="mr-1 inline size-4" />
            This is a demo: {regionName ?? "the Ghost Ridge demo region"} and every trail in it are fictional.
          </p>
        </Container>
      </section>

      <section aria-labelledby="how-heading" className="py-16">
        <Container>
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-wide text-forest-700">How it works</p>
            <h2 id="how-heading" className="mt-2 text-3xl font-bold">
              From “where should we go?” to the trailhead
            </h2>
          </div>
          <ol className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative rounded-[var(--radius-card)] border border-sand-200 bg-surface p-6">
                <div className="flex items-center gap-3">
                  <span className="inline-flex size-11 items-center justify-center rounded-xl bg-forest-100 text-forest-800">
                    <s.icon aria-hidden className="size-6" />
                  </span>
                  <span className="text-sm font-semibold text-muted">Step {i + 1}</span>
                </div>
                <h3 className="mt-4 text-lg font-bold">{s.title}</h3>
                <p className="mt-2 text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      <section aria-labelledby="honest-heading" className="bg-sand-100 py-16">
        <Container className="grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:items-center">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-forest-700">Straight talk</p>
            <h2 id="honest-heading" className="mt-2 text-3xl font-bold">
              What Ghost Guide is, and isn&apos;t
            </h2>
            <p className="mt-4 text-lg text-muted">
              We&apos;d rather you know the limits up front. Every suggestion shows its reasons, every fact shows its source and age, and anything
              simulated is labeled.
            </p>
            <ButtonLink href="/how-it-works" variant="secondary" className="mt-6">
              Read how it works & its limitations
            </ButtonLink>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2">
            {[
              ["Not an emergency service", "We don't monitor you continuously and can't contact 911 or Search and Rescue for you. In an emergency, call 911."],
              ["Estimates, not promises", "Durations, finish and turnaround times are estimates from published rules. Conditions change."],
              ["AI explains, never decides", "Optional AI text only explains the checks we already ran. It never picks routes, permits or safety calls."],
              ["Demo data is labeled", "This demo region, its trails and stories are fictional. Payments, partners and notifications are simulated."],
            ].map(([title, body]) => (
              <li key={title} className="rounded-[var(--radius-card)] bg-surface p-5">
                <p className="flex items-center gap-2 font-bold">
                  <ShieldCheck aria-hidden className="size-5 text-forest-700" /> {title}
                </p>
                <p className="mt-2 text-[0.95rem] text-muted">{body}</p>
              </li>
            ))}
          </ul>
        </Container>
      </section>

      {trails.length ? (
        <section aria-labelledby="featured-heading" className="py-16">
          <Container>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-sm font-semibold uppercase tracking-wide text-forest-700">{regionName}</p>
                <h2 id="featured-heading" className="mt-2 text-3xl font-bold">
                  Trails to explore
                </h2>
              </div>
              <Link href="/trails" className="inline-flex min-h-11 items-center gap-1 font-semibold text-forest-800 underline-offset-2 hover:underline">
                See all trails <ArrowRight aria-hidden className="size-4" />
              </Link>
            </div>
            <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {trails.map((t) => (
                <li key={t.slug}>
                  <TrailCard trail={t} />
                </li>
              ))}
            </ul>
          </Container>
        </section>
      ) : null}

      <section className="pb-16">
        <Container>
          <div className="flex flex-col items-start gap-5 rounded-[var(--radius-card)] bg-forest-800 p-8 text-white sm:flex-row sm:items-center sm:justify-between sm:p-10">
            <div>
              <h2 className="text-2xl font-bold">Not sure where to start?</h2>
              <p className="mt-2 text-forest-100">Answer a few questions and we&apos;ll show you which trails fit, and which don&apos;t, and why.</p>
            </div>
            <Link href="/plan" className={`${LIGHT_BUTTON} shrink-0`}>
              Plan my hike
            </Link>
          </div>
        </Container>
      </section>
    </>
  );
}
