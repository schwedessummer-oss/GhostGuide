import { ExternalLink } from "lucide-react";
import type { TrailDetailDto } from "@/domain/catalog";
import {
  accessLabel,
  dogPolicyLabel,
  feeLabel,
  humanize,
  listLabel,
  permitLabel,
  routeTypeLabel,
  safeWebsiteUrl,
  trailVisibilityLabel,
  websiteLabel,
  wheelchairLabel,
} from "./format";

function Row({ term, children, unknown }: { term: string; children: React.ReactNode; unknown?: boolean }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 py-2.5">
      <dt className="text-sm text-muted">{term}</dt>
      <dd className={unknown ? "text-sm text-muted" : "text-[0.95rem] text-ink"}>{children}</dd>
    </div>
  );
}

/**
 * Mapped trail facts. Each unknown is stated briefly instead of hidden, so
 * a missing value is never mistaken for "none".
 */
export function TrailFacts({ trail }: { trail: TrailDetailDto }) {
  const surfaces = listLabel(trail.surfaces);
  const activities = listLabel(trail.activities);
  const website = safeWebsiteUrl(trail.website);
  const facilities = [
    trail.hasParking && "parking",
    trail.hasToilets && "restrooms",
    trail.hasDrinkingWater && "drinking water",
    trail.hasCamping && "camping",
  ].filter((f): f is string => !!f);

  // Decision-relevant facts are always listed (unknown stated as such); the rest only when mapped,
  // with one line naming what OpenStreetMap doesn't say.
  const optional: { term: string; value: React.ReactNode | null; missing: string }[] = [
    {
      term: "Trail visibility",
      value: trail.trailVisibility ? trailVisibilityLabel(trail.trailVisibility) : null,
      missing: "trail visibility",
    },
    { term: "Wheelchair", value: trail.wheelchair !== "unknown" ? wheelchairLabel(trail.wheelchair) : null, missing: "wheelchair access" },
    { term: "Access", value: trail.access ? accessLabel(trail.access) : null, missing: "access rules" },
    { term: "Season", value: trail.seasonality ? humanize(trail.seasonality) : null, missing: "season" },
    { term: "Activities", value: activities, missing: "activities" },
    { term: "Managed by", value: trail.operator, missing: "managing organization" },
    {
      term: "Website",
      value: website ? (
        <a
          href={website}
          target="_blank"
          rel="nofollow noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium text-forest-800 underline underline-offset-2 hover:text-forest-900"
        >
          {websiteLabel(website)} <ExternalLink aria-hidden className="size-3.5" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : null,
      missing: "website",
    },
  ];
  const missing = optional.filter((o) => o.value === null).map((o) => o.missing);

  return (
    <div>
      <dl className="divide-y divide-sand-200">
        <Row term="Route">{routeTypeLabel(trail.routeType)}</Row>
        <Row term="Surface" unknown={!surfaces}>
          {surfaces ?? "No surface data"}
        </Row>
        <Row term="Dogs" unknown={trail.dogPolicy === "unknown"}>
          {dogPolicyLabel(trail.dogPolicy)}
        </Row>
        <Row term="Fee" unknown={trail.feeRequired === null}>
          {feeLabel(trail.feeRequired)}
        </Row>
        <Row term="Permit" unknown={trail.permitRequired === null}>
          {permitLabel(trail.permitRequired)}
        </Row>
        <Row term="Facilities" unknown={!facilities.length}>
          {facilities.length ? `${humanize(facilities.join(", "))} mapped near the route` : "None mapped near the route"}
        </Row>
        {optional
          .filter((o) => o.value !== null)
          .map((o) => (
            <Row key={o.term} term={o.term}>
              {o.value}
            </Row>
          ))}
      </dl>
      {missing.length ? <p className="mt-3 text-sm text-muted">Not mapped: {missing.join(", ")}.</p> : null}
      {trail.description?.trim() ? (
        <figure className="mt-5 border-l-4 border-forest-200 pl-4">
          <blockquote className="whitespace-pre-line text-[0.95rem] text-ink">{trail.description.trim()}</blockquote>
          <figcaption className="mt-1.5 text-xs text-muted">Description as mapped by {trail.sourceName}.</figcaption>
        </figure>
      ) : null}
    </div>
  );
}
