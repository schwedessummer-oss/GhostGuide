/**
 * Shared-device privacy for downloaded trips.
 *
 * Offline trip data (bundles, hike state with the last device location,
 * queued location points, the service worker's trip caches) is tagged with
 * the owner hint of the account it was issued to (TripBundle.ownerHint). The
 * readable `gg_owner` cookie carries the hint of whoever is signed in on this
 * browser (set at sign-in and by the bundle API, deleted at sign-out; see
 * src/server/auth/owner-hint.ts). The offline screens (hike, help, offline
 * fallback list) call `enforceDeviceOwner()` before showing anything: data
 * whose tag differs from the cookie — or any data when the cookie is absent —
 * is never rendered and is purged from the device.
 */
import { deleteStoredBundle, listStoredBundles, putStoredBundle } from "./bundle-store";
import { deleteHikeState, listHikeStates, saveHikeState } from "./hike-state";
import { idbClear, idbOutboxDeleteForTrip } from "./idb";

/** Keep in sync with OWNER_HINT_COOKIE in src/server/auth/owner-hint.ts (that module is server-only). */
export const OWNER_COOKIE = "gg_owner";
export const TRIP_CACHE_PREFIX = "gg-trip-v1-";
export const SIGN_IN_AGAIN = "Sign in again to use this trip offline";

const HINT_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** The owner hint in a Cookie header / document.cookie string, or null. */
export function parseOwnerCookie(cookie: string | null | undefined): string | null {
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== OWNER_COOKIE) continue;
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      return null;
    }
    return HINT_RE.test(v) ? v : null;
  }
  return null;
}

/** Owner hint of the account signed in on this browser (null when signed out). */
export function currentOwnerHint(): string | null {
  try {
    return typeof document === "undefined" ? null : parseOwnerCookie(document.cookie);
  } catch {
    return null;
  }
}

export type OwnershipDecision = "keep" | "retag" | "purge";

/**
 * What to do with one trip's on-device data.
 * `confirmedHint`: the server has just issued this trip's bundle to the
 * signed-in user (so data for this trip id is theirs, even if it predates the
 * tag); it is then re-tagged instead of purged.
 */
export function ownershipDecision(input: {
  owner: string | null;
  hints: (string | null | undefined)[];
  confirmedHint?: string | null;
}): OwnershipDecision {
  const { owner, hints, confirmedHint } = input;
  if (!owner) return "purge";
  const allMatch = hints.every((h) => h === owner);
  if (allMatch) return "keep";
  if (confirmedHint && confirmedHint === owner) return "retag";
  return "purge";
}

async function deleteTripCache(tripId: string): Promise<void> {
  try {
    if (typeof caches !== "undefined") await caches.delete(TRIP_CACHE_PREFIX + tripId);
  } catch {
    /* ignore */
  }
}

/** Remove one trip's offline data from this device: bundle, hike state (+ mirror), queued outbox items and cached pages. */
export async function purgeTripFromDevice(tripId: string): Promise<void> {
  await Promise.allSettled([deleteStoredBundle(tripId), deleteHikeState(tripId), idbOutboxDeleteForTrip(tripId), deleteTripCache(tripId)]);
}

async function purgeEverything(tripIds: Iterable<string>): Promise<void> {
  const ids = [...tripIds];
  await Promise.allSettled([...ids.map(purgeTripFromDevice), idbClear("outbox")]);
  try {
    if (typeof caches !== "undefined") {
      for (const name of await caches.keys()) if (name.startsWith(TRIP_CACHE_PREFIX)) await caches.delete(name);
    }
  } catch {
    /* ignore */
  }
}

export interface OwnerCheck {
  owner: string | null;
  /** trips whose data was removed because it is not the signed-in account's */
  purged: string[];
}

/**
 * Check every downloaded trip on this device against the signed-in account
 * and purge whatever is not theirs. Call before rendering offline data.
 */
export async function enforceDeviceOwner(opts: { confirmed?: { tripId: string; ownerHint: string } } = {}): Promise<OwnerCheck> {
  const owner = currentOwnerHint();
  const [bundles, states] = await Promise.all([listStoredBundles().catch(() => []), listHikeStates().catch(() => [])]);
  const ids = new Set([...bundles.map((b) => b.tripId), ...states.map((s) => s.tripId)]);
  if (!owner) {
    // Signed out on this browser: nothing downloaded may be shown to whoever uses it next.
    await purgeEverything(ids);
    return { owner, purged: [...ids] };
  }
  const purged: string[] = [];
  for (const tripId of ids) {
    const b = bundles.find((x) => x.tripId === tripId);
    const s = states.find((x) => x.tripId === tripId);
    const decision = ownershipDecision({
      owner,
      hints: [...(b ? [b.bundle.ownerHint] : []), ...(s ? [s.ownerHint] : [])],
      confirmedHint: opts.confirmed?.tripId === tripId ? opts.confirmed.ownerHint : null,
    });
    if (decision === "keep") continue;
    if (decision === "retag") {
      await Promise.allSettled([
        b && b.bundle.ownerHint !== owner ? putStoredBundle({ ...b, bundle: { ...b.bundle, ownerHint: owner } }) : null,
        s && s.ownerHint !== owner ? saveHikeState({ ...s, ownerHint: owner }) : null,
      ]);
      continue;
    }
    await purgeTripFromDevice(tripId);
    purged.push(tripId);
  }
  return { owner, purged };
}
