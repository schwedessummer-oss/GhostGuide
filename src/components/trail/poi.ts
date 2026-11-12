/**
 * Outdoor POI groups shown on the trail map and in its legend (pure).
 * Colours are chosen for contrast on the light basemap and are always paired
 * with a text label in the legend/list (never colour alone).
 */
import type { Bbox, OutdoorPoiCategory, PoiCategory, PoiDto } from "@/domain/catalog";
import { poiCategoryLabel } from "./format";

export type PoiGroupKey = "access" | "facilities" | "water" | "sights" | "overnight";

export interface PoiGroupStyle {
  key: PoiGroupKey;
  label: string;
  color: string;
  categories: readonly OutdoorPoiCategory[];
}

export const POI_GROUPS: readonly PoiGroupStyle[] = [
  { key: "access", label: "Trailhead & parking", color: "#1e4f9c", categories: ["trailhead", "parking"] },
  {
    key: "facilities",
    label: "Facilities",
    color: "#4b5563",
    categories: ["toilets", "information", "ranger_station", "picnic_site"],
  },
  { key: "water", label: "Water", color: "#0e7490", categories: ["drinking_water", "spring", "waterfall", "lake"] },
  { key: "sights", label: "Sights", color: "#9a3412", categories: ["viewpoint", "peak", "cave"] },
  { key: "overnight", label: "Shelter & camping", color: "#35704d", categories: ["shelter", "campsite"] },
];

const GROUP_BY_CATEGORY = new Map<string, PoiGroupStyle>(POI_GROUPS.flatMap((g) => g.categories.map((c) => [c, g] as const)));

export function poiGroupOf(category: PoiCategory): PoiGroupStyle | null {
  return GROUP_BY_CATEGORY.get(category) ?? null;
}

/** Display order of categories in the list below the map. */
export const POI_CATEGORY_ORDER: readonly OutdoorPoiCategory[] = POI_GROUPS.flatMap((g) => g.categories);

export interface PoiCategoryList {
  category: OutdoorPoiCategory;
  label: string;
  color: string;
  items: PoiDto[];
}

/** Outdoor POIs grouped by category in display order (services and unknown categories dropped). */
export function groupPoisByCategory(pois: PoiDto[]): PoiCategoryList[] {
  const out: PoiCategoryList[] = [];
  for (const category of POI_CATEGORY_ORDER) {
    const items = pois.filter((p) => p.category === category);
    if (!items.length) continue;
    const group = poiGroupOf(category)!;
    out.push({ category, label: poiCategoryLabel(category, items.length > 1), color: group.color, items });
  }
  return out;
}

/**
 * View bounds: the route's bbox extended to the trailhead and mapped POIs
 * (all within ~600 m of the route), padded by a fraction of the size (at
 * least ~150 m) with extra room at the bottom for the attribution bar.
 */
export function mapViewBounds(b: Bbox, points: { lng: number; lat: number }[]): Bbox {
  let [w, s, e, n] = b;
  for (const p of points) {
    if (!Number.isFinite(p.lng) || !Number.isFinite(p.lat)) continue;
    w = Math.min(w, p.lng);
    e = Math.max(e, p.lng);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  }
  const dx = Math.max((e - w) * 0.06, 0.0015);
  const dy = Math.max((n - s) * 0.06, 0.0015);
  return [w - dx, s - dy * 2, e + dx, n + dy];
}
