"use client";

import { useCallback } from "react";
import type { MapLayerMouseEvent, Map as MlMap } from "maplibre-gl";
import type { Bbox, LngLat, PoiDto, TrailDetailDto } from "@/domain/catalog";
import { MapView, type MapLibreModule } from "@/components/maps/map-view";
import { poiCategoryLabel, poiDisplayName } from "./format";
import { mapViewBounds, poiGroupOf } from "./poi";

const TRAIL_SOURCE = "gg-trail";
const POI_SOURCE = "gg-trail-pois";
const LINE_COLOR = "#173524";
const CASING_COLOR = "#ffffff";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function trailheadElement(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", "Trailhead");
  el.title = "Trailhead";
  el.style.cssText =
    "width:30px;height:30px;border-radius:9999px;background:#1f4630;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;";
  // Flag glyph (lucide "flag" path), decorative.
  el.innerHTML =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/></svg>';
  return el;
}

/**
 * Trail route on the shared MapLibre base map: the mapped geometry as a
 * white casing + dark line, the trailhead, and outdoor POIs as small colour
 * coded circles (popup with name and type on tap). Everything shown here is
 * also listed as text below the map.
 */
export function TrailMap({
  name,
  geometry,
  bbox,
  trailhead,
  pois,
}: {
  name: string;
  geometry: TrailDetailDto["geometry"];
  bbox: Bbox;
  trailhead: LngLat | null;
  pois: PoiDto[];
}) {
  const onReady = useCallback(
    (map: MlMap, lib: MapLibreModule) => {
      map.addSource(TRAIL_SOURCE, { type: "geojson", data: { type: "Feature", geometry, properties: {} } });
      map.addLayer({
        id: "gg-trail-casing",
        type: "line",
        source: TRAIL_SOURCE,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": CASING_COLOR, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 14, 8, 17, 12] },
      });
      map.addLayer({
        id: "gg-trail-line",
        type: "line",
        source: TRAIL_SOURCE,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": LINE_COLOR, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 14, 4, 17, 6] },
      });

      const features = pois
        .filter((p) => p.category !== "trailhead" || !trailhead || p.lng !== trailhead.lng || p.lat !== trailhead.lat)
        .map((p) => {
          const group = poiGroupOf(p.category);
          return group
            ? {
                type: "Feature" as const,
                geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
                properties: { name: poiDisplayName(p), kind: poiCategoryLabel(p.category), color: group.color },
              }
            : null;
        })
        .filter((f): f is NonNullable<typeof f> => f !== null);
      map.addSource(POI_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features } });
      map.addLayer({
        id: "gg-trail-pois",
        type: "circle",
        source: POI_SOURCE,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 4, 15, 7],
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });

      const popup = new lib.Popup({ closeButton: true, closeOnClick: true, offset: 10, maxWidth: "240px" });
      const onClick = (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        if (f.geometry.type !== "Point") return;
        const [lng, lat] = f.geometry.coordinates as [number, number];
        popup
          .setLngLat([lng, lat])
          .setHTML(
            `<p style="font-weight:600;margin:0;color:#1d2420">${escapeHtml(String(f.properties?.name ?? ""))}</p>` +
              `<p style="margin:2px 0 0;color:#545b55;font-size:13px">${escapeHtml(String(f.properties?.kind ?? ""))}</p>`,
          )
          .addTo(map);
      };
      const setPointer = () => (map.getCanvas().style.cursor = "pointer");
      const clearPointer = () => (map.getCanvas().style.cursor = "");
      map.on("click", "gg-trail-pois", onClick);
      map.on("mouseenter", "gg-trail-pois", setPointer);
      map.on("mouseleave", "gg-trail-pois", clearPointer);

      const marker = trailhead
        ? new lib.Marker({ element: trailheadElement(), anchor: "center" }).setLngLat([trailhead.lng, trailhead.lat]).addTo(map)
        : null;

      return () => {
        marker?.remove();
        popup.remove();
        map.off("click", "gg-trail-pois", onClick);
        map.off("mouseenter", "gg-trail-pois", setPointer);
        map.off("mouseleave", "gg-trail-pois", clearPointer);
      };
    },
    [geometry, pois, trailhead],
  );

  return (
    <MapView
      ariaLabel={`Map of ${name}: the route, the trailhead and ${pois.length} mapped points of interest. The same places are listed below the map.`}
      className="h-[max(18rem,min(56vh,440px))] sm:h-[460px] sm:rounded-2xl sm:border sm:border-sand-200"
      initialBounds={mapViewBounds(bbox, trailhead ? [trailhead, ...pois] : pois)}
      boundsPadding={36}
      onReady={onReady}
    />
  );
}
