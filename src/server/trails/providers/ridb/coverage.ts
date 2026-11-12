import "server-only";
import type { Bbox } from "@/domain/catalog";

/**
 * Where Recreation.gov RIDB has data: the United States (federal recreation
 * sites), approximated by a union of boxes [west, south, east, north].
 *
 * Goals, in order:
 *  1. No false negatives: every US state and the territories listed below
 *     are inside at least one box (a miss would silently drop official
 *     data). Boxes therefore err on the generous side by ~0.05°.
 *  2. Few false positives: boxes are split along the Canadian and Mexican
 *     borders so that tiles deep inside Canada or Mexico (Toronto, Montreal,
 *     Vancouver, Victoria, Whitehorse, Monterrey, Chihuahua, ...) do not get
 *     a pointless RIDB request or a "Recreation.gov" attribution. Thin
 *     slivers of foreign land next to the border remain (e.g. Ciudad Juárez,
 *     Windsor ON, Mexicali, Edmundston NB): tiles there also contain US land.
 *
 * Coverage test: positive-area overlap (an area that only touches a box edge
 * is not covered), so tiles on the 0.25° grid that merely share an edge with
 * a box are excluded.
 *
 * Not covered: US Minor Outlying Islands other than Midway (Wake, Johnston,
 * Palmyra, Jarvis, Howland/Baker, Navassa), which have no RIDB facilities
 * open to visitors.
 */
export interface CoverageBox {
  name: string;
  bbox: Bbox;
}

const box = (name: string, w: number, s: number, e: number, n: number): CoverageBox => ({ name, bbox: [w, s, e, n] });

