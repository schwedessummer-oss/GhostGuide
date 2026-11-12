/**
 * Formatting and labelling helpers for catalog trail pages (pure, isomorphic:
 * safe in server and client components).
 *
 * Rounding rules (user-facing numbers):
 *   distance  0.1 mi / 0.1 km; below 0.1 mi → feet (nearest 10 ft), below 1 km → metres (nearest 10 m)
 *   climb     nearest 10 ft / nearest 1 m
 *   duration  estimates to the nearest 5 min, written "3 h 05 min"
 *
 * Every label for a value the provider did not supply says so briefly —
 * these helpers never fill gaps with a plausible-looking default.
 */
import type { Difficulty, DifficultySource, DogPolicy, PoiCategory, RouteType, WheelchairAccess } from "@/domain/catalog";

export type Units = "imperial" | "metric";
export const UNITS: readonly Units[] = ["imperial", "metric"];

/** Default units for a browser language tag: imperial for US English (and bare "en"), Liberia, Myanmar; metric elsewhere. */
export function unitsForLanguage(tag: string | null | undefined): Units {
  const t = (tag ?? "").trim().toLowerCase();
  if (!t) return "imperial";
  const [lang, ...rest] = t.split(/[-_]/);
  const region = rest.find((p) => /^[a-z]{2}$/.test(p));
  if (region) return ["us", "lr", "mm"].includes(region) ? "imperial" : "metric";
  return lang === "en" ? "imperial" : "metric";
}

export const M_PER_MILE = 1609.344;
export const FT_PER_M = 3.28084;

const fmt = (n: number, digits: number) => n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const round10 = (n: number) => Math.round(n / 10) * 10;
const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

// ---------------------------------------------------------------------------
// Distances, climbs, elevations
// ---------------------------------------------------------------------------

/** Trail distance: "6.8 mi" / "11.0 km"; short distances in ft / m. */
export function formatTrailDistance(meters: number, units: Units): string {
  const m = Math.max(0, meters);
  if (units === "metric") {
    if (m < 1000) return `${fmt(round10(m), 0)} m`;
    const km = m / 1000;
    return `${fmt(km, km >= 100 ? 0 : 1)} km`;
  }
  const mi = m / M_PER_MILE;
  if (mi < 0.1) return `${fmt(round10(m * FT_PER_M), 0)} ft`;
  return `${fmt(mi, mi >= 100 ? 0 : 1)} mi`;
}

/** Climb or descent: "2,280 ft" (nearest 10 ft) / "695 m". */
export function formatClimb(meters: number, units: Units): string {
  const m = Math.max(0, meters);
  return units === "metric" ? `${fmt(Math.round(m), 0)} m` : `${fmt(round10(m * FT_PER_M), 0)} ft`;
}

