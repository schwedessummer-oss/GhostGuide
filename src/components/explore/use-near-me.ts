"use client";

import { useCallback, useRef, useState } from "react";
import type { LngLat } from "@/domain/catalog";
import { coarsenLocation } from "./geometry";

export type NearMeStatus = "idle" | "locating" | "denied" | "unavailable" | "timeout" | "unsupported";

export const NEAR_ME_MESSAGES: Record<NearMeStatus, string | null> = {
  idle: null,
  locating: "Finding your location…",
  denied: "Location access is off for this site. Allow it in your browser settings, or search for a town or park instead.",
  unavailable: "Your location isn’t available right now. Search for a town or park instead.",
  timeout: "Finding your location took too long. Try again, or search for a place.",
  unsupported: "This browser can’t share your location. Search for a town or park instead.",
};

/**
 * Device location for "Near me". Asked for only when the person taps the
 * button; the position is coarsened to about 1 km, used once to centre the
 * search, and never stored or sent anywhere else.
 */
export function useNearMe(onLocated: (point: LngLat) => void) {
  const [status, setStatus] = useState<NearMeStatus>("idle");
  const callback = useRef(onLocated);
  const request = useRef(0);

  const locate = useCallback(() => {
    callback.current = onLocated;
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setStatus("unsupported");
      return;
    }
    const id = ++request.current;
    setStatus("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (id !== request.current) return;
        setStatus("idle");
        callback.current(coarsenLocation({ lng: pos.coords.longitude, lat: pos.coords.latitude }));
      },
      (err) => {
        if (id !== request.current) return;
        setStatus(err.code === err.PERMISSION_DENIED ? "denied" : err.code === err.TIMEOUT ? "timeout" : "unavailable");
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 5 * 60_000 },
    );
  }, [onLocated]);

  const reset = useCallback(() => {
    request.current += 1;
    setStatus("idle");
  }, []);

  return { status, message: NEAR_ME_MESSAGES[status], locate, reset };
}
