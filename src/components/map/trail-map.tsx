"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useRef, useState } from "react";
import { boundsOf, loadMapbox, markerButton, OUTDOORS_STYLE, popupContent } from "@/components/discover/mapbox-utils";

/**
 * Interactive Mapbox view of one trail's validated route and its stops (only
 * when NEXT_PUBLIC_MAPBOX_TOKEN is set). The trail page always lists the same
 * stops as text. Not for navigation; tiles are never cached for offline use.
 */
export interface TrailMapPoi {
  id: string;
  name: string;
  kind: string;
  lat: number;
  lng: number;
  number: number;
}

export function TrailMap({
  token,
  coordinates,
  pois,
  label,
}: {
  token: string;
  coordinates: [number, number][];
  pois: TrailMapPoi[];
  label: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    let map: import("mapbox-gl").Map | undefined;
    (async () => {
      try {
        const mapboxgl = await loadMapbox(token);
        if (cancelled || !container.current || coordinates.length < 2) return;
        map = new mapboxgl.Map({
          container: container.current,
          style: OUTDOORS_STYLE,
          bounds: boundsOf(coordinates),
          fitBoundsOptions: { padding: 48 },
          cooperativeGestures: true,
          respectPrefersReducedMotion: true,
        });
        map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
        map.addControl(new mapboxgl.ScaleControl({ unit: "imperial" }), "bottom-left");
        const m = map;
        m.on("load", () => {
          m.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } } });
          m.addLayer({ id: "route-casing", type: "line", source: "route", paint: { "line-color": "#ffffff", "line-width": 8 }, layout: { "line-join": "round", "line-cap": "round" } });
          m.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": "#2a5a3e", "line-width": 5 }, layout: { "line-join": "round", "line-cap": "round" } });
          if (!cancelled) setStatus("ready");
        });
        m.on("error", () => {
          if (!cancelled) setStatus((s) => (s === "loading" ? "error" : s));
        });
        const [startLng, startLat] = coordinates[0];
        new mapboxgl.Marker({ element: markerButton("Start of route", "S", "#173524") })
          .setLngLat([startLng, startLat])
          .setPopup(new mapboxgl.Popup({ offset: 18 }).setDOMContent(popupContent("Start", ["Trailhead (demonstration route, not for navigation)"])))
          .addTo(m);
        for (const p of pois) {
          new mapboxgl.Marker({ element: markerButton(`Stop ${p.number}: ${p.name}`, String(p.number), "#8a4b08") })
            .setLngLat([p.lng, p.lat])
            .setPopup(new mapboxgl.Popup({ offset: 18 }).setDOMContent(popupContent(`${p.number}. ${p.name}`, [p.kind.replace(/_/g, " ")])))
            .addTo(m);
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [token, coordinates, pois]);

  return (
    <div>
      <div ref={container} role="region" aria-label={label} className="h-[360px] w-full overflow-hidden rounded-xl border border-sand-200 bg-sand-100 sm:h-[440px]" />
      <p aria-live="polite" className={status === "error" ? "mt-2 text-sm font-semibold text-red-ink" : "sr-only"}>
        {status === "loading" ? "Loading map…" : status === "ready" ? "Map loaded. Stop markers are buttons; the list of stops below has the same information." : "The map could not load. The stops are listed below."}
      </p>
    </div>
  );
}