/** An altitude (may be negative near the sea): "3,110 ft" / "949 m". */
export function formatAltitude(meters: number, units: Units): string {
  return units === "metric" ? `${fmt(Math.round(meters), 0)} m` : `${fmt(round10(meters * FT_PER_M), 0)} ft`;
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/**
 * "3 h 05 min", "45 min", "2 h". Rounded to `step` minutes (default 5, for
 * estimates). Returns null for unknown / invalid input.
 */
export function formatDurationEstimate(minutes: number | null | undefined, step = 5): string | null {
  if (!finite(minutes) || minutes < 0) return null;
  const rounded = step > 1 ? Math.max(step, Math.round(minutes / step) * step) : Math.round(minutes);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${String(m).padStart(2, "0")} min`;
}

// ---------------------------------------------------------------------------
// Route form and difficulty
// ---------------------------------------------------------------------------

/** How the hike is walked, as shown under the hike distance. */
export function hikeFormLabel(routeType: RouteType): string {
  switch (routeType) {
    case "linear":
      return "Out & back";
    case "loop":
      return "Loop";
    case "network":
      return "Trail network";
    default:
      return "Mapped length";
  }
}

/** Route type as mapped (one traversal). */
export function routeTypeLabel(routeType: RouteType): string {
  switch (routeType) {
    case "linear":
      return "One way (linear)";
    case "loop":
      return "Loop";
    case "network":
      return "Network of connected paths";
    default:
      return "Not mapped";
  }
}

/** Short note under the stats that explains what the hike distance means; null when nothing to add. */
export function routeFormNote(routeType: RouteType, oneWayM: number, units: Units): string | null {
  switch (routeType) {
    case "linear":
      return `One way ${formatTrailDistance(oneWayM, units)}; most hikers return the same way.`;
    case "network":
      return "Several connected paths: the distance is their total mapped length, so your own route may be shorter.";
    case "unknown":
      return "The route shape isn't mapped: the distance is the total mapped length.";
    default:
      return null;
  }
}

export function difficultyLabel(d: Difficulty): string {
  switch (d) {
    case "easy":
      return "Easy";
    case "moderate":
      return "Moderate";
    case "hard":
      return "Hard";
    case "expert":
      return "Expert";
    default:
      return "Not rated";
  }
}

export interface SacGrade {
  /** "T1" … "T6" */
  grade: string;
  name: string;
  summary: string;
  rank: number;
}

const SAC_GRADES: Record<string, Omit<SacGrade, "rank">> = {
  hiking: { grade: "T1", name: "Hiking", summary: "a well-made path on flat or gently sloping ground, with little risk of falling" },
  mountain_hiking: {
    grade: "T2",
    name: "Mountain hiking",
    summary: "a continuous path, sometimes steep, where sure footing helps",
  },
  demanding_mountain_hiking: {
    grade: "T3",
    name: "Demanding mountain hiking",
    summary: "the path may be faint; exposed sections can need your hands for balance",
  },
  alpine_hiking: {
    grade: "T4",
    name: "Alpine hiking",
    summary: "often pathless, with easy scrambling and exposure; alpine experience needed",
  },
  demanding_alpine_hiking: {
    grade: "T5",
    name: "Demanding alpine hiking",
    summary: "pathless, exposed scrambling and possible snow fields; climbing experience recommended",
  },
  difficult_alpine_hiking: {
    grade: "T6",
    name: "Difficult alpine hiking",
    summary: "very exposed climbing terrain, for experienced alpinists only",
  },
};
const SAC_ORDER = Object.keys(SAC_GRADES);

/** The hardest recognised SAC grade in an OSM sac_scale value (";"-separated or "T1"…"T6"); null otherwise. */
export function sacGrade(sac: string | null | undefined): SacGrade | null {
  if (typeof sac !== "string") return null;
  let best = -1;
  for (const raw of sac.split(";")) {
    const part = raw.trim().toLowerCase();
    let rank = SAC_ORDER.indexOf(part);
    const t = /^t([1-6])$/.exec(part);
    if (rank === -1 && t) rank = Number(t[1]) - 1;
    if (rank > best) best = rank;
  }
  return best < 0 ? null : { ...SAC_GRADES[SAC_ORDER[best]], rank: best };
}

/** Small qualifier after the difficulty ("estimated", "SAC T2", "official"); null when none applies. */
export function difficultyQualifier(source: DifficultySource | null, sacScale: string | null): string | null {
  if (source === "estimated") return "estimated";
  if (source === "official") return "official";
  if (source === "osm_sac_scale") {
    const g = sacGrade(sacScale);
    return g ? `SAC ${g.grade}` : "SAC scale";
  }
  return null;
}

/** One or two plain sentences on where the difficulty comes from. */
export function difficultyExplanation(d: Difficulty, source: DifficultySource | null, sacScale: string | null): string {
  const g = sacGrade(sacScale);
  const sacSentence = g
    ? `OpenStreetMap grades the path ${g.grade} (${g.name.toLowerCase()}) on the SAC hiking scale: ${g.summary}.`
    : null;
  if (d === "unknown") return "There isn't enough mapped data to rate this trail.";
  if (source === "osm_sac_scale" && sacSentence) return sacSentence;
  if (source === "official") return "Rating published by the land manager.";
  const base = "Estimated by Ghost Guide from the hike's distance and climb. It is not an official rating.";
  return sacSentence ? `${base} ${sacSentence}` : base;
}

// ---------------------------------------------------------------------------
// Trail facts
// ---------------------------------------------------------------------------

export const UNKNOWN_CHECK_MANAGER = "Unknown — check with the land manager";

export function dogPolicyLabel(p: DogPolicy): string {
  switch (p) {
    case "allowed":
      return "Allowed";
    case "leashed":
      return "Allowed on a leash";
    case "not_allowed":
      return "Not allowed";
    default:
      return "Not mapped — check local rules";
  }
}

export function wheelchairLabel(w: WheelchairAccess): string {
  switch (w) {
    case "yes":
      return "Wheelchair accessible";
    case "limited":
      return "Limited wheelchair access";
    case "no":
      return "Not wheelchair accessible";
    default:
      return "Not mapped";
  }
}

export function feeLabel(fee: boolean | null): string {
  return fee === true ? "Fee required" : fee === false ? "No fee" : UNKNOWN_CHECK_MANAGER;
}

export function permitLabel(permit: boolean | null): string {
  return permit === true ? "Permit required" : permit === false ? "No permit needed" : UNKNOWN_CHECK_MANAGER;
}

const VISIBILITY: Record<string, string> = {
  excellent: "Excellent — clearly visible path",
  good: "Good — path visible, may need some route finding",
  intermediate: "Intermediate — path sometimes faint",
  bad: "Poor — path often hard to see",
  horrible: "Very poor — little or no visible path",
  no: "No visible path",
};

export function trailVisibilityLabel(v: string | null): string {
  if (!v) return "Not mapped";
  return VISIBILITY[v.trim().toLowerCase()] ?? humanize(v);
}

/** True when mapped visibility warrants a hazard note (bad or worse). */
export function isPoorVisibility(v: string | null): boolean {
  return !!v && ["bad", "horrible", "no"].includes(v.trim().toLowerCase());
}

const ACCESS: Record<string, string> = {
  yes: "Open to the public",
  permissive: "Open with the owner's permission (may be withdrawn)",
  designated: "Open to the public",
  public: "Open to the public",
  customers: "Customers only",
  permit: "By permit only",
  private: "Private — no public access",
  no: "No public access",
  destination: "Access to destinations only",
};

export function accessLabel(access: string | null): string {
  if (!access) return "Not mapped";
  return ACCESS[access.trim().toLowerCase()] ?? humanize(access);
}

/** schema.org publicAccess from the OSM access tag: true / false when clear, otherwise null (omit). */
export function publicAccessFromTag(access: string | null): boolean | null {
  if (!access) return null;
  const a = access.trim().toLowerCase();
  if (["yes", "permissive", "designated", "public"].includes(a)) return true;
  if (["private", "no"].includes(a)) return false;
  return null;
}

/** "fine_gravel" → "Fine gravel". */
export function humanize(s: string): string {
  const t = s.replace(/[_;]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

export function listLabel(values: string[]): string | null {
  const cleaned = [...new Set(values.map((v) => humanize(v).toLowerCase()).filter(Boolean))];
  if (cleaned.length === 0) return null;
  const s = cleaned.join(", ");
  return s[0].toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Points of interest
// ---------------------------------------------------------------------------

const POI_LABELS: Record<PoiCategory, { one: string; many: string }> = {
  trailhead: { one: "Trailhead", many: "Trailheads" },
  parking: { one: "Parking", many: "Parking" },
  toilets: { one: "Restroom", many: "Restrooms" },
  drinking_water: { one: "Drinking water", many: "Drinking water" },
  shelter: { one: "Shelter", many: "Shelters" },
  campsite: { one: "Campsite", many: "Campsites" },
  viewpoint: { one: "Viewpoint", many: "Viewpoints" },
  peak: { one: "Peak", many: "Peaks" },
  waterfall: { one: "Waterfall", many: "Waterfalls" },
  lake: { one: "Lake", many: "Lakes" },
  spring: { one: "Spring", many: "Springs" },
  cave: { one: "Cave", many: "Caves" },
  picnic_site: { one: "Picnic site", many: "Picnic sites" },
  ranger_station: { one: "Ranger station", many: "Ranger stations" },
  information: { one: "Information point", many: "Information points" },
  fuel: { one: "Gas station", many: "Gas stations" },
  ev_charging: { one: "EV charger", many: "EV chargers" },
  restaurant: { one: "Restaurant", many: "Restaurants" },
  fast_food: { one: "Fast food", many: "Fast food" },
  cafe: { one: "Café", many: "Cafés" },
  lodging: { one: "Lodging", many: "Lodging" },
  supermarket: { one: "Supermarket", many: "Supermarkets" },
  convenience: { one: "Convenience store", many: "Convenience stores" },
  outdoor_shop: { one: "Outdoor shop", many: "Outdoor shops" },
  hospital: { one: "Hospital", many: "Hospitals" },
  clinic: { one: "Clinic", many: "Clinics" },
  pharmacy: { one: "Pharmacy", many: "Pharmacies" },
};

export function poiCategoryLabel(c: PoiCategory, plural = false): string {
  const l = POI_LABELS[c];
  return l ? (plural ? l.many : l.one) : humanize(c);
}

/** The POI's mapped name, or "Unnamed restroom" etc. */
export function poiDisplayName(p: { name: string | null; category: PoiCategory }): string {
  const name = p.name?.trim();
  if (name) return name;
  const one = poiCategoryLabel(p.category);
  const lower = /^(EV|Café)/.test(one) ? one : one.toLowerCase();
  return `Unnamed ${lower}`;
}

// ---------------------------------------------------------------------------
// Places, freshness, links
// ---------------------------------------------------------------------------

/** English country name for an ISO alpha-2 code; null for unknown ("xx") or invalid codes. */
export function countryName(code: string | null | undefined): string | null {
  if (typeof code !== "string" || !/^[a-z]{2}$/i.test(code) || code.toLowerCase() === "xx") return null;
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase());
    return name && name.toUpperCase() !== code.toUpperCase() ? name : null;
  } catch {
    return null;
  }
}

/** "Near Pickens · South Carolina · United States" parts (empty parts dropped, duplicates removed). */
export function locationParts(t: { nearestPlace: string | null; regionName: string | null; countryCode: string }): string[] {
  const parts = [t.nearestPlace?.trim(), t.regionName?.trim(), countryName(t.countryCode) ?? undefined].filter((p): p is string => !!p);
  return parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
}

/** "less than an hour ago", "5 hours ago", "2 days ago", "3 weeks ago", "4 months ago", "2 years ago". */
export function formatRelativeAge(from: string | Date, now: Date = new Date()): string {
  const t = typeof from === "string" ? new Date(from) : from;
  const ms = now.getTime() - t.getTime();
  if (!Number.isFinite(ms)) return "at an unknown time";
  const hours = Math.floor(Math.max(0, ms) / 3_600_000);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (hours < 1) return "less than an hour ago";
  if (hours < 24) return plural(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 14) return plural(days, "day");
  if (days < 60) return plural(Math.floor(days / 7), "week");
  if (days < 365) return plural(Math.floor(days / 30), "month");
  return plural(Math.floor(days / 365), "year");
}

export interface OsmFeatureRef {
  type: "node" | "way" | "relation";
  id: string;
  url: string;
  editUrl: string;
}

/** The OpenStreetMap element behind a trail's sourceUrl; null for other providers or malformed URLs. */
export function osmFeatureFromUrl(url: string | null | undefined): OsmFeatureRef | null {
  if (typeof url !== "string") return null;
  const m = /^https:\/\/(?:www\.)?openstreetmap\.org\/(node|way|relation)\/(\d{1,15})\/?$/.exec(url.trim());
  if (!m) return null;
  const type = m[1] as OsmFeatureRef["type"];
  return {
    type,
    id: m[2],
    url: `https://www.openstreetmap.org/${type}/${m[2]}`,
    editUrl: `https://www.openstreetmap.org/edit?${type}=${m[2]}`,
  };
}

