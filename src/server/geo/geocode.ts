import "server-only";
import type { GeocodeResponse } from "@/domain/catalog";

/**
 * Place search and reverse geocoding (Nominatim by default).
 * STUB — implemented in Phase 1 (search workstream). Signatures are fixed.
 */

export interface AdminArea {
  countryCode: string | null; // ISO 3166-1 alpha-2, lower case
  regionName: string | null; // state / province / prefecture
  nearestPlace: string | null; // city / town / village / hamlet
}

/** Forward geocoding for a free-text query ("Banff", "trails near Denver"). Cached; never throws. */
export async function geocodePlaces(query: string): Promise<GeocodeResponse> {
  void query;
  throw new Error("geocodePlaces: not implemented");
}

/** Administrative names for a point (cached on a ~0.1° grid). Null when unavailable; never throws. */
export async function reverseAdminArea(lat: number, lng: number): Promise<AdminArea | null> {
  void lat;
  void lng;
  throw new Error("reverseAdminArea: not implemented");
}
