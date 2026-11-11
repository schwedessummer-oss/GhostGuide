/**
 * When a booked hike may be started (pure, isomorphic: used by the hike
 * screen on the device — also offline — and by the server's start use-case).
 *
 * A hike starts only on its booked date in the REGION's time zone. A hike
 * already under way keeps going past midnight (that is a resume, not a
 * start), and a start recorded offline is judged by when it happened on the
 * device, not when it reached the server.
 */
import { formatDate } from "@/lib/format";
import { localDateInZone } from "@/lib/time";

export type StartWindowStatus = "today" | "early" | "late" | "unknown";

export interface StartWindow {
  status: StartWindowStatus;
  /** the booked date (YYYY-MM-DD), or null when the trip has none */
  bookedDate: string | null;
  /** the region-local calendar date at `now` */
  today: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function hikeStartWindow(bookedDate: string | null | undefined, timeZone: string, now: Date | number): StartWindow {
  const today = localDateInZone(new Date(now), timeZone);
  const date = bookedDate && DATE_RE.test(bookedDate) ? bookedDate : null;
  if (!date) return { status: "unknown", bookedDate: date, today };
  return { status: today === date ? "today" : today < date ? "early" : "late", bookedDate: date, today };
}

/** A start is allowed on the booked date, or when no date is known. */
export const startAllowed = (w: StartWindow) => w.status === "today" || w.status === "unknown";

/** "Saturday, November 28" (the booked date as the hiker reads it). */
export function formatBookedDate(date: string, opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" }): string {
  return formatDate(date, opts);
}

/** Plain-language reason a start is refused (null when it is allowed). */
export function startWindowMessage(w: StartWindow): string | null {
  if (startAllowed(w) || !w.bookedDate) return null;
  const d = formatBookedDate(w.bookedDate);
  return w.status === "early"
    ? `This hike is booked for ${d}. You can start it on ${d}.`
    : `This hike was booked for ${d}, which has passed, so it can no longer be started.`;
}