/**
 * A provider-supplied website as a safe absolute http(s) URL; bare domains
 * ("example.org/x") get https://. Anything else (javascript:, mailto:, …) → null.
 */
export function safeWebsiteUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().split(/[;\s]/)[0] ?? "";
  if (!s || s.length > 2048) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(s)) return null;
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Hostname for link text ("www.example.org" → "example.org"). */
export function websiteLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A phone number as a tel: href ("+1 (864) 878-9813" → "tel:+18648789813"); null when unusable. */
export function telHref(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.split(/[;,/]/)[0] ?? "";
  const plus = first.trim().startsWith("+") ? "+" : "";
  const digits = first.replace(/\D/g, "");
  if (digits.length < 2 || digits.length > 15) return null;
  return `tel:${plus}${digits}`;
}

const coord = (n: number) => Number(n.toFixed(6));

/** Driving-directions links to a point (opened by the person's own maps app). */
export function directionsLinks(p: { lat: number; lng: number }): { google: string; apple: string } {
  const dest = `${coord(p.lat)},${coord(p.lng)}`;
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${dest}`,
    apple: `https://maps.apple.com/?daddr=${dest}`,
  };
}

// ---------------------------------------------------------------------------
// Weather values
// ---------------------------------------------------------------------------

export function formatTemperature(c: number | null | undefined, units: Units): string | null {
  if (!finite(c)) return null;
  const v = units === "metric" ? c : (c * 9) / 5 + 32;
  const r = Math.round(v);
  return `${r === 0 ? 0 : r}°${units === "metric" ? "C" : "F"}`;
}

