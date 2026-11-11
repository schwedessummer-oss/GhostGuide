import { formatDate } from "@/lib/format";

/**
 * Admin date-time with an explicit zone label, e.g. "Nov 4, 2026, 6:29 PM PST".
 * `tz` is the trail region's IANA zone when the time belongs to a hike or
 * trail; otherwise UTC (labeled), never the server's implicit local zone.
 */
export function formatAdminDateTime(at: Date | string, tz?: string | null): string {
  return formatDate(at, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }, tz || "UTC");
}