export const US_COVERAGE_BOXES: readonly CoverageBox[] = [
  // --- Pacific Northwest. Washington is split at 48.4°N so southern Vancouver
  // Island (Victoria, BC) stays out; the San Juan Islands and Point Roberts are in.
  box("Washington (south of 48.4°N)", -124.9, 45.5, -116.9, 48.4),
  box("Washington (north: San Juans to Okanogan)", -123.25, 48.3, -116.9, 49.0),
  box("Oregon", -124.75, 41.95, -116.4, 46.35),
  box("Idaho", -117.3, 41.95, -111.0, 49.0),
  box("Montana", -116.1, 44.3, -104.0, 49.0),
  box("Wyoming", -111.1, 40.95, -104.0, 45.05),

  // --- California and the Southwest. Southern Arizona steps along the
  // diagonal Sonora border; New Mexico's bootheel is separate.
  box("California", -124.55, 32.5, -114.1, 42.05),
  box("Nevada", -120.05, 34.95, -114.0, 42.05),
  box("Utah", -114.1, 36.95, -109.0, 42.05),
  box("Colorado", -109.1, 36.95, -102.0, 41.05),
  box("Arizona (north of 32.5°N)", -114.85, 32.5, -109.0, 37.05),
  box("Arizona (Yuma)", -114.85, 32.15, -113.9, 32.55),
  box("Arizona (Cabeza Prieta, Organ Pipe west)", -113.95, 31.85, -112.9, 32.55),
  box("Arizona (Organ Pipe east, Tohono O'odham)", -112.95, 31.55, -111.9, 32.55),
  box("Arizona (Tucson to the state line)", -111.95, 31.3, -109.0, 32.55),
  box("New Mexico (north of 31.78°N)", -109.1, 31.75, -103.0, 37.05),
  box("New Mexico (bootheel)", -109.1, 31.3, -108.15, 31.8),

  // --- Texas: north of 32°N in one box, then steps along the Rio Grande.
  box("Texas (north of 32°N)", -103.1, 31.9, -93.45, 36.55),
  box("Texas (El Paso)", -106.7, 31.6, -103.0, 32.05),
  box("Texas (Fabens to Fort Hancock)", -106.2, 31.2, -103.0, 31.65),
  box("Texas (Hudspeth, Culberson)", -105.9, 30.6, -103.0, 31.25),
  box("Texas (Presidio county north)", -105.35, 29.85, -103.0, 30.65),
  box("Texas (Pecos to the Gulf, 29.85–32°N)", -103.1, 29.85, -93.45, 31.95),
  box("Texas (Big Bend, Amistad, Del Rio)", -104.65, 28.95, -100.6, 29.95),
  box("Texas (Eagle Pass to the Gulf, 28.5–29.9°N)", -100.75, 28.5, -93.45, 29.9),
  box("Texas (south of Eagle Pass)", -100.4, 27.9, -93.45, 28.55),
  box("Texas (Laredo, Corpus Christi)", -99.8, 27.3, -93.45, 27.95),
  box("Texas (Zapata to Roma)", -99.6, 26.3, -93.45, 27.35),
  box("Texas (Rio Grande Valley)", -98.9, 25.8, -93.45, 26.4),

  // --- Great Plains and the Midwest. Minnesota is split so that Ontario
  // north of the Rainy River stays out; the Northwest Angle has its own box.
  box("North Dakota", -104.1, 45.9, -96.5, 49.0),
  box("South Dakota", -104.1, 42.45, -96.4, 46.0),
  box("Nebraska", -104.1, 39.95, -95.3, 43.05),
  box("Kansas", -102.1, 36.95, -94.55, 40.05),
  box("Oklahoma", -103.05, 33.6, -94.4, 37.05),
  box("Minnesota (south of 48°N)", -97.3, 43.45, -89.45, 48.05),
  box("Minnesota (Red River to Lake of the Woods)", -97.3, 48.0, -94.6, 49.0),
  box("Minnesota (Northwest Angle)", -95.2, 48.95, -94.75, 49.4),
  box("Minnesota (Rainy River, Boundary Waters)", -94.7, 47.95, -89.45, 48.75),
  box("Iowa", -96.7, 40.35, -90.1, 43.55),
  box("Missouri", -95.8, 35.95, -89.05, 40.65),
  box("Arkansas", -94.65, 32.95, -89.6, 36.55),
  box("Louisiana", -94.1, 28.9, -88.8, 33.05),
  box("Wisconsin", -92.95, 42.45, -86.2, 47.35),
  box("Michigan (incl. Isle Royale)", -90.45, 41.65, -82.4, 48.35),
  box("Illinois", -91.55, 36.95, -87.0, 42.55),
  box("Indiana", -88.15, 37.75, -84.75, 41.8),
  box("Ohio", -84.85, 38.35, -80.5, 42.35),
  box("Kentucky", -89.6, 36.45, -81.9, 39.2),
  box("Tennessee", -90.35, 34.95, -81.6, 36.7),

  // --- The South and the East. New York is split near 76.3°W so that Toronto
  // (north shore of Lake Ontario) and Kingston, ON stay out. Maine is split
  // at 45.9°N so that western New Brunswick stays out.
  box("Mississippi", -91.7, 30.1, -88.05, 35.05),
  box("Alabama", -88.5, 30.1, -84.85, 35.05),
  box("Georgia", -85.65, 30.3, -80.8, 35.05),
  box("Florida (incl. Keys and Dry Tortugas)", -87.65, 24.35, -79.95, 31.05),
  box("South Carolina", -83.4, 32.0, -78.5, 35.25),
  box("North Carolina", -84.35, 33.8, -75.4, 36.6),
  box("Virginia", -83.7, 36.5, -75.2, 39.5),
  box("West Virginia", -82.7, 37.15, -77.7, 40.65),
  box("Maryland, Delaware, DC", -79.5, 37.9, -75.0, 39.85),
  box("Pennsylvania", -80.55, 39.7, -74.65, 42.3),
  box("New Jersey", -75.6, 38.9, -73.85, 41.4),
  box("New York (west of 76.2°W, south shore of Lake Ontario)", -79.8, 41.95, -76.2, 43.5),
  box("New York (east of 76.45°W, incl. Long Island)", -76.45, 40.45, -71.8, 45.05),
  box("Connecticut, Rhode Island", -73.75, 40.95, -71.1, 42.1),
  box("Massachusetts", -73.55, 41.2, -69.9, 42.9),
  box("Vermont", -73.45, 42.7, -71.45, 45.05),
  box("New Hampshire", -72.6, 42.65, -70.6, 45.35),
  box("Maine (south of 45.9°N)", -71.1, 42.95, -66.9, 45.95),
  box("Maine (north of 45.9°N)", -70.4, 45.9, -67.75, 47.5),

  // --- Alaska. Split so that Yukon (east of 141°W) and Russia's Chukotka
  // (east of the antimeridian, west of the Bering Strait) stay out.
  box("Alaska (mainland west of 141°W, Kodiak)", -168.95, 54.3, -141.0, 71.5),
  box("Alaska (panhandle)", -141.0, 54.6, -129.95, 60.35),
  box("Alaska (Aleutians east of 180°, Pribilofs)", -180.0, 51.15, -162.0, 57.3),
  box("Alaska (Aleutians west of 180°: Near and Rat Islands)", 172.4, 51.3, 180.0, 53.1),
  box("Alaska (St. Lawrence Island)", -171.95, 62.85, -168.55, 63.9),
  box("Alaska (St. Matthew Island)", -173.15, 60.15, -172.15, 60.65),

  // --- Hawaii and the territories.
  box("Hawaii (main islands)", -160.6, 18.85, -154.7, 22.3),
  box("Hawaii (Northwestern Hawaiian Islands, Midway)", -178.4, 23.0, -161.8, 28.5),
  box("Puerto Rico (incl. Vieques, Culebra, Mona)", -67.95, 17.85, -65.2, 18.55),
  box("US Virgin Islands", -65.1, 17.65, -64.55, 18.41),
  box("Guam", 144.6, 13.2, 145.0, 13.7),
  box("Northern Mariana Islands", 144.85, 14.05, 146.1, 20.6),
  box("American Samoa (incl. Swains Island)", -171.1, -14.6, -168.1, -11.0),
];

function validBbox(b: unknown): b is Bbox {
  if (!Array.isArray(b) || b.length !== 4 || !b.every((n) => typeof n === "number" && Number.isFinite(n))) return false;
  const [w, s, e, n] = b as number[];
  return w >= -180 && e <= 180 && s >= -90 && n <= 90 && w < e && s < n;
}

/** Positive-area overlap of two boxes (touching edges do not count). */
export function boxesOverlap(a: Bbox, b: Bbox): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

/** Boxes of US_COVERAGE_BOXES that overlap `bbox` (empty for invalid input). */
export function usBoxesFor(bbox: Bbox): CoverageBox[] {
  if (!validBbox(bbox)) return [];
  return US_COVERAGE_BOXES.filter((b) => boxesOverlap(bbox, b.bbox));
}

/** Whether (part of) `bbox` lies in the United States as approximated above. */
export function coversUs(bbox: Bbox): boolean {
  return usBoxesFor(bbox).length > 0;
}
