/**
 * Page-side messaging with the service worker (public/sw.js).
 * Messages: CACHE_TRIP {tripId, urls: (url | {url, as})[], ownerHint}, VERIFY_TRIP {tripId, urls}, DELETE_TRIP {tripId},
 * CLEAR_ALL (sign-out: every trip cache).
 * Replies arrive on a MessageChannel port.
 */
export interface CacheResult {
  url: string;
  ok: boolean;
  status: number;
  error?: string;
  /** the stable key it was stored under, when one was requested */
  as?: string;
}

/** A URL to store, or a URL to fetch and store under a stable same-origin key (narration audio). */
export type CacheRequest = string | { url: string; as: string };

export interface CacheTripReply {
  type: "CACHE_TRIP_RESULT";
  tripId: string;
  results: CacheResult[];
  /** static app files discovered in the cached pages (and cached alongside them) */
  assets: string[];
}

export interface VerifyTripReply {
  type: "VERIFY_TRIP_RESULT";
  tripId: string;
  present: Record<string, boolean>;
}

export interface CacheProgress {
  type: "CACHE_TRIP_PROGRESS";
  done: number;
  total: number;
}

export function serviceWorkerSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

/** The active service worker, waiting up to `timeoutMs` for registration. */
export async function activeServiceWorker(timeoutMs = 8000): Promise<ServiceWorker | null> {
  if (!serviceWorkerSupported()) return null;
  const ready = navigator.serviceWorker.ready.then((r) => r.active);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  return (await Promise.race([ready, timeout])) ?? null;
}

export async function postToServiceWorker<T>(
  message: Record<string, unknown>,
  opts: { timeoutMs?: number; onProgress?: (p: CacheProgress) => void } = {},
): Promise<T> {
  const sw = await activeServiceWorker();
  if (!sw) throw new Error("Offline support is not active in this browser yet. Reload the page and try again.");
  return new Promise<T>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("The offline cache did not respond in time."));
    }, opts.timeoutMs ?? 120_000);
    channel.port1.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: string };
      if (data?.type === "CACHE_TRIP_PROGRESS") {
        opts.onProgress?.(data as CacheProgress);
        return;
      }
      clearTimeout(timer);
      channel.port1.close();
      if (data?.type === "ERROR") reject(new Error((data as { error?: string }).error ?? "Service worker error"));
      else resolve(data as T);
    };
    sw.postMessage(message, [channel.port2]);
  });
}

export const cacheTripUrls = (tripId: string, urls: CacheRequest[], onProgress?: (p: CacheProgress) => void, ownerHint?: string) =>
  postToServiceWorker<CacheTripReply>({ type: "CACHE_TRIP", tripId, urls, ownerHint }, { onProgress, timeoutMs: 300_000 });

export const verifyTripUrls = (tripId: string, urls: string[]) => postToServiceWorker<VerifyTripReply>({ type: "VERIFY_TRIP", tripId, urls });

export const deleteTripCache = (tripId: string) => postToServiceWorker<{ type: "DELETE_TRIP_RESULT"; deleted: boolean }>({ type: "DELETE_TRIP", tripId });

export const clearAllTripCaches = () => postToServiceWorker<{ type: "CLEAR_ALL_RESULT"; deleted: number }>({ type: "CLEAR_ALL" }, { timeoutMs: 10_000 });
