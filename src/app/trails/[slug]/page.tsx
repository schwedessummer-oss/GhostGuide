import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ArrowRight, Ban, Car, Dog, ExternalLink, FileText, Headphones, Info, MapPin, TriangleAlert } from "lucide-react";
import { Alert, Badge, ButtonLink, Card, Container, SimulatedBadge, Stat } from "@/components/ui";
import { TrailMap } from "@/components/map/trail-map";
import { DemoBadge, DifficultyBadge, FactKindBadge } from "@/components/discover/badges";
import { distanceBoth, elevationBoth, humanize } from "@/components/discover/format";
import { getRegionById, getTrailBySlug, type TrailDetail } from "@/server/catalog/trails";
import { featureLabel } from "@/server/discover/browse";
import { routeTypeLabel } from "@/domain/recommendation";
import { formatDuration } from "@/domain/geo";
import { formatDate, formatMoney } from "@/lib/format";
import { formatInZone } from "@/lib/time";
import { showDemoFixtures } from "@/config/env";
import type { FactKind } from "@/domain/types";

/** Demo-region trails are development fixtures: without SHOW_DEMO_FIXTURES they do not exist (404). */
const loadTrail = cache((slug: string) =>
  showDemoFixtures() && /^[a-z0-9-]{1,80}$/.test(slug) ? getTrailBySlug(slug) : Promise.resolve(null),
);

export async function generateMetadata({ params }: PageProps<"/trails/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const trail = await loadTrail(slug);
  if (!trail) return { title: "Trail not found" };
  return { title: trail.isDemo ? `${trail.name} (demo trail)` : trail.name, description: trail.summary };
}

const FIELD_LABEL: Record<string, string> = {
  distance_km: "Distance",
  elevation_gain_m: "Elevation gain",
  max_elevation_m: "Max elevation",
  difficulty: "Difficulty rating",
  terrain: "Terrain",
  accessibility_features: "Accessibility features",
  estimated_duration_min: "Estimated duration",
  dogs_allowed: "Dog policy",
  permit_required: "Permit requirement",
  geometry: "Route geometry",
  parking_info: "Parking",
};

const KIND_ORDER: FactKind[] = ["verified", "operator_note", "estimate", "demo"];

function daysAgo(d: Date | string | null, now: Date): number | null {
  if (!d) return null;
  return Math.max(0, Math.floor((now.getTime() - new Date(d).getTime()) / 86_400_000));
}

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mb-4 text-xl font-bold text-ink">
      {children}
    </h2>
  );
}

function ClosureList({ trail, timeZone }: { trail: TrailDetail; timeZone: string }) {
  if (!trail.activeClosures.length && trail.status !== "closed") return null;
  const sourceLabel = (id: string | null) => trail.sources.find((s) => s.id === id)?.label ?? null;
  return (
    <section aria-labelledby="closures-heading" className="space-y-3">
      <h2 id="closures-heading" className="sr-only">
        Closures and advisories
      </h2>
      {trail.status === "closed" ? (
        <Alert tone="red" title="Trail closed">
          This trail is marked closed in our catalog and cannot be planned or booked right now.
        </Alert>
      ) : null}
      {trail.activeClosures.map((c) => {
        const tone = c.severity === "closed" ? "red" : c.severity === "partial" ? "amber" : "blue";
        const title = c.severity === "closed" ? "Closed" : c.severity === "partial" ? "Partial closure" : "Advisory";
        const Icon = c.severity === "closed" ? Ban : c.severity === "partial" ? TriangleAlert : Info;
        const src = sourceLabel(c.sourceId);
        return (
          <Alert
            key={c.id}
            tone={tone}
            title={
              <span className="inline-flex items-center gap-2">
                <Icon aria-hidden className="size-4" /> {title}
              </span>
            }
          >
            <p>{c.reason}</p>
            <p className="mt-1 text-sm">
              Since {formatInZone(c.startsAt, timeZone, { dateStyle: "medium" })}
              {c.endsAt ? `, expected until ${formatInZone(c.endsAt, timeZone, { dateStyle: "medium" })}` : ", no end date announced"}
              {src ? ` · Source: ${src}` : ""}
            </p>
          </Alert>
        );
      })}
    </section>
  );
}

