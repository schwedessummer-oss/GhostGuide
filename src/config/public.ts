/**
 * Client-safe configuration (NEXT_PUBLIC_* values are inlined at build time).
 * Never put secrets here.
 */

/** MapLibre style URL. Default: OpenFreeMap "liberty" (free, no key; OSM data). */
export const MAP_STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/liberty";

/**
 * Terrarium-encoded terrain tiles used for map hillshading (AWS Open Data
 * Terrain Tiles by default). Set to "off" to disable hillshade.
 */
export const MAP_TERRAIN_TILES_URL =
  process.env.NEXT_PUBLIC_MAP_TERRAIN_TILES_URL || "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png";

/** Attribution lines that must accompany maps and data views. */
export const MAP_ATTRIBUTION = {
  osm: { label: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright", license: "ODbL 1.0" },
  openFreeMap: { label: "OpenFreeMap", url: "https://openfreemap.org" },
  openMapTiles: { label: "© OpenMapTiles", url: "https://openmaptiles.org" },
  terrain: { label: "Terrain: AWS Open Data Terrain Tiles (Mapzen)", url: "https://registry.opendata.aws/terrain-tiles/" },
} as const;
