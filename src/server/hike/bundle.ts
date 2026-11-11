import "server-only";
import { createHash } from "node:crypto";
import { withSystem, withUser } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { ownerHint } from "@/server/auth/owner-hint";
import { env, integrationStatus } from "@/config/env";
import { getOwnedTrip } from "@/server/trips/queries";
import { storage } from "@/integrations/storage";
import { log } from "@/server/log";
import type { ManifestItem } from "@/domain/offline-manifest";
import type { CheckinStatus, RouteType } from "@/domain/types";
import { BUNDLE_SCHEMA_VERSION, type BundleNarration, type BundlePoi, type TripBundle } from "@/lib/offline/wire";
import { conflict, notFound, ok, type HikeResult } from "./result";
import { bookedDateFor } from "./sessions";

/** Signed narration URLs stay valid long enough to download days before the hike. */
export const AUDIO_URL_TTL_SEC = 14 * 86_400;
export const MANIFEST_VERSION = 1;
const DEFAULT_STALE_MINUTES = 15;

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

interface TrailRow {
  id: string;
  regionId: string;
  slug: string;
  name: string;
  summary: string;
  isDemo: boolean;
  distanceKm: number;
  elevationGainM: number;
  difficulty: string;
  routeType: RouteType;
  estimatedDurationMin: number;
  trailheadName: string | null;
  trailheadLat: number;
  trailheadLng: number;
  parkingInfo: string | null;
  permitRequired: boolean;
  geometry: unknown;
}

interface NarrationRow {
  id: string;
  poiId: string | null;
  title: string;
  transcript: string;
  audioPath: string | null;
  durationSec: number | null;
  sourceCitation: string | null;
  sourceLabel: string | null;
  version: number;
}

/** Plain-language summary of which trail facts are verified, estimated or demonstration data. */
export function summarizeProvenance(isDemo: boolean, provenance: { field: string; kind: string }[]): string {
  if (isDemo) {
    return "Demonstration trail: the route, facts and stories are fictional and must not be used for navigation. Durations are estimates.";
  }
  const by = (k: string) => provenance.filter((p) => p.kind === k).map((p) => p.field.replace(/_/g, " "));
  const parts: string[] = [];
  if (by("verified").length) parts.push(`Verified from cited sources: ${by("verified").join(", ")}.`);
  if (by("estimate").length) parts.push(`Estimates (not guarantees): ${by("estimate").join(", ")}.`);
  if (by("operator_note").length) parts.push(`Operator assessments: ${by("operator_note").join(", ")}.`);
  return parts.join(" ") || "Trail facts come from the cited sources on the trail page; durations are estimates.";
}

/**
 * Everything the hike and help screens need offline, for a trip the user
 * owns (404 otherwise) that is booked, active or completed (409 otherwise).
 * Only APPROVED narration with a cited source is included.
 */