export function formatWind(ms: number | null | undefined, units: Units): string | null {
  if (!finite(ms) || ms < 0) return null;
  return units === "metric" ? `${Math.round(ms * 3.6)} km/h` : `${Math.round(ms * 2.236936)} mph`;
}

export function formatPrecipitation(mm: number | null | undefined, units: Units): string | null {
  if (!finite(mm) || mm < 0) return null;
  if (units === "metric") return `${fmt(mm, mm >= 10 ? 0 : 1)} mm`;
  const inches = mm / 25.4;
  return `${fmt(inches, inches >= 10 ? 1 : 2)} in`;
}

// ---------------------------------------------------------------------------
// Times in the trail's time zone
// ---------------------------------------------------------------------------

function validZone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** "4:58 PM" in the zone. */
export function formatClock(iso: string, tz: string | null): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: validZone(tz), hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** "2 PM" in the zone (hour strip). */
export function formatHour(iso: string, tz: string | null): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: validZone(tz), hour: "numeric" }).format(new Date(iso));
}

/** Short zone name at an instant: "EST", "GMT+1", "UTC". */
export function zoneAbbreviation(tz: string | null, at: Date = new Date()): string {
  const zone = validZone(tz);
  if (zone === "UTC") return "UTC";
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? zone;
}

/** "Today" / "Thu" for a YYYY-MM-DD date (already in the trail's zone). */
export function formatDayLabel(date: string, today: string | null): string {
  if (today && date === today) return "Today";
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(d);
}
