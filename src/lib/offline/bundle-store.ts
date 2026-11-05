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

export class BundleFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Fetch the bundle from the API (network-first; the SW may answer from its trip cache offline). */
export async function fetchBundle(tripId: string): Promise<TripBundle> {
  let res: Response;
  try {
    res = await fetch(`/api/trips/${tripId}/bundle`, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
  } catch {
    throw new BundleFetchError("You're offline and this trip isn't downloaded on this device.", 0);
  }
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
  return (await res.json()) as TripBundle;
}
