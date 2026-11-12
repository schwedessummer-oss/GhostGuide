import "server-only";
import type { Bbox, CatalogLayer } from "@/domain/catalog";
import { log } from "@/server/log";
import type { ProviderId, TrailDataProvider } from "@/server/trails/types";
import { osmProvider } from "./osm";
import { ridbProvider } from "./ridb";

/**
 * Registry of trail data providers.
 *
 * Adding a provider (e.g. Recreation.gov RIDB) is one line: append it to
 * TRAIL_PROVIDERS (and, if its upstream limits concurrent requests, to
 * FETCH_CONCURRENCY). Coverage (src/server/trails/coverage.ts) then creates
 * tiles for it wherever it is enabled, supports the layer and covers the
 * area; ingestion (src/server/trails/ingest.ts) looks it up by id.
 *
 * Order matters only for display (attribution, status messages).
 */
export const TRAIL_PROVIDERS: readonly TrailDataProvider[] = [osmProvider, ridbProvider];

/**
 * Most tiles of one provider that may be fetching at the same time across
 * ALL workers (enforced atomically when a tile is claimed). The public
 * Overpass instance allows about two concurrent queries per IP address.
 */
export const FETCH_CONCURRENCY: Partial<Record<ProviderId, number>> = { osm: 2 };
/** Cap for providers without an entry in FETCH_CONCURRENCY. */
export const DEFAULT_FETCH_CONCURRENCY = 4;

export function fetchConcurrencyFor(id: string): number {
  return FETCH_CONCURRENCY[id as ProviderId] ?? DEFAULT_FETCH_CONCURRENCY;
}

/** A provider callback that throws is treated as "no" (never breaks coverage). */
function safely(provider: TrailDataProvider, what: string, fn: () => boolean): boolean {
  try {
    return fn() === true;
  } catch (err) {
    log.warn("catalog.provider_check_failed", { provider: provider.id, check: what, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Provider by id (enabled or not), or null for unknown ids. */
export function providerById(id: string): TrailDataProvider | null {
  return TRAIL_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** Enabled providers that serve a layer, anywhere. */
export function enabledProviders(layer: CatalogLayer): TrailDataProvider[] {
  return TRAIL_PROVIDERS.filter((p) => p.layers.includes(layer) && safely(p, "isEnabled", () => p.isEnabled()));
}

/** Enabled providers that support `layer` and have data for (part of) `bbox`. */
export function providersFor(layer: CatalogLayer, bbox: Bbox): TrailDataProvider[] {
  return enabledProviders(layer).filter((p) => safely(p, "covers", () => p.covers(bbox)));
}

/** "OpenStreetMap", "OpenStreetMap and Recreation.gov", "A, B and C". */
export function providerLabelList(providers: readonly Pick<TrailDataProvider, "label">[]): string {
  const labels = [...new Set(providers.map((p) => p.label))];
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
