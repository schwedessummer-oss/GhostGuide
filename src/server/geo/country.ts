import "server-only";
import { feature } from "@rapideditor/country-coder";

/**
 * Country of an exact point, offline (bundled borders from
 * @rapideditor/country-coder: OSM-derived land borders, generalized
 * territorial waters; no network, no rate limit, deterministic).
 *
 * Trails take their country from this, not from the 0.1° reverse-geocoding
 * cell (geocode.ts reverseAdminArea), whose centre can lie across a border
 * up to ~8 km away: the country decides the emergency number shown and
 * whether official (NWS) weather alerts apply, so it must be the country
 * the trail is actually in.
 *
 * Codes are ISO 3166-1 alpha-2, lower case, at TERRITORY level where the
 * territory has an officially assigned code of its own (Hong Kong "hk",
 * Puerto Rico "pr", Guam "gu", Réunion "re": they have their own emergency
 * numbers / alert services); "exceptionally reserved" pieces (Ceuta and
 * Melilla "EA", ...) map to their country. Null where the data has no
 * country (open sea, Antarctica): unknown, never guessed.
 *
 * Caveats (country-coder): borders are generalized, so a point within a few
 * hundred metres of a land border can still come out on the wrong side, and
 * disputed areas get the de facto controlling country.
 */

const ISO_A2 = /^[A-Z]{2}$/;

/** ISO 3166-1 alpha-2 (lower case) at a point, or null when unknown. Never throws. */
export function countryCodeAt(lat: number, lng: number): string | null {
  if (typeof lng !== "number" || typeof lat !== "number" || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  let props: { iso1A2?: string; isoStatus?: string; country?: string } | undefined;
  try {
    props = feature([lng, lat], { level: "territory" })?.properties;
  } catch {
    return null;
  }
  if (!props) return null;
  const own = props.iso1A2;
  const code = props.isoStatus === "official" || props.isoStatus === "usrAssn" || !props.country ? own : props.country;
  return typeof code === "string" && ISO_A2.test(code) ? code.toLowerCase() : null;
}

/**
 * The sovereign country of an ISO alpha-2 code ("pr" → "us", "hk" → "cn",
 * "re" → "fr", "us" → "us"), lower case; null for anything unknown. Two
 * sources can name the same place at different levels (Nominatim may say
 * "us" where the borders say "pr"); they agree when their sovereigns do.
 */
export function sovereignOf(code: string | null | undefined): string | null {
  if (typeof code !== "string") return null;
  const c = code.trim().toUpperCase();
  if (!ISO_A2.test(c)) return null;
  let props: { iso1A2?: string; country?: string } | undefined;
  try {
    props = feature(c)?.properties;
  } catch {
    props = undefined;
  }
  // Not a known code ("xx" = unknown, typos): no country to compare.
  const sovereign = props ? (props.country ?? props.iso1A2) : undefined;
  return typeof sovereign === "string" && ISO_A2.test(sovereign) ? sovereign.toLowerCase() : null;
}

/** Whether two country codes name the same country (see sovereignOf); false when either is unknown. */
export function sameCountry(a: string | null | undefined, b: string | null | undefined): boolean {
  const sa = sovereignOf(a);
  return sa !== null && sa === sovereignOf(b);
}