export default async function TrailPage({ params }: PageProps<"/trails/[slug]">) {
  const { slug } = await params;
  const trail = await loadTrail(slug);
  if (!trail) notFound();
  const region = await getRegionById(trail.regionId);
  const timeZone = region?.timezone ?? "UTC";
  const now = new Date();
  const coords = trail.geometry?.coordinates ?? [];
  const provenance = [...trail.provenance].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (FIELD_LABEL[a.field] ?? a.field).localeCompare(FIELD_LABEL[b.field] ?? b.field),
  );
  const durationProv = trail.provenance.find((p) => p.field === "estimated_duration_min");
  // factsVerifiedAt is when the facts were last REVIEWED. Only facts whose provenance kind is
  // "verified" were checked against a source, so the wording follows the kinds (honesty rule).
  const reviewedDays = daysAgo(trail.factsVerifiedAt, now);
  const verifiedCount = trail.provenance.filter((p) => p.kind === "verified").length;
  const allVerified = !trail.isDemo && trail.provenance.length > 0 && verifiedCount === trail.provenance.length;
  const poiById = new Map(trail.pois.map((p) => [p.id, p]));
  const stops = trail.narrations
    .filter((n) => n.status === "approved" && n.sourceId)
    .map((n) => ({ narration: n, poi: n.poiId ? poiById.get(n.poiId) : undefined }))
    .sort((a, b) => (a.poi?.seq ?? 999) - (b.poi?.seq ?? 999));
  const numberedPois = trail.pois.map((p, i) => ({ ...p, number: i + 1 }));
  const fullyClosed = trail.status === "closed" || trail.activeClosures.some((c) => c.severity === "closed");

  return (
    <div>
      <div className="border-b border-sand-200 bg-gradient-to-b from-forest-50 to-canvas">
        <Container className="py-8 sm:py-10">
          <nav aria-label="Breadcrumb" className="mb-4 text-sm">
            <Link href="/trails" className="inline-flex min-h-11 items-center font-semibold text-forest-800 underline-offset-2 hover:underline">
              ← All demo trails
            </Link>
          </nav>

          <div className="flex flex-wrap items-center gap-2">
            <DifficultyBadge difficulty={trail.difficulty} />
            {trail.isDemo ? <DemoBadge /> : null}
            <Badge>{routeTypeLabel(trail.routeType)}</Badge>
          </div>
          <h1 className="mt-3 text-3xl font-bold text-ink sm:text-4xl">{trail.name}</h1>
          <p className="mt-3 max-w-3xl text-lg text-muted">{trail.summary}</p>
          {trail.isDemo ? (
            <div role="note" className="mt-5 flex items-start gap-3 rounded-xl border-2 border-amber-ink/40 bg-amber-bg p-4 text-amber-ink">
              <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0" />
              <p>
                <strong>Demonstration trail — fictional, not for navigation.</strong> This place, its route, facts and stories are invented to
                demonstrate Ghost Guide. Do not use them to plan a real hike.
              </p>
            </div>
          ) : null}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
            <ButtonLink href={`/plan?trail=${trail.slug}`} size="lg">
              Personalize this hike <ArrowRight aria-hidden className="size-5" />
            </ButtonLink>
            <p className="text-muted">
              from <span className="text-xl font-bold text-ink">{formatMoney(trail.basePriceCents, trail.currency)}</span> per person
              <span className="block text-xs">Weekday base price; weekend/holiday surcharges and group discounts are shown at checkout.</span>
            </p>
          </div>
          {fullyClosed ? (
            <p className="mt-3 text-sm font-semibold text-red-ink">Currently closed: personalize for a date after the closure ends.</p>
          ) : null}
        </Container>
      </div>

      <Container className="space-y-10 py-10">
        <ClosureList trail={trail} timeZone={timeZone} />

        <section aria-labelledby="facts-heading">
          <SectionHeading id="facts-heading">Trail facts</SectionHeading>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Distance" value={distanceBoth(trail.distanceKm)} />
            <Stat label="Elevation gain" value={elevationBoth(trail.elevationGainM)} />
            <Stat label="Max elevation" value={trail.maxElevationM !== null ? elevationBoth(trail.maxElevationM) : "Not recorded"} />
            <Stat label="Estimated duration" value={`${formatDuration(trail.estimatedDurationMin)} est.`} hint="Estimate, not a guarantee" />
            <Stat label="Difficulty" value={humanize(trail.difficulty)} />
            <Stat label="Route type" value={routeTypeLabel(trail.routeType)} />
            <Stat label="Terrain" value={<span className="text-base">{trail.terrain.map(humanize).join(", ") || "Not recorded"}</span>} />
            <Stat
              label="Dogs"
              value={<span className="inline-flex items-center gap-1.5 text-base"><Dog aria-hidden className="size-4" />{trail.dogsAllowed === true ? "Allowed" : trail.dogsAllowed === false ? "Not allowed" : "Policy unverified"}</span>}
            />
          </dl>
          <p className="mt-3 text-sm text-muted">
            <strong>How the duration is estimated:</strong>{" "}
            {durationProv?.note ?? "A catalog estimate based on distance and climbing."} Your personalized plan adjusts it for your pace, fitness and
            group size.
          </p>
        </section>

        <section aria-labelledby="route-heading">
          <SectionHeading id="route-heading">Route</SectionHeading>
          {coords.length >= 2 ? (
            <figure>
              <TrailMap
                coordinates={coords.map((c) => [c[0], c[1]] as [number, number])}
                pois={numberedPois.map((p) => ({ id: p.id, name: p.name, kind: p.kind, lat: p.lat, lng: p.lng, number: p.number }))}
                label={`Map of the ${trail.name} route with ${trail.pois.length} stops`}
              />
              {trail.isDemo ? (
                <figcaption className="mt-2 text-sm text-muted">Demonstration route drawn on a real basemap: fictional, not for navigation.</figcaption>
              ) : null}
            </figure>
          ) : (
            <Alert tone="amber">Route geometry is not available for this trail yet.</Alert>
          )}
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <Card>
              <h3 className="flex items-center gap-2 text-lg font-bold">
                <MapPin aria-hidden className="size-5 text-forest-700" /> Trailhead & parking
              </h3>
              <p className="mt-2 font-semibold">{trail.trailheadName ?? "Trailhead"}</p>
              <p className="text-sm text-muted">
                {trail.trailheadLat.toFixed(4)}, {trail.trailheadLng.toFixed(4)}
                {trail.isDemo ? " (fictional coordinates)" : ""}
              </p>
              <p className="mt-3 flex items-start gap-2">
                <Car aria-hidden className="mt-1 size-4 shrink-0 text-muted" />
                <span>{trail.parkingInfo ?? "No parking information recorded."}</span>
              </p>
            </Card>
            <Card>
              <h3 className="text-lg font-bold">Accessibility</h3>
              {trail.accessibilityFeatures.length ? (
                <ul className="mt-2 space-y-1.5">
                  {trail.accessibilityFeatures.map((f) => (
                    <li key={f} className="flex items-center gap-2">
                      <span aria-hidden className="size-2 rounded-full bg-forest-600" />
                      {featureLabel(f)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-muted">No accessibility features are recorded for this trail.</p>
              )}
              <p className="mt-3 text-sm text-muted">
                Recorded from {trail.isDemo ? "a simulated field survey" : "our field survey"}; conditions change, so verify on site.
              </p>
            </Card>
          </div>
          {numberedPois.length ? (
            <div className="mt-6">
              <h3 className="mb-2 text-lg font-bold">Stops along the route</h3>
              <ol className="grid gap-2 sm:grid-cols-2">
                {numberedPois.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 rounded-xl bg-sand-100 px-3 py-2">
                    <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-forest-800 text-sm font-bold text-white">
                      {p.number}
                    </span>
                    <span>
                      <span className="font-semibold">{p.name}</span> <span className="text-sm text-muted">({humanize(p.kind)})</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </section>

        <section aria-labelledby="permits-heading">
          <SectionHeading id="permits-heading">Permits</SectionHeading>
          {trail.permits.length ? (
            <div className="space-y-4">
              {trail.permits.map((p) => (
                <Card key={p.id}>
                  <h3 className="flex items-center gap-2 text-lg font-bold">
                    <FileText aria-hidden className="size-5 text-forest-700" /> {p.name}
                  </h3>
                  <p className="text-sm text-muted">Issued by {p.authority}</p>
                  <p className="mt-2">{p.requirementSummary}</p>
                  {p.howToObtain ? <p className="mt-2 text-muted">{p.howToObtain}</p> : null}
                  <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    <div>
                      <dt className="inline font-semibold">Lead time: </dt>
                      <dd className="inline">{p.leadTimeDays !== null ? `apply at least ${p.leadTimeDays} days ahead` : "not specified"}</dd>
                    </div>
                    {p.verifiedAt ? (
                      <div>
                        <dt className="inline font-semibold">Last checked: </dt>
                        <dd className="inline">{formatDate(p.verifiedAt)}</dd>
                      </div>
                    ) : null}
                  </dl>
                  <a
                    href={p.officialUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 inline-flex min-h-11 items-center gap-2 font-semibold text-forest-800 underline underline-offset-2"
                  >
                    Official permit page <ExternalLink aria-hidden className="size-4" />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                  {trail.isDemo ? <p className="mt-1 text-xs text-muted">Demo: this link points to a placeholder page.</p> : null}
                  <p className="mt-2 text-sm text-muted">Ghost Guide links to official sources only; we don&apos;t buy permits or automate permit queues.</p>
                </Card>
              ))}
            </div>
          ) : (
            <p className="text-muted">
              {trail.permitRequired
                ? "A permit is required, but details are not in our catalog yet. Check with the land manager before you go."
                : "Our catalog lists no permit requirement for this trail. Rules can change: check with the land manager before you go."}
            </p>
          )}
        </section>

        <section aria-labelledby="narration-heading">
          <SectionHeading id="narration-heading">
            <span className="inline-flex items-center gap-2">
              <Headphones aria-hidden className="size-5 text-forest-700" /> Audio narration stops
            </span>
          </SectionHeading>
          {stops.length ? (
            <>
              <p className="mb-3 text-muted">
                Approved, source-cited narration that plays when your phone&apos;s GPS reports you near each stop (with the companion open; background
                playback isn&apos;t guaranteed on every phone).
              </p>
              <ol className="space-y-2">
                {stops.map(({ narration, poi }) => (
                  <li key={narration.id} className="rounded-xl border border-sand-200 bg-surface p-3">
                    <p className="font-semibold">{narration.title}</p>
                    <p className="text-sm text-muted">
                      {poi ? `${poi.name} · ${humanize(poi.kind)}` : "General narration"}
                      {narration.sourceCitation ? ` · Source: ${narration.sourceCitation}` : ""}
                    </p>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="text-muted">No approved narration is available for this trail yet.</p>
          )}
        </section>

        <section aria-labelledby="sources-heading">
          <SectionHeading id="sources-heading">Sources & information freshness</SectionHeading>
          <Alert tone={reviewedDays !== null && reviewedDays > 180 ? "amber" : "blue"} className="mb-5">
            {reviewedDays !== null ? (
              <>
                Trail facts were last {allVerified ? "verified" : "reviewed"}{" "}
                <strong>{reviewedDays === 0 ? "today" : `${reviewedDays} day${reviewedDays === 1 ? "" : "s"} ago`}</strong> (
                {formatDate(trail.factsVerifiedAt!)}).{" "}
                {trail.isDemo
                  ? "These are demonstration facts, invented for this demo: none of them is verified against a real source."
                  : allVerified
                    ? ""
                    : verifiedCount === 0
                      ? "None of them is verified against a source yet; the label on each fact below says where it comes from."
                      : `${verifiedCount} of ${trail.provenance.length} facts are verified against a source; the label on each fact below says where it comes from.`}
                {reviewedDays > 180 ? " This information may be out of date." : ""} Conditions change; check official sources before you go.
              </>
            ) : (
              "These facts have not been reviewed or verified yet."
            )}
          </Alert>
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-lg font-bold">Where each fact comes from</h3>
              <ul className="divide-y divide-sand-200 rounded-[var(--radius-card)] border border-sand-200 bg-surface">
                {provenance.map((p) => (
                  <li key={p.field} className="p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">{FIELD_LABEL[p.field] ?? humanize(p.field)}</span>
                      <FactKindBadge kind={p.kind} />
                    </div>
                    {p.note ? <p className="mt-1 text-sm text-muted">{p.note}</p> : null}
                    {p.verifiedAt ? (
                      <p className="mt-0.5 text-xs text-muted">
                        {p.kind === "verified" ? "Verified against the source" : "Last reviewed"} {formatDate(p.verifiedAt)}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                Verified = confirmed against a source · Estimate = calculated, not measured · Operator note = our team&apos;s judgement · Demonstration =
                invented for the demo.
              </p>
            </div>
            <div>
              <h3 className="mb-2 text-lg font-bold">Sources</h3>
              <ul className="space-y-3">
                {trail.sources.map((s) => (
                  <li key={s.id} className="rounded-xl border border-sand-200 bg-surface p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{s.label}</span>
                      {s.sourceType === "demo" ? <SimulatedBadge label="Demo source" /> : <Badge>{humanize(s.sourceType)}</Badge>}
                    </div>
                    {s.publisher ? <p className="text-sm text-muted">{s.publisher}</p> : null}
                    {s.notes ? <p className="mt-1 text-sm text-muted">{s.notes}</p> : null}
                    {s.retrievedAt ? <p className="mt-1 text-xs text-muted">Retrieved {formatDate(s.retrievedAt)}</p> : null}
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-forest-800 underline">
                        Visit source <ExternalLink aria-hidden className="size-3.5" />
                        <span className="sr-only">(opens in a new tab)</span>
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <Card className="flex flex-col items-start gap-4 bg-forest-50 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-bold">Ready to plan {trail.name}?</h2>
            <p className="text-muted">Answer a few questions and we&apos;ll check it against your time, pace, needs and the date you have in mind.</p>
          </div>
          <ButtonLink href={`/plan?trail=${trail.slug}`} size="lg">
            Personalize this hike
          </ButtonLink>
        </Card>
      </Container>
    </div>
  );
}
