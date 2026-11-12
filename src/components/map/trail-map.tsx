"use client";

import { useCallback, useState } from "react";
import type { Map as MlMap } from "maplibre-gl";
import type { Bbox } from "@/domain/catalog";
import { MapView, type MapLibreModule } from "@/components/maps/map-view";

/**
 * Interactive map of one demo-region trail's route and its stops, on the
 * shared MapLibre base map (no API key). The trail page always lists the same
 * stops as text. Not for navigation; tiles are never cached for offline use.
 *
 * Also exports the small DOM helpers used by the demo-region overview map:
 * markers are real <button>s (keyboard and screen-reader reachable) and popup
 * content is built with textContent (no innerHTML).
 */
export interface TrailMapPoi {
  id: string;
  name: string;
  kind: string;
  lat: number;
  lng: number;
  number: number;
}

/** Popup body: a title, a few lines and an optional link. */
export function popupContent(title: string, lines: string[], link?: { href: string; label: string }): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText = "font: 14px/1.4 system-ui, sans-serif; color: #1d2420; max-width: 220px;";
  const h = document.createElement("p");
  h.textContent = title;
  h.style.cssText = "font-weight: 700; margin: 0 0 4px;";
  root.appendChild(h);
  for (const line of lines) {
    const p = document.createElement("p");
    p.textContent = line;
    p.style.cssText = "margin: 0 0 2px; color: #545b55;";
    root.appendChild(p);
  }
  if (link) {
    const a = document.createElement("a");
    a.href = link.href;
    a.textContent = link.label;
    a.style.cssText = "display: inline-block; margin-top: 6px; font-weight: 600; color: #1f4630; text-decoration: underline; min-height: 24px;";
    root.appendChild(a);
  }
  return root;
}

/** A focusable, labeled marker (44×44 px touch target with a smaller visual dot). */
export function markerButton(label: string, text: string, color: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.style.cssText = "width: 44px; height: 44px; display: grid; place-items: center; background: transparent; border: 0; padding: 0; cursor: pointer;";
  const dot = document.createElement("span");
  dot.textContent = text;
  dot.setAttribute("aria-hidden", "true");
  dot.style.cssText = `width: 26px; height: 26px; border-radius: 9999px; display: grid; place-items: center; background: ${color}; color: #fff; font: 700 13px/1 system-ui, sans-serif; border: 2.5px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.35);`;
  btn.appendChild(dot);
  return btn;
}

/** [west, south, east, north] around a list of [lng, lat] positions. */
export function bboxOf(coords: [number, number][]): Bbox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lng, lat] of coords) {
    w = Math.min(w, lng);
    s = Math.min(s, lat);
    e = Math.max(e, lng);
    n = Math.max(n, lat);
  }
  // A single point (or a degenerate line) still needs a non-empty box.
  const pad = 0.002;
  return [w - (e - w < pad ? pad : 0), s - (n - s < pad ? pad : 0), e + (e - w < pad ? pad : 0), n + (n - s < pad ? pad : 0)];
}

/**
 * maplibre-gl.css sets .maplibregl-map { position: relative }, which, depending
 * on stylesheet order, defeats MapView's absolutely positioned canvas container
 * and collapses it to 0 px. These variants keep it filling the frame.
 */
export const MAP_FILL_FIX = "[&_.maplibregl-map]:absolute! [&_.maplibregl-map]:inset-0!";

export function TrailMap({ coordinates, pois, label }: { coordinates: [number, number][]; pois: TrailMapPoi[]; label: string }) {
  const [status, setStatus] = useState<"loading" | "ready">("loading");

  const onReady = useCallback(
    (map: MlMap, lib: MapLibreModule) => {
      // On a long page, one-finger drags and the plain scroll wheel scroll the page, not the map.
      map.cooperativeGestures.enable();
      map.addControl(new lib.ScaleControl({ unit: "imperial" }), "bottom-left");
      map.addSource("gg-demo-route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } } });
      map.addLayer({
        id: "gg-demo-route-casing",
        type: "line",
        source: "gg-demo-route",
        paint: { "line-color": "#ffffff", "line-width": 8 },
        layout: { "line-join": "round", "line-cap": "round" },
      });
      map.addLayer({
        id: "gg-demo-route",
        type: "line",
        source: "gg-demo-route",
        paint: { "line-color": "#2a5a3e", "line-width": 5 },
        layout: { "line-join": "round", "line-cap": "round" },
      });
      const markers = [
        new lib.Marker({ element: markerButton("Start of route", "S", "#173524") })
          .setLngLat(coordinates[0])
          .setPopup(new lib.Popup({ offset: 18 }).setDOMContent(popupContent("Start", ["Trailhead (demonstration route, not for navigation)"])))
          .addTo(map),
        ...pois.map((p) =>
          new lib.Marker({ element: markerButton(`Stop ${p.number}: ${p.name}`, String(p.number), "#8a4b08") })
            .setLngLat([p.lng, p.lat])
            .setPopup(new lib.Popup({ offset: 18 }).setDOMContent(popupContent(`${p.number}. ${p.name}`, [p.kind.replace(/_/g, " ")])))
            .addTo(map),
        ),
      ];
      setStatus("ready");
      return () => markers.forEach((m) => m.remove());
    },
    [coordinates, pois],
  );

  if (coordinates.length < 2) return null;
  return (
    <div>
      <MapView
        ariaLabel={label}
        initialBounds={bboxOf(coordinates)}
        boundsPadding={48}
        onReady={onReady}
        className={`h-[360px] w-full rounded-xl border border-sand-200 sm:h-[440px] ${MAP_FILL_FIX}`}
      />
      <p aria-live="polite" className="sr-only">
        {status === "loading" ? "Loading map…" : "Map loaded. Stop markers are buttons; the list of stops below has the same information."}
      </p>
    </div>
  );
}
