/** Shared, plain-language check-in copy (safe for client and server components). */
export const CHECKIN_EXPLANATION =
  "If we haven't received “I'm okay” or “Finish trip” from you by your expected return time plus the grace period, Ghost Guide will send your contact a notice with your last reported location (if you allow it). This is not continuous monitoring and not a rescue service; Ghost Guide never contacts 911 or Search and Rescue.";

export const CHECKIN_LIMITS_NOTE =
  "Your phone has to reach the internet for “I'm okay” and location updates to arrive. Browsers can pause apps in the background or when the screen is locked, so Ghost Guide may not have your latest position. In an emergency, call 911 yourself.";

export const GRACE_CHOICES = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720] as const;

export function minutesLabel(min: number): string {
  if (min < 60) return `${min} minutes`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} ${h === 1 ? "hour" : "hours"}`;
}

export function remindersLabel(offsets: number[]): string {
  if (!offsets.length) return "No reminders";
  const parts = [...offsets].sort((a, b) => b - a).map((o) => (o < 60 ? `${o} min` : minutesLabel(o)));
  return `${parts.join(", ")} before your expected return`;
}
