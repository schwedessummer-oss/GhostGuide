"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Map as MlMap, StyleSpecification } from "maplibre-gl";
import type { Bbox, LngLat } from "@/domain/catalog";
import { MAP_ATTRIBUTION, MAP_STYLE_URL, MAP_TERRAIN_TILES_URL } from "@/config/public";

export type MapLibreModule = typeof import("maplibre-gl");

/**
 * Base interactive map (MapLibre GL JS + OpenFreeMap vector tiles by default,
 * optional terrain hillshade). No API key, no tracking. Loaded lazily on the
 * client. Callers add their own sources/layers in `onReady` and may return a
 * cleanup function.
 *
 * Tiles are never prefetched or stored for offline use. Pages must always
 * offer a text alternative (list) for what the map shows.
 */
export interface MapViewProps {
  ariaLabel: string;
  className?: string;
  initialBounds?: Bbox;
  initialCenter?: LngLat;
  initialZoom?: number;
  /** Padding (px) when fitting initialBounds. */
  boundsPadding?: number;
  hillshade?: boolean;
  /** Show the zoom/compass control (default true). */
  navigationControl?: boolean;
  /** Called once the style has loaded. May return a cleanup function. */
  onReady?: (map: MlMap, lib: MapLibreModule) => void | (() => void);
  /** Overlay UI rendered above the map (buttons, banners). */
  children?: ReactNode;
}

const HILLSHADE_SOURCE = "gg-terrain";
const MAPLIBRE_WORKER_URL =
  typeof window === "undefined" ? "" : new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href;

function addHillshade(map: MlMap) {
  if (MAP_TERRAIN_TILES_URL === "off" || map.getSource(HILLSHADE_SOURCE)) return;
  map.addSource(HILLSHADE_SOURCE, {
    type: "raster-dem",
    tiles: [MAP_TERRAIN_TILES_URL],
    encoding: "terrarium",
    tileSize: 256,
    maxzoom: 14,
  });
  // Draw hillshade beneath labels and roads: before the first symbol layer.
  const layers = (map.getStyle() as StyleSpecification).layers ?? [];
  const firstSymbol = layers.find((l) => l.type === "symbol")?.id;
  map.addLayer(
    {
      id: "gg-hillshade",
      type: "hillshade",
      source: HILLSHADE_SOURCE,
      paint: { "hillshade-exaggeration": 0.3, "hillshade-shadow-color": "#3d4a3a" },
    },
    firstSymbol,
  );
}

export function MapView({
  ariaLabel,
  className,
  initialBounds,
  initialCenter,
  initialZoom,
  boundsPadding = 40,
  hillshade = true,
  navigationControl = true,
  onReady,
  children,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    let map: MlMap | null = null;
    let cleanup: void | (() => void);
    let cancelled = false;

    (async () => {
      let lib: MapLibreModule;
      try {
        lib = await import("maplibre-gl");
      } catch {
        if (!cancelled) setFailed("The map could not be loaded.");
        return;
      }
      if (cancelled || !containerRef.current) return;
      // MapLibre 6 resolves its worker next to its own chunk, which the
      // bundler does not emit; point it at the emitted worker asset instead.
      if (!lib.getWorkerUrl()) lib.setWorkerUrl(MAPLIBRE_WORKER_URL);
      try {
        map = new lib.Map({
          container: containerRef.current,
          style: MAP_STYLE_URL,
          ...(initialBounds
            ? { bounds: initialBounds as [number, number, number, number], fitBoundsOptions: { padding: boundsPadding, maxZoom: 15 } }
            : { center: initialCenter ? [initialCenter.lng, initialCenter.lat] : [0, 20], zoom: initialZoom ?? (initialCenter ? 11 : 1.5) }),
          attributionControl: {
            compact: true,
            customAttribution: [
              `<a href="${MAP_ATTRIBUTION.osm.url}" target="_blank" rel="noopener">${MAP_ATTRIBUTION.osm.label}</a>`,
              `<a href="${MAP_ATTRIBUTION.openFreeMap.url}" target="_blank" rel="noopener">${MAP_ATTRIBUTION.openFreeMap.label}</a>`,
              ...(hillshade && MAP_TERRAIN_TILES_URL !== "off"
                ? [`<a href="${MAP_ATTRIBUTION.terrain.url}" target="_blank" rel="noopener">${MAP_ATTRIBUTION.terrain.label}</a>`]
                : []),
            ],
          },
          cooperativeGestures: false,
          dragRotate: false,
          pitchWithRotate: false,
        });
      } catch {
        setFailed("Interactive maps are not supported on this device or browser.");
        return;
      }
      if (navigationControl) map.addControl(new lib.NavigationControl({ showCompass: false }), "top-right");
      map.on("error", (e) => {
        // Tile/style errors are reported once; overlays keep working.
        if (String((e as unknown as { error?: { message?: string } }).error?.message ?? "").includes("style")) setFailed("Map tiles are unavailable right now.");
      });
      map.once("load", () => {
        if (cancelled || !map) return;
        if (hillshade) {
          try {
            addHillshade(map);
          } catch {
            /* hillshade is decorative */
          }
        }
        // Phones: start with the compact attribution collapsed (its "i" button
        // opens it) so it does not cover the map; pages also credit sources in text.
        if (map.getContainer().clientWidth < 640) {
          const attrib = map.getContainer().querySelector(".maplibregl-ctrl-attrib.maplibregl-compact");
          attrib?.classList.remove("maplibregl-compact-show");
          attrib?.removeAttribute("open");
        }
        cleanup = onReadyRef.current?.(map, lib);
      });
    })();

    return () => {
      cancelled = true;
      if (typeof cleanup === "function") cleanup();
      map?.remove();
    };
    // The map is created once; later prop changes are handled by callers via the map instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`relative overflow-hidden bg-sand-100 ${className ?? ""}`}>
      {/* maplibre-gl.css makes the container position:relative (unlayered CSS beats Tailwind's
          layered utilities), so size it explicitly as well. */}
      <div ref={containerRef} role="region" aria-label={ariaLabel} className="absolute inset-0 size-full" />
      {failed ? (
        <div className="absolute inset-x-3 top-3 rounded-md bg-surface/95 px-3 py-2 text-sm text-ink shadow" role="status">
          {failed} The list shows the same results.
        </div>
      ) : null}
      {children}
    </div>
  );
}
