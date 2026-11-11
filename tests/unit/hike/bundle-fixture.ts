import { localDateInZone } from "@/lib/time";
import type { TripBundle } from "@/lib/offline/wire";
import type { StoredBundle } from "@/lib/offline/bundle-store";
import { at, straightLine } from "./fixtures";

export const TZ = "America/Los_Angeles";
export const TRIP_ID = "11111111-1111-4111-8111-111111111111";
export const OWNER = "owner-hint-aaaaaaaaaaaa";
export const POI_A = "aaaaaaaa-0000-4000-8000-00000000000a";
export const POI_B = "bbbbbbbb-0000-4000-8000-00000000000b";
export const NARR_A = "aaaaaaaa-1111-4111-8111-11111111111a";
export const NARR_B = "bbbbbbbb-1111-4111-8111-11111111111b";

/** A 2 km straight route east of ORIGIN with two story stops (300 m and 1200 m along it). */
export function makeBundle(over: Partial<TripBundle> & { bookedDate?: string | null } = {}): TripBundle {
  const { bookedDate, ...rest } = over;
  const date = bookedDate === undefined ? localDateInZone(new Date(), TZ) : bookedDate;
  const a = at(300);
  const b = at(1200);
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    ownerHint: OWNER,
    notificationsSimulated: true,
    trip: { id: TRIP_ID, status: "booked", plannedDate: date, bookedDate: date, startTime: "08:30", partySize: 1, itinerary: { estimatedDurationMin: 60 } },
    trail: {
      id: "22222222-2222-4222-8222-222222222222",
      slug: "test-trail",
      name: "Test Trail",
      summary: "",
      isDemo: true,
      distanceKm: 2,
      elevationGainM: 10,
      difficulty: "easy",
      routeType: "point_to_point",
      estimatedDurationMin: 60,
      trailheadName: "Trailhead",
      trailheadLat: at(0).lat,
      trailheadLng: at(0).lng,
      parkingInfo: null,
      permitRequired: false,
      provenance: [],
      provenanceSummary: "Demonstration trail",
      closures: [],
    },
    geometryJson: JSON.stringify({ type: "LineString", coordinates: straightLine(2000) }),
    geometryChecksum: "x",
    pois: [
      { id: POI_A, seq: 1, name: "Stop A", kind: "history", lat: a.lat, lng: a.lng, triggerRadiusM: 30 },
      { id: POI_B, seq: 2, name: "Stop B", kind: "history", lat: b.lat, lng: b.lng, triggerRadiusM: 30 },
    ],
    narrations: [
      { id: NARR_A, poiId: POI_A, title: "Story A", transcript: "A".repeat(50), sourceCitation: "Demo", audioUrl: null, tts: true, durationSec: 30, version: 1 },
      { id: NARR_B, poiId: POI_B, title: "Story B", transcript: "B".repeat(50), sourceCitation: "Demo", audioUrl: null, tts: true, durationSec: 30, version: 1 },
    ],
    region: { name: "Ghost Ridge", timezone: TZ, isDemo: true, emergencyNumber: "911", emergencyGuidance: "" },
    expectedReturnAt: null,
    checkin: null,
    session: null,
    settings: { staleLocationMinutes: 15 },
    manifest: { version: 1, generatedAt: new Date().toISOString(), items: [] },
    ...rest,
  };
}

export function storedBundle(bundle: TripBundle = makeBundle()): StoredBundle {
  return { tripId: bundle.trip.id, bundle, storedAt: Date.now(), source: "download", assetUrls: [], verification: null };
}
