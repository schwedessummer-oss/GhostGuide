import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, BellRing, CloudSun, Map as MapIcon, Route, Search, TriangleAlert } from "lucide-react";
import { Container } from "@/components/ui";
import { TrailCard, type TrailCardData } from "@/components/discover/trail-card";
import { NearMeLink } from "@/components/explore/near-me-link";
import { showDemoFixtures } from "@/config/env";
import { getLaunchRegion, listTrails } from "@/server/catalog/trails";
import { log } from "@/server/log";

export const metadata: Metadata = {
  title: { absolute: "Ghost Guide — find a hike, plan the day, get home safely" },
  description:
    "Real trails from OpenStreetMap with honest distance, climb and time estimates, the forecast and daylight for your hike, and optional check-ins on Ghost Guide trips.",
};

const VALUES = [
  {
    icon: Route,
    title: "Real trails, honest numbers",
    body: "Trails worldwide come from OpenStreetMap. Distance and climb are measured from the mapped route; times and difficulty are clearly marked as estimates.",
  },
  {
    icon: CloudSun,
    title: "Plan the day",
    body: "Each trail page shows the forecast, daylight and a sensible start time, official US weather alerts, and fuel, food and services nearby.",
  },
  {
    icon: BellRing,
    title: "Save trails, set a check-in",
    body: "Keep a list of trails you want to hike. On Ghost Guide trips, set an expected return time and the contact you choose is told if you don’t check in.",
  },
] as const;

async function demoRegionTrails(): Promise<{ trails: TrailCardData[]; regionName: string } | null> {
  if (!showDemoFixtures()) return null;
  try {
    const region = await getLaunchRegion();
    const trails = (await listTrails(region.id)).filter((t) => t.status === "published");
    return { trails: trails.slice(0, 3), regionName: region.name };
  } catch (err) {
    log.warn("landing.demo_trails_failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Decorative ridgelines (solid fills, no images). */
function Ridges({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1200 240" preserveAspectRatio="xMidYMax slice" aria-hidden focusable="false" className={className}>
      <path d="M0 150 L110 95 L210 130 L330 55 L450 120 L560 75 L670 125 L790 45 L910 115 L1020 80 L1120 120 L1200 95 L1200 240 L0 240 Z" fill="#2a5a3e" opacity="0.55" />
      <path d="M0 190 L95 150 L200 178 L310 130 L430 172 L545 138 L655 182 L770 140 L890 186 L1005 150 L1110 182 L1200 160 L1200 240 L0 240 Z" fill="#1f4630" />
      <path d="M0 240 L0 214 Q220 186 430 208 T840 202 T1200 196 L1200 240 Z" fill="#173524" />
      <path d="M150 240 C260 214 330 204 430 206 S600 214 690 200 S860 184 960 190" fill="none" stroke="#e7dfd0" strokeWidth="4" strokeLinecap="round" strokeDasharray="2 13" opacity="0.8" />
    </svg>
  );
}

export default async function HomePage() {
  const demo = await demoRegionTrails();
  return (
    <>
      <section className="relative overflow-hidden bg-forest-900 text-white">
        <Ridges className="pointer-events-none absolute inset-x-0 bottom-0 h-40 w-full sm:h-52" />
        <Container className="relative pt-12 pb-44 sm:pt-20 sm:pb-60">
          <h1 className="max-w-3xl text-4xl leading-[1.1] font-bold tracking-tight sm:text-5xl lg:text-6xl">
            Find a hike. Plan the day. Get home safely.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-forest-100 sm:text-xl">
            Real trails with honest numbers, the forecast and daylight for your hike, and check-ins for the trips that need them.
          </p>

          <form action="/explore" method="get" role="search" className="mt-8 flex max-w-xl flex-col gap-2 sm:flex-row">
            <label htmlFor="home-q" className="sr-only">
              Where do you want to hike?
            </label>
            <div className="flex min-h-13 flex-1 items-center gap-2 rounded-xl bg-white px-4 text-ink focus-within:ring-3 focus-within:ring-forest-500">
              <Search aria-hidden className="size-5 shrink-0 text-muted" />
              <input
                id="home-q"
                name="q"
                type="search"
                required
                minLength={2}
                maxLength={120}
                enterKeyHint="search"
                autoComplete="off"
                placeholder="Town, park or mountain"
                className="min-h-13 w-full bg-transparent text-base placeholder:text-muted/80 focus:outline-none focus-visible:outline-none"
              />
            </div>
            <button type="submit" className="inline-flex min-h-13 items-center justify-center gap-2 rounded-xl bg-[#e7dfd0] px-6 font-semibold text-forest-950 hover:bg-white">
              Find trails <ArrowRight aria-hidden className="size-5" />
            </button>
          </form>

          <div className="mt-4 flex flex-wrap items-start gap-x-2 gap-y-2">
            <NearMeLink
              className="min-h-11 rounded-xl px-4 font-semibold text-white ring-1 ring-white/50 hover:bg-white/10 disabled:opacity-70"
              messageClassName="max-w-sm text-forest-100"
            />
            <Link href="/explore" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-4 font-semibold text-white hover:bg-white/10">
              <MapIcon aria-hidden className="size-5" /> Explore the map
            </Link>
          </div>
        </Container>
      </section>

      <section aria-labelledby="values-heading" className="py-14 sm:py-20">
        <Container>
          <h2 id="values-heading" className="sr-only">
            What Ghost Guide does today
          </h2>
          <ul className="grid gap-10 sm:grid-cols-3 sm:gap-8">
            {VALUES.map((v) => (
              <li key={v.title}>
                <span className="inline-flex size-11 items-center justify-center rounded-xl bg-forest-100 text-forest-800">
                  <v.icon aria-hidden className="size-6" />
                </span>
                <h3 className="mt-4 text-lg font-bold text-ink">{v.title}</h3>
                <p className="mt-2 text-muted">{v.body}</p>
              </li>
            ))}
          </ul>
          <p className="mt-12 border-t border-sand-200 pt-6 text-sm text-muted">
            Ghost Guide is not an emergency service. Conditions change and mapped data can be incomplete: check with the land manager and official
            sources before you go.{" "}
            <Link href="/how-it-works" className="font-semibold text-forest-800 underline underline-offset-2">
              How it works &amp; its limits
            </Link>
          </p>
        </Container>
      </section>

      {demo && demo.trails.length ? (
        <section aria-labelledby="demo-heading" className="border-t border-sand-200 bg-sand-100 py-14">
          <Container>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="max-w-2xl">
                <p className="inline-flex items-center gap-1.5 rounded-full bg-amber-bg px-3 py-1 text-sm font-semibold text-amber-ink ring-1 ring-[#f1d9b0]">
                  <TriangleAlert aria-hidden className="size-4" /> Development fixtures
                </p>
                <h2 id="demo-heading" className="mt-3 text-2xl font-bold">
                  Demo region (fictional): {demo.regionName}
                </h2>
                <p className="mt-2 text-muted">
                  These trails do not exist. They demonstrate trip planning, booking, offline download and audio narration, and are not for
                  navigation.
                </p>
              </div>
              <Link href="/trails" className="inline-flex min-h-11 items-center gap-1 font-semibold text-forest-800 underline-offset-2 hover:underline">
                All demo trails <ArrowRight aria-hidden className="size-4" />
              </Link>
            </div>
            <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {demo.trails.map((t) => (
                <li key={t.slug}>
                  <TrailCard trail={t} />
                </li>
              ))}
            </ul>
          </Container>
        </section>
      ) : null}
    </>
  );
}
