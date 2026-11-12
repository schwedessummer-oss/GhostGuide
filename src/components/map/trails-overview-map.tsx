"use client";

import { useCallback, useState } from "react";
import type { Map as MlMap } from "maplibre-gl";
import { MapView, type MapLibreModule } from "@/components/maps/map-view";
import { MAP_FILL_FIX, bboxOf, markerButton, popupContent } from "./trail-map";

/**
 * Interactive overview of all demo-region routes on the shared MapLibre base
 * map (no API key). Each trailhead is a keyboard-focusable button with a
 * popup linking to the trail. The page always renders a text list of the
 * same trails as the accessible alternative.
 */
export interface OverviewMapTrail {
  slug: string;
  name: string;
  number: number;
  summary: string;
  coordinates: [number, number][];
  trailhead: { lat: number; lng: number };
  closed: boolean;
}

const COLORS = ["#2a5a3e", "#8a4b08", "#1e4f9c", "#6b3fa0", "#a3241a", "#0f6b6b", "#5c5f1e"];

export function TrailsOverviewMap({ trails, label }: { trails: OverviewMapTrail[]; label: string }) {
  const [status, setStatus] = useState<"loading" | "ready">("loading");

  const onReady = useCallback(
    (map: MlMap, lib: MapLibreModule) => {
      map.cooperativeGestures.enable();
      map.addControl(new lib.ScaleControl({ unit: "imperial" }), "bottom-left");
      trails.forEach((t, i) => {
        const id = `gg-demo-route-${t.slug}`;
        map.addSource(id, { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: t.coordinates } } });
        map.addLayer({
          id: `${id}-casing`,
          type: "line",
          source: id,
          paint: { "line-color": "#ffffff", "line-width": 7 },
          layout: { "line-join": "round", "line-cap": "round" },
        });
        map.addLayer({
          id,
          type: "line",
          source: id,
          paint: { "line-color": COLORS[i % COLORS.length], "line-width": 4, ...(t.closed ? { "line-dasharray": [2, 1.5] } : {}) },
          layout: { "line-join": "round", "line-cap": "round" },
        });
      });
      const markers = trails.map((t, i) => {
        const el = markerButton(`${t.number}. ${t.name} trailhead${t.closed ? " (closed)" : ""}: show details`, String(t.number), COLORS[i % COLORS.length]);
        const popup = new lib.Popup({ offset: 18, focusAfterOpen: true, closeButton: true }).setDOMContent(
          popupContent(`${t.number}. ${t.name}`, [t.summary, ...(t.closed ? ["Closed"] : [])], { href: `/trails/${t.slug}`, label: "View trail details" }),
        );
        return new lib.Marker({ element: el }).setLngLat([t.trailhead.lng, t.trailhead.lat]).setPopup(popup).addTo(map);
      });
      setStatus("ready");
      return () => markers.forEach((m) => m.remove());
    },
    [trails],
  );

  const all = trails.flatMap((t) => [...t.coordinates, [t.trailhead.lng, t.trailhead.lat] as [number, number]]);
  if (!all.length) return null;
  return (
    <div>
      <MapView
        ariaLabel={label}
        initialBounds={bboxOf(all)}
        boundsPadding={48}
        onReady={onReady}
        className={`h-[420px] w-full rounded-xl border border-sand-200 sm:h-[520px] ${MAP_FILL_FIX}`}
      />
      <p aria-live="polite" className="sr-only">
        {status === "loading" ? "Loading map…" : "Map loaded. Trailhead markers are buttons; the trail list below has the same information."}
      </p>
    </div>
  );
}
