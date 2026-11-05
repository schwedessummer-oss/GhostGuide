import { formatDistance, formatElevation } from "@/domain/geo";

/** "3.2 mi (5.1 km)" — imperial first, metric secondary. */
export function distanceBoth(km: number): string {
  return `${formatDistance(km * 1000)} (${formatDistance(km * 1000, "metric")})`;
}

/** "1,312 ft (400 m)". */
export function elevationBoth(m: number): string {
  return `${formatElevation(m)} (${formatElevation(m, "metric")})`;
}

export function humanize(s: string): string {
  const t = s.replace(/_/g, " ");
  return t[0] ? t[0].toUpperCase() + t.slice(1) : t;
}

/** "9:05 AM" from "09:05" — shown alongside the 24 h value for clarity. */
export function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}
