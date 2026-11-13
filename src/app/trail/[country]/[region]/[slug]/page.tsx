import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";
import { ArrowLeft, ExternalLink, MapPin } from "lucide-react";
import { Container } from "@/components/ui";
import { ConditionsPanel } from "@/components/trail/conditions-panel";
import { DirectionsMenu } from "@/components/trail/directions-menu";
import { ElevationProfile } from "@/components/trail/elevation-profile";
import { locationParts } from "@/components/trail/format";
import { NearbyPanel } from "@/components/trail/nearby-panel";
import { PoiList } from "@/components/trail/poi-list";
import { SafetySection } from "@/components/trail/safety-section";
import { SaveTrailButton } from "@/components/trail/save-button";
import { canonicalUrl, serializeJsonLd, trailJsonLd, trailMetaDescription, trailPageTitle } from "@/components/trail/seo";
import { ShareButton } from "@/components/trail/share-button";
import { SourceFooter } from "@/components/trail/source-footer";
import { TrailFacts } from "@/components/trail/trail-facts";
import { TrailMap } from "@/components/trail/trail-map";
import { TrailStats } from "@/components/trail/trail-stats";
import { UnitsToggle } from "@/components/trail/units-toggle";
import { env } from "@/config/env";
import type { TrailDetailDto } from "@/domain/catalog";
import { GENERAL_NOTES, emergencyNumbersFor } from "@/server/safety/emergency-numbers";
import { getTrailDetailByPath } from "@/server/trails/read";
import { findTrailRedirect } from "@/server/trails/redirects";

/**
 * Catalog trail page: /trail/<country>/<region>/<slug>.
 *
 * The HTML holds only public catalog data, identical for every visitor, so it
 * can be cached for an hour (ISR). Per-visitor and fast-changing parts load
 * in the browser: the Save state (server action), conditions and nearby
 * services (public JSON APIs). Units switch in CSS (both are rendered).
 */
export const revalidate = 3600;

type Params = { country: string; region: string; slug: string };

/**
 * No trail is pre-rendered at build time (the catalog loads on demand), but
 * returning a list (even empty) makes each trail page static on its first
 * visit and then cached for `revalidate`. Without it Next.js renders this
 * dynamic route on every request (Cache-Control: private, no-store).
 */
export async function generateStaticParams(): Promise<Params[]> {
  return [];
}

/**
 * How long a path with no trail (a 404, or an old path's redirect) stays
 * cached. Trails load on demand, so a path that 404s now can belong to a
 * trail minutes later; the page's hour would keep serving the 404. Without
 * Cache Components a render is cached for the SHORTEST revalidate of the
 * data it read (unstable_cache included), so only these renders, which read
 * the redirect table, get the short lifetime; trail pages keep the hour.
 */
const NO_TRAIL_REVALIDATE_S = 60;

const loadTrail = cache((country: string, region: string, slug: string) => getTrailDetailByPath(country, region, slug));
const loadRedirect = cache(
  unstable_cache((country: string, region: string, slug: string) => findTrailRedirect(country, region, slug), ["trail-page-redirect"], {
    revalidate: NO_TRAIL_REVALIDATE_S,
  }),
);

/**
 * A path the trail has left (its region was filled in later, its country
 * corrected) redirects permanently to the trail's current path
 * (redirects.ts). Mixed-case paths redirect to the lower-case path; over
 * HTTP the proxy already does that before this page (src/proxy.ts: a
 * redirect from here is sent with a duplicated Location on the first,
 * uncached render), so this is the fallback for anything that reaches the
 * page directly.
 */
async function resolve(params: Promise<Params>): Promise<{ trail: TrailDetailDto | null; redirectTo: string | null }> {
  const { country, region, slug } = await params;
  const trail = await loadTrail(country, region, slug);
  if (trail) return { trail, redirectTo: null };
  const lower = [country, region, slug].map((s) => s.toLowerCase());
  if (lower.join("/") !== [country, region, slug].join("/")) {
    const found = await loadTrail(lower[0], lower[1], lower[2]);
    if (found) return { trail: null, redirectTo: found.path };
  }
  return { trail: null, redirectTo: await loadRedirect(lower[0], lower[1], lower[2]) };
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  // Redirect / 404 here as well as in the page, so the response status is a real 308 / 404.
  // (There is deliberately no loading.tsx: its Suspense boundary would start streaming with a 200
  // before notFound() runs — a soft 404 for a page that exists to be indexed.)
  const { trail, redirectTo } = await resolve(params);
  if (redirectTo) permanentRedirect(redirectTo);
  if (!trail) notFound();
  const url = canonicalUrl(env().NEXT_PUBLIC_APP_URL, trail.path);
  const title = trailPageTitle(trail);
  const description = trailMetaDescription(trail);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: "website", siteName: "Ghost Guide", locale: "en_US", title, description, url },
    twitter: { card: "summary", title, description },
  };
}

const TRAILHEAD_SOURCE: Record<NonNullable<TrailDetailDto["trailheadSource"]>, string> = {
  osm_trailhead: "mapped trailhead",
  parking: "nearest mapped parking to the route start",
  route_start: "start of the mapped route",
  official: "official trailhead",
};

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mb-4 text-xl font-bold text-ink">
      {children}
    </h2>
  );
}

const sectionClass = "border-t border-sand-200 pt-7";
/** Phones: icon above a short label in three equal buttons; wider screens: inline buttons. */
const ACTION_CLASS = "w-full max-sm:min-h-16 max-sm:flex-col max-sm:gap-1 max-sm:px-2 max-sm:text-sm sm:w-auto";

