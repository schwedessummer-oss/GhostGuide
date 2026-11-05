"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useRef, useState } from "react";
import { boundsOf, loadMapbox, markerButton, OUTDOORS_STYLE, popupContent } from "@/components/discover/mapbox-utils";

/**
 * Interactive Mapbox overview of all region routes (only rendered when
 * NEXT_PUBLIC_MAPBOX_TOKEN is set). Each trailhead is a keyboard-focusable
 * button with a popup linking to the trail. The page always renders a text
 * list of the same trails as the accessible alternative.
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

export function TrailsOverviewMap({ token, trails, label }: { token: string; trails: OverviewMapTrail[]; label: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    let map: import("mapbox-gl").Map | undefined;
    (async () => {
      try {
        const mapboxgl = await loadMapbox(token);
        if (cancelled || !container.current) return;
        const all = trails.flatMap((t) => t.coordinates);
        map = new mapboxgl.Map({
          container: container.current,
          style: OUTDOORS_STYLE,
          bounds: boundsOf(all),
          fitBoundsOptions: { padding: 48 },
          cooperativeGestures: true,
          respectPrefersReducedMotion: true,
        });
        map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
        map.addControl(new mapboxgl.ScaleControl({ unit: "imperial" }), "bottom-left");
        const m = map;
        m.on("load", () => {
          trails.forEach((t, i) => {
            const id = `route-${t.slug}`;
            m.addSource(id, { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: t.coordinates } } });
            m.addLayer({ id: `${id}-casing`, type: "line", source: id, paint: { "line-color": "#ffffff", "line-width": 7 }, layout: { "line-join": "round", "line-cap": "round" } });
            m.addLayer({
              id,
              type: "line",
              source: id,
              paint: { "line-color": COLORS[i % COLORS.length], "line-width": 4, ...(t.closed ? { "line-dasharray": [2, 1.5] } : {}) },
              layout: { "line-join": "round", "line-cap": "round" },
            });
          });
          if (!cancelled) setStatus("ready");
        });
        m.on("error", () => {
          if (!cancelled) setStatus((s) => (s === "loading" ? "error" : s));
        });
        trails.forEach((t, i) => {
          const el = markerButton(`${t.number}. ${t.name} trailhead${t.closed ? " (closed)" : ""}: show details`, String(t.number), COLORS[i % COLORS.length]);
          const popup = new mapboxgl.Popup({ offset: 18, focusAfterOpen: true, closeButton: true }).setDOMContent(
            popupContent(`${t.number}. ${t.name}`, [t.summary, ...(t.closed ? ["Closed"] : [])], { href: `/trails/${t.slug}`, label: "View trail details" }),
          );
          new mapboxgl.Marker({ element: el }).setLngLat([t.trailhead.lng, t.trailhead.lat]).setPopup(popup).addTo(m);
        });
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [token, trails]);

  return (
    <div>
      <div ref={container} role="region" aria-label={label} className="h-[420px] w-full overflow-hidden rounded-xl border border-sand-200 bg-sand-100 sm:h-[520px]" />
      <p aria-live="polite" className={status === "error" ? "mt-2 text-sm font-semibold text-red-ink" : "sr-only"}>
        {status === "loading" ? "Loading map…" : status === "ready" ? "Map loaded. Trailhead markers are buttons; the trail list below has the same information." : "The map could not load. Use the trail list below."}
      </p>
    </div>
  );
}
