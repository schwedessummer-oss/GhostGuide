/**
 * When to draw terrain hillshade (pure; used by MapView).
 *
 * Hillshade costs one Terrarium DEM tile (~100–140 KB PNG) per visible tile,
 * roughly 0.5–1.5 MB per map view, only to draw a light shade. So it is
 * drawn only where it helps:
 *  - `"wide"` (MapView's default): only on wide maps, e.g. a trail page on a
 *    desktop, never on phones; `false`: never (Explore, where every pan
 *    would fetch more); `true`: at any width, where the device allows;
 *  - never drawn when the browser asks to save data (Save-Data / reduced data);
 *  - only from HILLSHADE_MIN_ZOOM, where relief helps read a trail (MapLibre
 *    fetches no DEM tiles for a layer hidden at the current zoom);
 *  - off everywhere when NEXT_PUBLIC_MAP_TERRAIN_TILES_URL is "off".
 */
export type HillshadeMode = boolean | "wide";

/** Container width (CSS px) from which a "wide" map draws hillshade. */
export const HILLSHADE_MIN_WIDTH_PX = 768;
/** Lowest zoom at which the hillshade layer (and so its tile downloads) is active. */
export const HILLSHADE_MIN_ZOOM = 10;

export interface HillshadeContext {
  /** The map container's width, CSS px. */
  width: number;
  /** navigator.connection.saveData, or prefers-reduced-data. */
  saveData: boolean;
  /** The configured terrain tile URL ("off" disables hillshade). */
  tilesUrl: string;
}

export function wantsHillshade(mode: HillshadeMode | undefined, ctx: HillshadeContext): boolean {
  if (!mode || ctx.tilesUrl === "off" || !ctx.tilesUrl || ctx.saveData) return false;
  if (mode === "wide") return ctx.width >= HILLSHADE_MIN_WIDTH_PX;
  return true;
}

/** Whether this browser asks sites to use less data. */
export function browserSavesData(): boolean {
  try {
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (conn?.saveData) return true;
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-data: reduce)").matches;
  } catch {
    return false;
  }
}
