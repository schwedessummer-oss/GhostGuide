/**
 * Client-side helpers shared by the Mapbox map components.
 *
 * Mapbox GL JS is loaded lazily (dynamic import) only when a token is
 * configured. We never prefetch or persist tiles for offline use (Mapbox
 * terms); offline trip use relies on the vector RouteView instead.
 * Popup/marker content is built with DOM APIs and textContent (no innerHTML).
 */
export type MapboxModule = typeof import("mapbox-gl").default;

export async function loadMapbox(token: string): Promise<MapboxModule> {
  const mod = await import("mapbox-gl");
  const mapboxgl = mod.default;
  mapboxgl.accessToken = token;
  return mapboxgl;
}

export const OUTDOORS_STYLE = "mapbox://styles/mapbox/outdoors-v12";

export function popupContent(title: string, lines: string[], link?: { href: string; label: string }): HTMLElement {
  const root = document.createElement("div");
  root.className = "gg-map-popup";
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
  btn.style.cssText =
    "width: 44px; height: 44px; display: grid; place-items: center; background: transparent; border: 0; padding: 0; cursor: pointer;";
  const dot = document.createElement("span");
  dot.textContent = text;
  dot.setAttribute("aria-hidden", "true");
  dot.style.cssText = `width: 26px; height: 26px; border-radius: 9999px; display: grid; place-items: center; background: ${color}; color: #fff; font: 700 13px/1 system-ui, sans-serif; border: 2.5px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.35);`;
  btn.appendChild(dot);
  return btn;
}

export function boundsOf(coords: [number, number][]): [[number, number], [number, number]] {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}
