/**
 * Offline trip download: fetch the bundle, verify the route checksum, store
 * it in IndexedDB, ask the service worker to cache the hike/help pages (and
 * the static files those pages load), narration audio and the bundle, then
 * verify completeness and record the download on the server.
 */
import {
  assetItems,
  canonicalManifestJson,
  checkCompleteness,
  describeCompleteness,
  storedUrlOf,
  type ManifestItem,
  type OfflineManifest,
} from "@/domain/offline-manifest";
import { deleteStoredBundle, fetchBundle, getStoredBundle, putStoredBundle, type DownloadVerification, type StoredBundle } from "./bundle-store";
import { sha256Hex } from "./hash";
import { cacheTripUrls, deleteTripCache, serviceWorkerSupported, verifyTripUrls, type CacheProgress, type CacheRequest } from "./sw-client";
import type { TripBundle } from "./wire";

export type DownloadPhase = "fetching" | "caching" | "verifying" | "recording";

export interface DownloadProgress {
  phase: DownloadPhase;
  done: number;
  total: number;
  message: string;
}

/** The full manifest = server items + the pages' static files discovered by the service worker. */
export function fullManifest(bundle: TripBundle, assetUrls: string[]): OfflineManifest {
  return { ...bundle.manifest, items: [...bundle.manifest.items, ...assetItems(assetUrls)] };
}

async function geometryVerified(bundle: TripBundle): Promise<boolean> {
  const expected = bundle.manifest.items.find((i) => i.key === "data:geometry")?.sha256 ?? bundle.geometryChecksum;
  return (await sha256Hex(bundle.geometryJson)) === expected && expected === bundle.geometryChecksum;
}

/** What to ask the service worker to store for an item (audio goes under its stable key). */
const cacheRequestOf = (i: ManifestItem): CacheRequest => (i.cacheAs ? { url: i.url, as: i.cacheAs } : i.url);

/** Re-check a stored download: presence of every item (under the key it is stored as) and checksums. */
export async function verifyTrip(tripId: string): Promise<DownloadVerification | null> {
  const stored = await getStoredBundle(tripId);
  if (!stored) return null;
  const manifest = fullManifest(stored.bundle, stored.assetUrls);
  const cachedUrls = [...new Set(manifest.items.filter((i) => i.kind !== "data").map(storedUrlOf))];
  let present: Record<string, boolean> = {};
  if (serviceWorkerSupported()) {
    try {
      present = (await verifyTripUrls(tripId, cachedUrls)).present;
    } catch {
      present = {};
    }
  }
  // Data items live in IndexedDB (this record); pages, assets and audio in the SW trip cache.
  const presentKeys = manifest.items.filter((i) => (i.kind === "data" ? true : present[storedUrlOf(i)] === true)).map((i) => i.key);
  const checksums = { "data:geometry": await geometryVerified(stored.bundle) };
  const result = checkCompleteness(manifest, presentKeys, checksums);
  const verification: DownloadVerification = {
    checkedAt: Date.now(),
    ...result,
    itemCount: manifest.items.length,
    manifestChecksum: await sha256Hex(canonicalManifestJson(manifest)),
    details: describeCompleteness(result, manifest),
  };
  await putStoredBundle({ ...stored, verification });
  return verification;
}

async function recordOnServer(tripId: string, bundle: TripBundle, v: DownloadVerification): Promise<void> {
  try {
    await fetch(`/api/trips/${tripId}/download`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifestVersion: bundle.manifest.version, manifestChecksum: v.manifestChecksum, itemCount: v.itemCount, verifiedComplete: v.complete }),
    });
  } catch {
    /* best effort: the download itself is what matters */
  }
}

export async function downloadTrip(tripId: string, onProgress: (p: DownloadProgress) => void = () => {}): Promise<DownloadVerification> {
  onProgress({ phase: "fetching", done: 0, total: 1, message: "Getting your trip details…" });
  const bundle = await fetchBundle(tripId);
  if (!(await geometryVerified(bundle))) throw new Error("The route data failed its integrity check. Try downloading again.");

  const previous = await getStoredBundle(tripId);
  const record: StoredBundle = { tripId, bundle, storedAt: Date.now(), source: "download", assetUrls: previous?.assetUrls ?? [], verification: null };
  await putStoredBundle(record);

  let assetUrls: string[] = [];
  if (serviceWorkerSupported()) {
    const pages = bundle.manifest.items.filter((i) => i.kind === "page").map((i) => i.url);
    const others: CacheRequest[] = [];
    const seen = new Set<string>();
    for (const i of bundle.manifest.items) {
      if (i.kind === "page" || seen.has(storedUrlOf(i))) continue;
      seen.add(storedUrlOf(i));
      others.push(cacheRequestOf(i));
    }
    onProgress({ phase: "caching", done: 0, total: pages.length + others.length, message: "Saving pages, audio and route for offline use…" });
    try {
      // Start from a clean cache so removed narration or old app files do not linger.
      await deleteTripCache(tripId).catch(() => undefined);
      const reply = await cacheTripUrls(
        tripId,
        [...pages, ...others],
        (p: CacheProgress) => onProgress({ phase: "caching", done: p.done, total: p.total, message: `Saving files for offline use (${p.done} of ${p.total})…` }),
        bundle.ownerHint,
      );
      assetUrls = reply.assets ?? [];
    } catch (err) {
      // Pages could not be cached; the bundle is still stored and verification will say what is missing.
      console.warn("Offline caching failed", err);
    }
  }
  await putStoredBundle({ ...record, assetUrls });

  onProgress({ phase: "verifying", done: 0, total: 1, message: "Checking the download is complete…" });
  const verification = (await verifyTrip(tripId))!;
  onProgress({ phase: "recording", done: 1, total: 1, message: "Done" });
  await recordOnServer(tripId, bundle, verification);
  return verification;
}

/**
 * After a downloaded trip's bundle was refreshed online (the hike screen does
 * this on open): re-check the download against the NEW manifest and, while
 * online, store whatever is missing (e.g. narration added or re-recorded
 * since). Audio is keyed by narration id + version, so audio downloaded
 * earlier stays valid even though every bundle signs new audio URLs.
 */
export async function refreshDownloadedTrip(tripId: string): Promise<DownloadVerification | null> {
  const first = await verifyTrip(tripId);
  if (!first || first.complete || !serviceWorkerSupported() || (typeof navigator !== "undefined" && !navigator.onLine)) return first;
  const stored = await getStoredBundle(tripId);
  if (!stored) return first;
  const missing = fullManifest(stored.bundle, stored.assetUrls).items.filter((i) => i.kind !== "data" && first.missing.includes(i.key));
  if (!missing.length) return first;
  try {
    const reply = await cacheTripUrls(tripId, missing.map(cacheRequestOf), undefined, stored.bundle.ownerHint);
    if (reply.assets?.length) {
      const latest = await getStoredBundle(tripId);
      if (latest) await putStoredBundle({ ...latest, assetUrls: [...new Set([...latest.assetUrls, ...reply.assets])] });
    }
  } catch {
    /* the verification below reports what is still missing */
  }
  return verifyTrip(tripId);
}

/** Remove the offline copy (bundle + cached files). Queued hike data is kept until it syncs. */
export async function removeTripDownload(tripId: string): Promise<void> {
  if (serviceWorkerSupported()) await deleteTripCache(tripId).catch(() => undefined);
  await deleteStoredBundle(tripId);
}