export default async function TrailPage({ params }: { params: Promise<Params> }) {
  const { trail, redirectTo } = await resolve(params);
  if (redirectTo) permanentRedirect(redirectTo);
  if (!trail) notFound();

  const url = canonicalUrl(env().NEXT_PUBLIC_APP_URL, trail.path);
  const numbers = emergencyNumbersFor(trail.countryCode);
  // The generic notes (no signal on trails; Ghost Guide can't call for you) are said by the Safety section itself.
  const emergency = { ...numbers, notes: numbers.notes.filter((n) => !GENERAL_NOTES.includes(n)) };
  const location = locationParts(trail);
  const altName = trail.nameEn && trail.nameEn.trim().toLowerCase() !== trail.name.trim().toLowerCase() ? trail.nameEn.trim() : null;
  const actionCount = trail.trailhead ? 3 : 2;

  return (
    <article className="pb-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(trailJsonLd(trail, url)) }} />

      <Container className="pt-4 sm:pt-6">
        <nav aria-label="Breadcrumb" className="text-sm">
          <Link
            href="/explore"
            className="-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 font-medium text-forest-800 hover:bg-forest-50"
          >
            <ArrowLeft aria-hidden className="size-4" /> Explore trails
          </Link>
        </nav>

        <header className="mt-1 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-[2.5rem]">{trail.name}</h1>
            {altName ? (
              <p lang="en" className="mt-1 text-lg text-muted">
                {altName}
              </p>
            ) : null}
            {location.length ? (
              <p className="mt-2 flex items-center gap-1.5 text-[0.95rem] text-muted">
                <MapPin aria-hidden className="size-4 shrink-0 text-forest-700" />
                {location.join(" · ")}
              </p>
            ) : null}
          </div>
          <div className={`grid gap-2 ${actionCount === 3 ? "grid-cols-3" : "grid-cols-2"} sm:flex sm:flex-wrap sm:justify-end`}>
            <SaveTrailButton trailId={trail.id} trailName={trail.name} path={trail.path} className={ACTION_CLASS} />
            {trail.trailhead ? <DirectionsMenu lat={trail.trailhead.lat} lng={trail.trailhead.lng} className={ACTION_CLASS} /> : null}
            <ShareButton url={url} title={trail.name} className={ACTION_CLASS} />
          </div>
        </header>

        <div className="mt-6 border-t border-sand-200 pt-5">
          <TrailStats trail={trail} aside={<UnitsToggle />} />
        </div>
      </Container>

      <section aria-labelledby="map-heading" className="mt-6 sm:mx-auto sm:max-w-6xl sm:px-6">
        <h2 id="map-heading" className="sr-only">
          Map
        </h2>
        <TrailMap name={trail.name} geometry={trail.geometry} bbox={trail.bbox} trailhead={trail.trailhead} pois={trail.pois} />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 px-4 text-xs text-muted sm:px-0">
          <p className="py-1">
            Map data ©{" "}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-ink"
            >
              OpenStreetMap contributors
            </a>
            . Route and points as mapped{trail.provider === "osm" ? "" : ` by ${trail.sourceName}`}; not for navigation on its own.
          </p>
          {trail.sourceUrl ? (
            <a
              href={trail.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1 font-semibold text-forest-800 underline underline-offset-2 sm:min-h-8"
            >
              View on {trail.provider === "osm" ? "OpenStreetMap" : trail.sourceName} <ExternalLink aria-hidden className="size-3.5" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </section>

      <Container className="mt-6">
        <section aria-labelledby="along-heading" className="pt-1">
          <SectionHeading id="along-heading">Along the trail</SectionHeading>
          <PoiList pois={trail.pois} />
        </section>

        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-14">
          <div className="min-w-0 space-y-10">
            <section aria-labelledby="elevation-heading" className={sectionClass}>
              <SectionHeading id="elevation-heading">Elevation</SectionHeading>
              <ElevationProfile
                profile={trail.elevationProfile}
                elevationSource={trail.elevationSource}
                routeType={trail.routeType}
                maxElevationM={trail.maxElevationM}
                minElevationM={trail.minElevationM}
              />
            </section>

            <section aria-labelledby="conditions-heading" className={sectionClass}>
              <SectionHeading id="conditions-heading">Weather & daylight</SectionHeading>
              <ConditionsPanel trailId={trail.id} />
            </section>

            <section aria-labelledby="nearby-heading" className={sectionClass}>
              <SectionHeading id="nearby-heading">Getting there</SectionHeading>
              {trail.trailhead ? (
                <p className="mb-4 text-sm text-muted">
                  Trailhead: {trail.trailheadSource ? TRAILHEAD_SOURCE[trail.trailheadSource] : "mapped point"} ·{" "}
                  <span className="tabular-nums">
                    {trail.trailhead.lat.toFixed(5)}, {trail.trailhead.lng.toFixed(5)}
                  </span>
                </p>
              ) : (
                <p className="mb-4 text-sm text-muted">
                  The trailhead isn&apos;t mapped for this trail; distances are from the middle of the route.
                </p>
              )}
              <NearbyPanel trailId={trail.id} />
            </section>
          </div>

          <div className="min-w-0 space-y-10">
            <section aria-labelledby="details-heading" className={sectionClass}>
              <SectionHeading id="details-heading">Trail details</SectionHeading>
              <TrailFacts trail={trail} />
            </section>

            <section aria-labelledby="safety-heading" className={sectionClass}>
              <SectionHeading id="safety-heading">Safety</SectionHeading>
              <SafetySection trail={trail} emergency={emergency} />
            </section>
          </div>
        </div>

        <section aria-labelledby="sources-heading" className={`mt-12 ${sectionClass}`}>
          <h2 id="sources-heading" className="mb-2 text-base font-bold text-ink">
            Sources
          </h2>
          <SourceFooter trail={trail} />
        </section>
      </Container>
    </article>
  );
}
