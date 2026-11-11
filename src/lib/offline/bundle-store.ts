/**
 * Downloaded trip bundles in IndexedDB. The hike and help screens read the
 * bundle from here so they work with no connection at all.
 */
import type { TripBundle } from "./wire";
import { idbDelete, idbGet, idbGetAll, idbPut } from "./idb";

export interface DownloadVerification {
  checkedAt: number;
  complete: boolean;
  missing: string[];
  corrupted: string[];
  itemCount: number;
  manifestChecksum: string;
  /** plain-language problems, if any */
  details: string[];
}

export interface StoredBundle {
  tripId: string;
  bundle: TripBundle;
  storedAt: number;
  /** "download" = explicit offline download; "online" = fetched while online (not verified for offline use) */
  source: "download" | "online";
  /** static app files the service worker cached for the hike/help pages */
  assetUrls: string[];
  verification: DownloadVerification | null;
}

export const getStoredBundle = (tripId: string) => idbGet<StoredBundle>("bundles", tripId);
export const putStoredBundle = (b: StoredBundle) => idbPut("bundles", b);
export const deleteStoredBundle = (tripId: string) => idbDelete("bundles", tripId);
export const listStoredBundles = () => idbGetAll<StoredBundle>("bundles");

export type BundleFetchErrorKind = "offline" | "auth" | "not_found" | "not_bookable" | "server" | "slow";

export class BundleFetchError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 = the request never reached the server */
    readonly status: number,
    readonly kind: BundleFetchErrorKind = status === 0 ? "offline" : status === 401 ? "auth" : status === 404 ? "not_found" : status === 409 ? "not_bookable" : "server",
  ) {
    super(message);
  }
}

/** Response headers set by public/sw.js on answers it made up or served from a trip cache. */
export const SW_OFFLINE_HEADER = "x-gg-offline";
export const SW_SOURCE_HEADER = "x-gg-source";

export const OFFLINE_NOT_DOWNLOADED = "You're offline and this trip isn't downloaded on this device.";

export interface FetchedBundle {
  bundle: TripBundle;
  /** "network" = the server just issued it to the signed-in user; "cache" = the service worker's offline copy */
  source: "network" | "cache";
}

/**
 * Fetch the bundle from the API (network-first; offline, the service worker
 * may answer from its trip cache, which is reported as `source: "cache"`).
 * Errors say why: offline, signed out (401), not yours (404), not bookable
 * (409) or a server problem.
 */
export async function fetchBundleDetailed(tripId: string): Promise<FetchedBundle> {
  let res: Response;
  try {
    res = await fetch(`/api/trips/${tripId}/bundle`, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
  } catch {
    throw new BundleFetchError(OFFLINE_NOT_DOWNLOADED, 0);
  }
  if (res.headers.get(SW_OFFLINE_HEADER)) throw new BundleFetchError(OFFLINE_NOT_DOWNLOADED, 0);
  if (!res.ok) {
    const msg =
      res.status === 401
        ? "Your session expired. Sign in again to download this trip."
        : res.status === 404
          ? "Trip not found."
          : res.status === 409
            ? ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "This trip can't be downloaded."
            : `The server could not prepare your trip (error ${res.status}). Try again.`;
    throw new BundleFetchError(msg, res.status);
  }
  const bundle = (await res.json()) as TripBundle;
  return { bundle, source: res.headers.get(SW_SOURCE_HEADER) === "cache" ? "cache" : "network" };
}

/** Fetch a fresh bundle from the server (an offline copy from the service worker counts as offline). */
export async function fetchBundle(tripId: string): Promise<TripBundle> {
  const r = await fetchBundleDetailed(tripId);
  if (r.source !== "network") throw new BundleFetchError(OFFLINE_NOT_DOWNLOADED, 0);
  return r.bundle;
}
