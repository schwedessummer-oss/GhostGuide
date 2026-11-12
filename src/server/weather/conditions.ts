import "server-only";
import { ROUTE_TYPES, type AttributionDto, type LngLat, type RouteType, type TrailConditionsDto } from "@/domain/catalog";
import { haversineM } from "@/domain/geo";
import { withAnon } from "@/server/db";
import { addDaysToKey, isValidTimeZone, localDateKey, timezoneAt } from "@/server/geo/timezone";
import { log } from "@/server/log";
import { parseElevationProfile } from "@/server/trails/read";
import { currentStep, dailyForecast, hourlyForecast } from "./forecast";
import { clockTime, forecastHighlights } from "./highlights";
import { getMetnoForecast, METNO_ATTRIBUTION, toHourlyDto, type MetnoForecastResult } from "./metno";
import { getNwsAlerts, NWS_ATTRIBUTION, type NwsAlertsResult } from "./nws-alerts";
import { buildPlanning, sunDays, toSunTimesDto } from "./planning";

/**
 * Trail conditions: real weather (MET Norway), official alerts (NWS, US
 * only), sun times and daylight planning for one catalog trail.
 *
 *   point     trailhead, else the route's centroid
 *   timezone  the trail's stored zone, else the zone at the point
 *             (src/server/geo/timezone.ts); UTC only as a last resort, said in notes
 *   altitude  sent to MET Norway when the trailhead is within 300 m of an end
 *             of the route and the stored DEM profile gives that end's
 *             elevation; otherwise MET uses its own model terrain
 *
 * Provider failures never fail the request: forecastStatus "unavailable"
 * (hourly/daily/highlights empty, current null) or alertsStatus
 * "unavailable" / "not_supported", each with an honest note; sun times and
 * planning are computed locally and always present. Nothing is invented.
 * planning.notes also carries the data-availability notes, since the DTO
 * has no other free-text field.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Trailhead → route end distance within which the profile's end elevation is used as the forecast altitude. */
export const ALTITUDE_MATCH_RADIUS_M = 300;

interface ConditionsTrailRow {
  id: string;
  countryCode: string;
  timezone: string | null;
  routeType: string;
  distanceM: number;
  estimatedDurationMin: number | null;
  elevationProfile: unknown;
  centroidLng: number;
  centroidLat: number;
  trailheadLng: number | null;
  trailheadLat: number | null;
  startLng: number | null;
  startLat: number | null;
  endLng: number | null;
  endLat: number | null;
}

