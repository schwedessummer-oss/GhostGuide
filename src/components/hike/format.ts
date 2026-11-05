/** Formatting helpers for the hike screens (device-local time). */
import { formatDistance } from "@/domain/geo";

export function formatClock(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function formatClockShort(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** 1:05:23 / 12:04 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatMinutes(min: number | null): string {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

/** "1.3 mi (2.1 km)" */
export function formatDistanceBoth(m: number): string {
  return `${formatDistance(m, "imperial")} (${formatDistance(m, "metric")})`;
}

/** Decimal degrees, 6 places (~0.1 m), as emergency services ask for. */
export function formatCoords(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

export function formatAgo(ms: number | null | undefined, now: number): string {
  if (ms == null) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
