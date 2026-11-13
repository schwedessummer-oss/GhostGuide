/**
 * Search metadata for catalog trail pages (pure): page title, meta
 * description and schema.org JSON-LD.
 *
 * Built ONLY from stored facts. No ratings, reviews, opening hours, prices or
 * other fields we do not hold; optional schema.org properties are omitted
 * when the underlying value is unknown.
 */
import type { TrailDetailDto, TrailSummaryDto } from "@/domain/catalog";
import { countryName, difficultyLabel, formatClimb, formatTrailDistance, publicAccessFromTag, type Units } from "./format";

/** Countries whose visitors expect miles/feet first in snippets. */
const IMPERIAL_COUNTRIES = new Set(["us", "lr", "mm", "gb", "pr", "vi", "gu"]);

export const snippetUnits = (countryCode: string): Units => (IMPERIAL_COUNTRIES.has(countryCode.toLowerCase()) ? "imperial" : "metric");

/** Absolute canonical URL: base (no trailing slash) + path. */
export function canonicalUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

type TitleInput = Pick<TrailSummaryDto, "name" | "nearestPlace" | "regionName" | "countryCode">;

/** "Table Rock Trail — South Carolina, United States" (place, else region; country when known). */
export function trailPageTitle(t: TitleInput): string {
  const place = t.nearestPlace?.trim() || t.regionName?.trim() || null;
  const country = countryName(t.countryCode);
  const where = [place, country].filter((p, i, all): p is string => !!p && all.indexOf(p) === i).join(", ");
  return where ? `${t.name} — ${where}` : t.name;
}

const ROUTE_PHRASE: Record<string, string> = {
  linear: "out-and-back hike",
  loop: "loop hike",
  network: "trail network",
  unknown: "trail",
};

const SOURCE_PHRASE: Record<string, string> = {
  osm: "OpenStreetMap",
  ridb: "Recreation.gov",
};

type DescriptionInput = Pick<
  TrailDetailDto,
  | "name"
  | "routeType"
  | "hikeDistanceM"
  | "distanceM"
  | "hikeGainM"
  | "difficulty"
  | "difficultySource"
  | "regionName"
  | "nearestPlace"
  | "countryCode"
  | "provider"
  | "sourceName"
>;

/**
 * Meta description from stored facts only, e.g.
 * "Table Rock Trail is a 6.8 mi (11.0 km) out-and-back hike in South Carolina,
 *  United States, with about 2,280 ft of climbing. Difficulty: hard (estimated).
 *  Map, elevation profile, conditions and trailhead directions. Trail data: OpenStreetMap."
 */
export function trailMetaDescription(t: DescriptionInput): string {
  const units = snippetUnits(t.countryCode);
  const other: Units = units === "imperial" ? "metric" : "imperial";
  const distance =
    units === "imperial"
      ? `${formatTrailDistance(t.hikeDistanceM, units)} (${formatTrailDistance(t.hikeDistanceM, other)})`
      : formatTrailDistance(t.hikeDistanceM, units);
  const place = [t.nearestPlace?.trim(), t.regionName?.trim(), countryName(t.countryCode)]
    .filter((p, i, all): p is string => !!p && all.indexOf(p) === i)
    .join(", ");
  const article = /^[aeiou]|^8|^11(?!\d)|^18(?!\d)/i.test(distance) ? "an" : "a";
  const parts: string[] = [];
  let first = `${t.name} is ${article} ${distance} ${ROUTE_PHRASE[t.routeType] ?? "trail"}`;
  if (place) first += ` in ${place}`;
  if (typeof t.hikeGainM === "number" && Number.isFinite(t.hikeGainM) && t.hikeGainM > 0) {
    first += `${place ? "," : ""} with about ${formatClimb(t.hikeGainM, units)} of climbing`;
  }
  parts.push(`${first}.`);
  if (t.difficulty !== "unknown") {
    // Without climb data an estimated rating rests on distance alone (see format.ts difficultyExplanation).
    const climbKnown = typeof t.hikeGainM === "number" && Number.isFinite(t.hikeGainM);
    const q =
      t.difficultySource === "estimated"
        ? climbKnown
          ? " (estimated)"
          : " (estimated from distance)"
        : t.difficultySource === "osm_sac_scale"
          ? " (SAC scale)"
          : "";
    parts.push(`Difficulty: ${difficultyLabel(t.difficulty).toLowerCase()}${q}.`);
  }
  parts.push("Map, elevation profile, conditions and trailhead directions.");
  parts.push(`Trail data: ${SOURCE_PHRASE[t.provider] ?? t.sourceName}.`);
  return parts.join(" ");
}

type JsonLdInput = Pick<TrailDetailDto, "name" | "trailhead" | "regionName" | "countryCode" | "feeRequired" | "access">;

/**
 * schema.org TouristAttraction for the trail. Only: name, url, geo (trailhead),
 * address (region / country), isAccessibleForFree (only when no fee is
 * mapped as fee=no) and publicAccess (only when the access tag is clear).
 */
export function trailJsonLd(t: JsonLdInput, url: string): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "TouristAttraction",
    name: t.name,
    url,
  };
  if (t.trailhead && Number.isFinite(t.trailhead.lat) && Number.isFinite(t.trailhead.lng)) {
    ld.geo = {
      "@type": "GeoCoordinates",
      latitude: Number(t.trailhead.lat.toFixed(6)),
      longitude: Number(t.trailhead.lng.toFixed(6)),
    };
  }
  const country = countryName(t.countryCode) ? t.countryCode.toUpperCase() : null;
  const region = t.regionName?.trim() || null;
  if (country || region) {
    ld.address = {
      "@type": "PostalAddress",
      ...(region ? { addressRegion: region } : {}),
      ...(country ? { addressCountry: country } : {}),
    };
  }
  if (t.feeRequired === false) ld.isAccessibleForFree = true;
  const publicAccess = publicAccessFromTag(t.access);
  if (publicAccess !== null) ld.publicAccess = publicAccess;
  return ld;
}

/**
 * JSON for an inline <script type="application/ld+json">: "<", ">" and "&"
 * are escaped as < / > / & so provider text can never close
 * the script element; U+2028/U+2029 are escaped for old JS parsers.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp("\\u2028", "g"), "\\u2028")
    .replace(new RegExp("\\u2029", "g"), "\\u2029");
}
