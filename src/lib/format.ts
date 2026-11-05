/** Isomorphic formatting helpers. */
export function formatMoney(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

export function formatDate(value: Date | string, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" }, timeZone?: string): string {
  const d = typeof value === "string" ? new Date(value.length === 10 ? `${value}T12:00:00Z` : value) : value;
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: timeZone ?? (typeof value === "string" && value.length === 10 ? "UTC" : undefined) }).format(d);
}

export function formatDateTime(value: Date | string, timeZone?: string): string {
  return formatDate(value, { dateStyle: "medium", timeStyle: "short" }, timeZone);
}

/** "3 min ago", "2 h ago" — for freshness / staleness labels. */
export function formatAge(from: Date | string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(from).getTime();
  const s = Math.round(ms / 1000);
  if (s < 0) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
