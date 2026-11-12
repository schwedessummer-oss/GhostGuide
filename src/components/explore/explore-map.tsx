"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ExpressionSpecification, GeoJSONSource, Map as MlMap, MapGeoJSONFeature } from "maplibre-gl";
import type { Bbox, TrailDetailDto, TrailSummaryDto } from "@/domain/catalog";
import { MapView, type MapLibreModule } from "@/components/maps/map-view";
import { DIFFICULTY_META } from "./format";
import { clampBbox, trailsToFeatureCollection } from "./geometry";

/**
 * Explore's map layer: clustered trailhead points (colored by difficulty),
 * a highlight for the selected/hovered trail and the selected trail's route
 * line, on the shared MapView base map. Sources and layers are created once;
 * later changes only call setData / setFilter. The list next to the map is
 * the accessible alternative for everything shown here.
 */
export interface ExploreMapHandle {
  /** Show an area (programmatic moves never trigger "Search this area"). */
  fitBbox(bbox: Bbox, animate: boolean): void;
  getBbox(): Bbox | null;
  getZoom(): number | null;
  /** Highlight a trail's marker (list hover/focus); null clears it. */
  setHovered(id: string | null): void;
}

export interface Padding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface MapViewChange {
  bbox: Bbox;
  zoom: number;
}

interface Props {
  ariaLabel: string;
  initialBbox: Bbox | null;
  trails: TrailSummaryDto[];
  selectedId: string | null;
  selectedRoute: TrailDetailDto["geometry"] | null;
  onSelect: (id: string | null) => void;
  /** Several trails share the tapped spot (a common trailhead): let the person choose. */
  onSelectGroup: (ids: string[]) => void;
  /** After the person pans/zooms (debounced; never for programmatic moves). */
  onUserMove: (view: MapViewChange) => void;
  /** Padding that keeps fitted areas clear of overlays. */
  getPadding: () => Padding;
  handleRef: RefObject<ExploreMapHandle | null>;
  children?: ReactNode;
}

const SRC_TRAILS = "gg-explore-trails";
const SRC_ROUTE = "gg-explore-route";
const L_CASING = "gg-explore-route-casing";
const L_ROUTE = "gg-explore-route";
const L_CLUSTERS = "gg-explore-clusters";
const L_CLUSTER_COUNT = "gg-explore-cluster-count";
const L_POINTS = "gg-explore-points";
const SRC_FOCUS = "gg-explore-focus";
const L_FOCUS = "gg-explore-focus";
/** Trails within this many pixels of the tapped one count as "the same spot". */
const SAME_SPOT_PX = 6;
const PROGRAMMATIC = { ggProgrammatic: true };
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const MOVE_DEBOUNCE_MS = 300;

const difficultyColor: ExpressionSpecification = [
  "match",
  ["get", "difficulty"],
  "easy",
  DIFFICULTY_META.easy.color,
  "moderate",
  DIFFICULTY_META.moderate.color,
  "hard",
  DIFFICULTY_META.hard.color,
  "expert",
  DIFFICULTY_META.expert.color,
  DIFFICULTY_META.unknown.color,
];

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function boundsOf(map: MlMap): Bbox | null {
  const b = map.getBounds();
  return clampBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
}

/** Padding shrunk so it never exceeds the map itself (MapLibre would refuse to fit). */
function safePadding(map: MlMap, p: Padding): Padding {
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const scaleY = p.top + p.bottom > h * 0.7 ? (h * 0.7) / (p.top + p.bottom) : 1;
  const scaleX = p.left + p.right > w * 0.7 ? (w * 0.7) / (p.left + p.right) : 1;
  return { top: p.top * scaleY, bottom: p.bottom * scaleY, left: p.left * scaleX, right: p.right * scaleX };
}