export interface ConditionsTrail {
  id: string;
  countryCode: string | null;
  timezone: string | null;
  routeType: RouteType;
  distanceM: number;
  estimatedDurationMin: number | null;
  profile: [number, number][] | null;
  centroid: LngLat;
  trailhead: LngLat | null;
  routeStart: LngLat | null;
  routeEnd: LngLat | null;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pt = (lng: unknown, lat: unknown): LngLat | null => (finite(lng) && finite(lat) ? { lng, lat } : null);

/** The fields conditions need, through the public (RLS) read path. Null for unknown or hidden trails. */
export async function loadConditionsTrail(trailId: string): Promise<ConditionsTrail | null> {
  if (typeof trailId !== "string" || !UUID_RE.test(trailId)) return null;
  const [row] = await withAnon(
    (tx) => tx<ConditionsTrailRow[]>`
      select t.id, t.country_code, t.timezone, t.route_type, t.distance_m, t.estimated_duration_min, t.elevation_profile,
             st_x(t.centroid::geometry) as centroid_lng, st_y(t.centroid::geometry) as centroid_lat,
             st_x(t.trailhead::geometry) as trailhead_lng, st_y(t.trailhead::geometry) as trailhead_lat,
             st_x(st_startpoint(st_geometryn(t.geom, 1))) as start_lng,
             st_y(st_startpoint(st_geometryn(t.geom, 1))) as start_lat,
             st_x(st_endpoint(st_geometryn(t.geom, st_numgeometries(t.geom)))) as end_lng,
             st_y(st_endpoint(st_geometryn(t.geom, st_numgeometries(t.geom)))) as end_lat
        from public.catalog_trails t
       where t.id = ${trailId.toLowerCase()}::uuid and not t.hidden`,
  );
  if (!row) return null;
  const centroid = pt(row.centroidLng, row.centroidLat);
  if (!centroid) return null;
  const country = typeof row.countryCode === "string" && /^[a-z]{2}$/.test(row.countryCode) && row.countryCode !== "xx" ? row.countryCode : null;
  return {
    id: row.id,
    countryCode: country,
    timezone: isValidTimeZone(row.timezone) ? row.timezone : null,
    routeType: (ROUTE_TYPES as readonly string[]).includes(row.routeType) ? (row.routeType as RouteType) : "unknown",
    distanceM: row.distanceM,
    estimatedDurationMin: finite(row.estimatedDurationMin) ? row.estimatedDurationMin : null,
    profile: parseElevationProfile(row.elevationProfile),
    centroid,
    trailhead: pt(row.trailheadLng, row.trailheadLat),
    routeStart: pt(row.startLng, row.startLat),
    routeEnd: pt(row.endLng, row.endLat),
  };
}

/**
 * Elevation (m) of the forecast point from the stored profile: the profile's
 * first/last elevation when the trailhead is within ALTITUDE_MATCH_RADIUS_M
 * of the route's start/end. Null otherwise (no trailhead, no profile, far).
 */
export function forecastAltitude(trail: Pick<ConditionsTrail, "trailhead" | "profile" | "routeStart" | "routeEnd">): number | null {
  const { trailhead, profile } = trail;
  if (!trailhead || !profile || profile.length < 2) return null;
  const ends: { distanceM: number; elevation: number }[] = [];
  if (trail.routeStart) ends.push({ distanceM: haversineM(trailhead, trail.routeStart), elevation: profile[0][1] });
  if (trail.routeEnd) ends.push({ distanceM: haversineM(trailhead, trail.routeEnd), elevation: profile[profile.length - 1][1] });
  const nearest = ends.sort((a, b) => a.distanceM - b.distanceM)[0];
  return nearest && nearest.distanceM <= ALTITUDE_MATCH_RADIUS_M && finite(nearest.elevation) ? Math.round(nearest.elevation) : null;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "at 9:12 AM", "yesterday at 8:17 PM" or "on 2026-11-10 at 8:17 PM" relative to `now` in `timeZone`. */
export function whenLocal(instant: Date, now: Date, timeZone: string): string {
  const day = localDateKey(instant, timeZone);
  const today = localDateKey(now, timeZone);
  const time = clockTime(instant, timeZone);
  if (day === today) return `at ${time}`;
  if (day === addDaysToKey(today, -1)) return `yesterday at ${time}`;
  return `on ${day} at ${time}`;
}

/**
 * Conditions for a catalog trail at `now`. Null when the trail does not
 * exist or is hidden. Provider failures are reported in the DTO, never
 * thrown; a database failure while loading the trail does throw.
 */
export async function getTrailConditions(trailId: string, now: Date = new Date()): Promise<TrailConditionsDto | null> {
  const trail = await loadConditionsTrail(trailId);
  if (!trail) return null;

  const point = trail.trailhead ?? trail.centroid;
  const zone = trail.timezone ?? timezoneAt(point.lat, point.lng);
  const tz = zone ?? "UTC";

  const [forecast, alerts] = await Promise.all([
    getMetnoForecast(point.lat, point.lng, { altitudeM: forecastAltitude(trail) }).catch(
      (err: unknown): MetnoForecastResult => {
        log.error("conditions.forecast_failed", { error: errorMessage(err) });
        return { status: "unavailable", message: "The weather forecast is unavailable right now." };
      },
    ),
    getNwsAlerts(point.lat, point.lng, { countryCode: trail.countryCode, now }).catch((err: unknown): NwsAlertsResult => {
      log.error("conditions.alerts_failed", { error: errorMessage(err) });
      return { status: "unavailable", alerts: [], message: "Official weather alerts could not be loaded right now." };
    }),
  ]);

  const notes: string[] = [];
  let current: TrailConditionsDto["current"] = null;
  let hourly: TrailConditionsDto["hourly"] = [];
  let daily: TrailConditionsDto["daily"] = [];
  let highlights: string[] = [];
  let forecastUpdatedAt: string | null = null;

  if (forecast.status === "ok") {
    const steps = forecast.series.steps;
    const cur = currentStep(steps, now);
    current = cur ? toHourlyDto(cur) : null;
    hourly = hourlyForecast(steps, now);
    daily = dailyForecast(steps, now, tz);
    highlights = forecastHighlights(hourly, now, tz);
    forecastUpdatedAt = forecast.series.updatedAt;
    if (forecast.source === "stale") {
      const updated = forecastUpdatedAt ? ` It was last updated ${whenLocal(new Date(forecastUpdatedAt), now, tz)}.` : "";
      notes.push(`The latest forecast could not be loaded just now, so an earlier forecast is shown.${updated}`);
    }
    if (daily.length > 0) notes.push("Today's daily figures cover only the rest of the day.");
  } else {
    notes.push("The weather forecast is unavailable right now. Check an official forecast before you go.");
  }

  if (alerts.status === "not_supported") {
    notes.push("Official weather alerts are not available for this region in Ghost Guide. Check local warnings before you go.");
  } else if (alerts.status === "unavailable") {
    notes.push("Official weather alerts could not be loaded right now. Check weather.gov before you go.");
  }

  const sun = sunDays(point.lat, point.lng, tz, now);
  const planning = buildPlanning({
    now,
    timeZone: tz,
    timeZoneKnown: zone !== null,
    routeType: trail.routeType,
    distanceM: trail.distanceM,
    estimatedDurationMin: trail.estimatedDurationMin,
    profile: trail.profile,
    sun,
  });
  planning.notes = [...notes, ...planning.notes];

  const attribution: AttributionDto[] = [];
  if (forecast.status === "ok") attribution.push({ ...METNO_ATTRIBUTION });
  if (alerts.status === "ok") attribution.push({ ...NWS_ATTRIBUTION });

  return {
    trailId: trail.id,
    generatedAt: now.toISOString(),
    timezone: zone,
    point,
    forecastStatus: forecast.status,
    current,
    hourly,
    daily,
    highlights,
    alertsStatus: alerts.status,
    alerts: alerts.alerts,
    sun: sun.map(toSunTimesDto),
    planning,
    forecastUpdatedAt,
    attribution,
  };
}