export async function getTripBundle(user: SessionUser, tripId: string, now = new Date()): Promise<HikeResult<TripBundle>> {
  const trip = await getOwnedTrip(user, tripId);
  if (!trip) return notFound("Trip not found");
  if (trip.status !== "booked" && trip.status !== "active" && trip.status !== "completed") {
    return conflict("Only booked, active or completed trips can be downloaded.");
  }

  // Ownership is verified above; read the trip's catalog rows by id (the
  // trail may have been closed since booking, and the hiker still needs it).
  const catalog = await withSystem(async (tx) => {
    const [trail] = await tx<TrailRow[]>`
      select id, region_id, slug, name, summary, is_demo, distance_km, elevation_gain_m, difficulty, route_type,
             estimated_duration_min, trailhead_name, trailhead_lat, trailhead_lng, parking_info, permit_required, geometry
      from public.trails where id = ${trip.trailId}`;
    if (!trail) return null;
    const [region, pois, narrations, provenance, closures, setting] = await Promise.all([
      tx<TripBundle["region"][]>`
        select name, timezone, is_demo, emergency_number, emergency_guidance from public.regions where id = ${trip.regionId}`,
      tx<BundlePoi[]>`
        select id, seq, name, kind, lat, lng, trigger_radius_m from public.trail_pois where trail_id = ${trail.id} order by seq`,
      tx<NarrationRow[]>`
        select n.id, n.poi_id, n.title, n.transcript, n.audio_path, n.duration_sec, n.source_citation, s.label as source_label, n.version
        from public.narrations n join public.sources s on s.id = n.source_id
        where n.trail_id = ${trail.id} and n.status = 'approved' and n.approved_at is not null
        order by n.created_at`,
      tx<{ field: string; kind: string; note: string | null }[]>`
        select field, kind, note from public.trail_field_provenance where trail_id = ${trail.id} order by field`,
      tx<{ severity: string; reason: string; endsAt: Date | null }[]>`
        select severity, reason, ends_at from public.trail_closures
        where trail_id = ${trail.id} and starts_at <= now() and (ends_at is null or ends_at > now())
        order by starts_at desc`,
      tx<{ value: unknown }[]>`select value from public.app_settings where key = 'stale_location_minutes'`,
    ]);
    return { trail, region: region[0], pois, narrations, provenance, closures, staleMinutes: Number(setting[0]?.value) || DEFAULT_STALE_MINUTES };
  });
  if (!catalog || !catalog.region) return notFound("Trip not found");
  if (!catalog.trail.geometry) return conflict("This trail's route is not available for offline use yet.");

  const personal = await withUser(user, async (tx) => {
    const [checkin] = await tx<{ status: CheckinStatus; expectedReturnAt: Date; graceMinutes: number }[]>`
      select status, expected_return_at, grace_minutes from public.trip_checkins where trip_id = ${trip.id} and user_id = ${user.id}`;
    const [session] = await tx<{ id: string; status: "active" | "paused" | "finished" | "abandoned"; startedAt: Date; finishedAt: Date | null }[]>`
      select id, status, started_at, finished_at from public.hike_sessions
      where trip_id = ${trip.id} and user_id = ${user.id}
      order by (status in ('active', 'paused')) desc, started_at desc limit 1`;
    // Stops already narrated in that session: a device that lost (or never had) its local state must not replay them.
    const heard = session
      ? await tx<{ poiId: string }[]>`
          select distinct payload->>'poiId' as poi_id from public.hike_events
          where hike_session_id = ${session.id} and user_id = ${user.id}
            and kind in ('poi_triggered', 'poi_replayed') and payload ? 'poiId'`
      : [];
    const when = await bookedDateFor(tx, trip.id);
    return { checkin: checkin ?? null, session: session ?? null, heardPoiIds: heard.map((h) => h.poiId), bookedDate: when?.bookedDate ?? trip.plannedDate };
  });

  const narrations: BundleNarration[] = await Promise.all(
    catalog.narrations.map(async (n) => {
      let audioUrl: string | null = null;
      if (n.audioPath) {
        try {
          audioUrl = await storage().signedUrl(n.audioPath, AUDIO_URL_TTL_SEC);
        } catch (err) {
          log.warn("hike.bundle.audio_url_failed", { narrationId: n.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return {
        id: n.id,
        poiId: n.poiId,
        title: n.title,
        transcript: n.transcript,
        sourceCitation: n.sourceCitation ?? n.sourceLabel,
        audioUrl,
        tts: audioUrl === null,
        durationSec: n.durationSec,
        version: n.version,
      };
    }),
  );

  const geometryJson = JSON.stringify(catalog.trail.geometry);
  const geometryChecksum = sha256Hex(geometryJson);
  const base = `/trips/${trip.id}`;
  const bundleUrl = `/api/trips/${trip.id}/bundle`;
  const items: ManifestItem[] = [
    { key: "page:hike", kind: "page", url: `${base}/hike`, label: "Hike screen" },
    { key: "page:help", kind: "page", url: `${base}/help`, label: "Help screen" },
    { key: "data:bundle", kind: "data", url: bundleUrl, label: "Trip data" },
    { key: "data:geometry", kind: "data", url: bundleUrl, sha256: geometryChecksum, label: "Route geometry" },
    ...narrations
      .filter((n) => n.audioUrl)
      .map((n): ManifestItem => ({ key: `audio:${n.id}`, kind: "audio", url: n.audioUrl!, label: `Narration audio: ${n.title}` })),
  ];
  const { trail } = catalog;
  return ok({
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    ownerHint: ownerHint(env().AUTH_SECRET, user.id),
    notificationsSimulated: integrationStatus().notifications === "simulated",
    trip: {
      id: trip.id,
      status: trip.status,
      plannedDate: trip.plannedDate,
      bookedDate: personal.bookedDate,
      startTime: trip.startTime,
      partySize: trip.partySize,
      itinerary: trip.itinerary,
    },
    trail: {
      id: trail.id,
      slug: trail.slug,
      name: trail.name,
      summary: trail.summary,
      isDemo: trail.isDemo,
      distanceKm: trail.distanceKm,
      elevationGainM: trail.elevationGainM,
      difficulty: trail.difficulty,
      routeType: trail.routeType,
      estimatedDurationMin: trail.estimatedDurationMin,
      trailheadName: trail.trailheadName,
      trailheadLat: trail.trailheadLat,
      trailheadLng: trail.trailheadLng,
      parkingInfo: trail.parkingInfo,
      permitRequired: trail.permitRequired,
      provenance: catalog.provenance,
      provenanceSummary: summarizeProvenance(trail.isDemo, catalog.provenance),
      closures: catalog.closures.map((c) => ({ severity: c.severity, reason: c.reason, endsAt: c.endsAt?.toISOString() ?? null })),
    },
    geometryJson,
    geometryChecksum,
    pois: catalog.pois,
    narrations,
    region: catalog.region,
    expectedReturnAt: personal.checkin?.expectedReturnAt.toISOString() ?? null,
    checkin: personal.checkin
      ? { status: personal.checkin.status, expectedReturnAt: personal.checkin.expectedReturnAt.toISOString(), graceMinutes: personal.checkin.graceMinutes }
      : null,
    session: personal.session
      ? {
          id: personal.session.id,
          status: personal.session.status,
          startedAt: personal.session.startedAt.toISOString(),
          finishedAt: personal.session.finishedAt?.toISOString() ?? null,
          heardPoiIds: personal.heardPoiIds,
        }
      : null,
    settings: { staleLocationMinutes: catalog.staleMinutes },
    manifest: { version: MANIFEST_VERSION, generatedAt: now.toISOString(), items },
  });
}