export function ExploreMap({
  ariaLabel,
  initialBbox,
  trails,
  selectedId,
  selectedRoute,
  onSelect,
  onSelectGroup,
  onUserMove,
  getPadding,
  handleRef,
  children,
}: Props) {
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const hovered = useRef<string | null>(null);
  const selected = useRef<string | null>(selectedId);
  const pendingFit = useRef<{ bbox: Bbox; animate: boolean } | null>(initialBbox ? { bbox: initialBbox, animate: false } : null);
  const callbacks = useRef({ onSelect, onSelectGroup, onUserMove, getPadding });
  const latestTrails = useRef(trails);

  useEffect(() => {
    callbacks.current = { onSelect, onSelectGroup, onUserMove, getPadding };
    latestTrails.current = trails;
  });

  /** The selected and hovered trails, drawn above the clusters so they show even when their point is clustered. */
  const applyHighlight = useCallback(() => {
    const source = mapRef.current?.getSource(SRC_FOCUS) as GeoJSONSource | undefined;
    if (!source) return;
    const ids = new Set([selected.current, hovered.current].filter(Boolean));
    source.setData(trailsToFeatureCollection(latestTrails.current.filter((t) => ids.has(t.id))));
  }, []);

  const fit = useCallback((bbox: Bbox, animate: boolean) => {
    const map = mapRef.current;
    if (!map) {
      pendingFit.current = { bbox, animate };
      return;
    }
    map.fitBounds(bbox, { padding: safePadding(map, callbacks.current.getPadding()), maxZoom: 14, duration: animate && !reducedMotion() ? 900 : 0 }, PROGRAMMATIC);
  }, []);

  useEffect(() => {
    handleRef.current = {
      fitBbox: fit,
      getBbox: () => (mapRef.current ? boundsOf(mapRef.current) : null),
      getZoom: () => mapRef.current?.getZoom() ?? null,
      setHovered: (id) => {
        hovered.current = id;
        applyHighlight();
      },
    };
    return () => {
      handleRef.current = null;
    };
  }, [fit, applyHighlight, handleRef]);

  const onReady = useCallback(
    (map: MlMap, lib: MapLibreModule) => {
      mapRef.current = map;
      // Zoom buttons on large screens only: phones pinch, and the search bar covers the map's top corners there.
      if (window.matchMedia("(min-width: 1024px)").matches) map.addControl(new lib.NavigationControl({ showCompass: false }), "top-right");

      map.addSource(SRC_ROUTE, { type: "geojson", data: EMPTY });
      map.addLayer({
        id: L_CASING,
        type: "line",
        source: SRC_ROUTE,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#0f2318", "line-opacity": 0.9, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4, 12, 7, 16, 10] },
      });
      map.addLayer({
        id: L_ROUTE,
        type: "line",
        source: SRC_ROUTE,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#5fa877", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 12, 3.5, 16, 5.5] },
      });

      map.addSource(SRC_TRAILS, {
        type: "geojson",
        data: trailsToFeatureCollection(latestTrails.current),
        cluster: true,
        clusterRadius: 42,
        clusterMaxZoom: 13,
      });
      map.addLayer({
        id: L_CLUSTERS,
        type: "circle",
        source: SRC_TRAILS,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#1f4630",
          "circle-opacity": 0.92,
          "circle-radius": ["step", ["get", "point_count"], 15, 10, 19, 50, 24],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2.5,
        },
      });
      map.addLayer({
        id: L_CLUSTER_COUNT,
        type: "symbol",
        source: SRC_TRAILS,
        filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 13, "text-allow-overlap": true },
        paint: { "text-color": "#ffffff" },
      });
      map.addLayer({
        id: L_POINTS,
        type: "circle",
        source: SRC_TRAILS,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": difficultyColor,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 5.5, 12, 7, 15, 8.5],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      map.addSource(SRC_FOCUS, { type: "geojson", data: EMPTY });
      map.addLayer({
        id: L_FOCUS,
        type: "circle",
        source: SRC_FOCUS,
        paint: {
          "circle-color": difficultyColor,
          "circle-radius": 11,
          "circle-stroke-color": "#0f2318",
          "circle-stroke-width": 3,
        },
      });

      // Clicks: nearest trail point within a finger-sized box, else a cluster (zoom in), else clear the selection.
      const onClick = async (e: { point: { x: number; y: number } }) => {
        const r = 12;
        const feats: MapGeoJSONFeature[] = map.queryRenderedFeatures(
          [
            [e.point.x - r, e.point.y - r],
            [e.point.x + r, e.point.y + r],
          ],
          { layers: [L_FOCUS, L_POINTS, L_CLUSTERS] },
        );
        const points = feats.filter((f) => f.layer.id !== L_CLUSTERS && typeof f.properties?.id === "string");
        if (points.length) {
          const dist = (f: MapGeoJSONFeature) => {
            const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
            const p = map.project([lng, lat]);
            return Math.hypot(p.x - e.point.x, p.y - e.point.y);
          };
          const nearest = points.reduce((a, b) => (dist(b) < dist(a) ? b : a));
          const [nLng, nLat] = (nearest.geometry as GeoJSON.Point).coordinates;
          const at = map.project([nLng, nLat]);
          const sameSpot = new Set<string>();
          for (const f of points) {
            const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
            const p = map.project([lng, lat]);
            if (Math.hypot(p.x - at.x, p.y - at.y) <= SAME_SPOT_PX) sameSpot.add(String(f.properties.id));
          }
          if (sameSpot.size > 1) callbacks.current.onSelectGroup([...sameSpot]);
          else callbacks.current.onSelect(String(nearest.properties.id));
          return;
        }
        const cluster = feats.find((f) => f.layer.id === L_CLUSTERS);
        if (cluster) {
          const source = map.getSource(SRC_TRAILS) as GeoJSONSource | undefined;
          const center = (cluster.geometry as GeoJSON.Point).coordinates as [number, number];
          try {
            const zoom = await source!.getClusterExpansionZoom(Number(cluster.properties.cluster_id));
            map.easeTo({ center, zoom: Math.min(zoom + 0.5, 16), duration: reducedMotion() ? 0 : 500 }, PROGRAMMATIC);
          } catch {
            map.easeTo({ center, zoom: map.getZoom() + 2, duration: reducedMotion() ? 0 : 500 }, PROGRAMMATIC);
          }
          return;
        }
        callbacks.current.onSelect(null);
      };
      map.on("click", onClick);

      const pointer = () => {
        map.getCanvas().style.cursor = "pointer";
      };
      const noPointer = () => {
        map.getCanvas().style.cursor = "";
      };
      for (const layer of [L_POINTS, L_CLUSTERS, L_FOCUS]) {
        map.on("mouseenter", layer, pointer);
        map.on("mouseleave", layer, noPointer);
      }

      // A move counts as the person's own only when it started from an input event.
      let userMove = false;
      let timer: number | undefined;
      map.on("movestart", (e) => {
        userMove = Boolean((e as { originalEvent?: unknown }).originalEvent) && !(e as { ggProgrammatic?: boolean }).ggProgrammatic;
      });
      map.on("moveend", (e) => {
        if (!userMove || (e as { ggProgrammatic?: boolean }).ggProgrammatic) return;
        userMove = false;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          const bbox = boundsOf(map);
          if (bbox) callbacks.current.onUserMove({ bbox, zoom: map.getZoom() });
        }, MOVE_DEBOUNCE_MS);
      });

      const pending = pendingFit.current;
      pendingFit.current = null;
      if (pending) map.fitBounds(pending.bbox, { padding: safePadding(map, callbacks.current.getPadding()), maxZoom: 14, duration: 0 }, PROGRAMMATIC);
      setReady(true);

      return () => {
        window.clearTimeout(timer);
        mapRef.current = null;
      };
    },
    [],
  );

  useEffect(() => {
    if (!ready) return;
    (mapRef.current?.getSource(SRC_TRAILS) as GeoJSONSource | undefined)?.setData(trailsToFeatureCollection(trails));
    applyHighlight();
  }, [ready, trails, applyHighlight]);

  useEffect(() => {
    if (!ready) return;
    const data: GeoJSON.FeatureCollection | GeoJSON.Feature = selectedRoute ? { type: "Feature", properties: {}, geometry: selectedRoute } : EMPTY;
    (mapRef.current?.getSource(SRC_ROUTE) as GeoJSONSource | undefined)?.setData(data);
  }, [ready, selectedRoute]);

  useEffect(() => {
    selected.current = selectedId;
    if (ready) applyHighlight();
  }, [ready, selectedId, applyHighlight]);

  return (
    <MapView
      ariaLabel={ariaLabel}
      className="h-full w-full"
      initialBounds={initialBbox ?? undefined}
      initialCenter={initialBbox ? undefined : { lng: -50, lat: 32 }}
      initialZoom={initialBbox ? undefined : 1.3}
      navigationControl={false}
      onReady={onReady}
    >
      {children}
    </MapView>
  );
}
