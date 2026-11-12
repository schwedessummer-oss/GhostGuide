import "server-only";
import type { EmergencyNumbersDto } from "@/domain/catalog";

/**
 * Emergency telephone numbers by country, shown on trail pages.
 *
 * EDITORIAL TABLE — REVIEW PERIODICALLY. Numbers change (new unified
 * numbers, retired legacy ones). Re-verify every entry against the
 * national government source at least every 6 months and whenever a country
 * announces a change, then update EMERGENCY_NUMBERS_LAST_REVIEWED.
 *
 * Inclusion rule: a country is listed only when we are highly confident in
 * its numbers. Within an entry:
 *   primary                   the number to call first (a unified number
 *                             where one works nationwide, else the police,
 *                             who coordinate search and rescue in most places)
 *   police / ambulance / fire set ONLY when that service has its own number
 *                             that differs from `primary` and that we are
 *                             confident in; null means "use primary" (or no
 *                             verified separate number) — never a guess
 * Countries not listed get primary null and an honest note; the 112 hint in
 * that note is phrased as a possibility, not a promise.
 *
 * Ghost Guide never contacts emergency services: notes say so, and must
 * never suggest otherwise.
 */

export const EMERGENCY_NUMBERS_LAST_REVIEWED = "2026-11-12";

export const EMERGENCY_NUMBERS_SOURCE =
  `Ghost Guide emergency number table (last reviewed ${EMERGENCY_NUMBERS_LAST_REVIEWED}), compiled from national ` +
  "government emergency-service information and the European Commission's 112 information.";

export const UNKNOWN_COUNTRY_NOTE =
  "Ghost Guide does not have a verified emergency number for this country. 112 reaches emergency services from mobile phones in many countries, but not everywhere — confirm the local number before you go.";

/** Added to every answer. */
export const GENERAL_NOTES: readonly string[] = [
  "Ghost Guide cannot call emergency services for you. Dial the number yourself.",
  "Phone signal is often unavailable on trails. Do not rely on being able to call.",
];

/** Valid dial string: 2–6 digits. */
export const DIAL_STRING_RE = /^[0-9]{2,6}$/;

export interface EmergencyEntry {
  /** English country name, for notes and admin views. */
  name: string;
  primary: string;
  police?: string;
  ambulance?: string;
  fire?: string;
  notes?: string[];
}

const EU_112_NOTE = "112 reaches police, ambulance and fire services anywhere in the European Union.";
const eu = (name: string, extra: Omit<EmergencyEntry, "name" | "primary"> = {}): EmergencyEntry => ({
  name,
  primary: "112",
  ...extra,
  notes: [EU_112_NOTE, ...(extra.notes ?? [])],
});
const single = (name: string, number: string, notes?: string[]): EmergencyEntry => ({
  name,
  primary: number,
  notes: [`${number} reaches police, ambulance and fire services.`, ...(notes ?? [])],
});

/** Keyed by lower-case ISO 3166-1 alpha-2 code. */
export const EMERGENCY_NUMBERS: Readonly<Record<string, EmergencyEntry>> = {
  // North America and US territories
  us: single("United States", "911"),
  pr: single("Puerto Rico", "911"),
  vi: single("US Virgin Islands", "911"),
  gu: single("Guam", "911"),
  ca: single("Canada", "911"),
  mx: single("Mexico", "911"),
  cr: single("Costa Rica", "911"),

  // European Union (112 everywhere)
  at: eu("Austria", { police: "133", ambulance: "144", fire: "122", notes: ["Alpine emergencies (mountain rescue): 140."] }),
  be: eu("Belgium", { police: "101" }),
  bg: eu("Bulgaria"),
  hr: eu("Croatia", { police: "192", ambulance: "194", fire: "193" }),
  cy: eu("Cyprus"),
  cz: eu("Czechia", { police: "158", ambulance: "155", fire: "150" }),
  dk: eu("Denmark"),
  ee: eu("Estonia"),
  fi: eu("Finland"),
  fr: eu("France", { police: "17", ambulance: "15", fire: "18" }),
  de: eu("Germany", { police: "110" }),
  gr: eu("Greece", { police: "100", ambulance: "166", fire: "199" }),
  hu: eu("Hungary", { police: "107", ambulance: "104", fire: "105" }),
  ie: eu("Ireland", { notes: ["999 also works."] }),
  it: eu("Italy", { police: "113", ambulance: "118", fire: "115" }),
  lv: eu("Latvia"),
  lt: eu("Lithuania"),
  lu: eu("Luxembourg"),
  mt: eu("Malta"),
  nl: eu("Netherlands"),
  pl: eu("Poland", { police: "997", ambulance: "999", fire: "998" }),
  pt: eu("Portugal"),
  ro: eu("Romania"),
  sk: eu("Slovakia", { police: "158", ambulance: "155", fire: "150" }),
  si: eu("Slovenia", { police: "113" }),
  es: eu("Spain"),
  se: eu("Sweden"),

  // Rest of Europe
  gb: { name: "United Kingdom", primary: "999", notes: ["112 also works.", "For mountain or cave rescue, call 999 or 112, ask for the police, then mountain rescue."] },
  ch: { name: "Switzerland", primary: "112", police: "117", ambulance: "144", fire: "118", notes: ["Rega air rescue: 1414."] },
  li: { name: "Liechtenstein", primary: "112", police: "117", ambulance: "144", fire: "118" },
  no: { name: "Norway", primary: "112", ambulance: "113", fire: "110", notes: ["112 is the police, who coordinate search and rescue."] },
  is: single("Iceland", "112"),
  ad: single("Andorra", "112"),
  ge: single("Georgia", "112"),
  tr: single("Türkiye", "112"),

  // Oceania
  au: { name: "Australia", primary: "000", notes: ["000 reaches police, ambulance and fire services.", "112 also works from mobile phones."] },
  nz: single("New Zealand", "111"),

  // Asia
  jp: { name: "Japan", primary: "119", police: "110", notes: ["119 is fire and ambulance.", "For mountain accidents, call 110 (police) or 119."] },
  kr: { name: "South Korea", primary: "119", police: "112", notes: ["119 is fire, ambulance and rescue. In South Korea, 112 is the police."] },
  cn: { name: "China", primary: "110", ambulance: "120", fire: "119" },
  tw: { name: "Taiwan", primary: "119", police: "110", notes: ["119 is fire, ambulance and rescue."] },
  hk: single("Hong Kong", "999"),
  in: { name: "India", primary: "112", police: "100", fire: "101", notes: ["112 is India's national emergency number."] },
  np: { name: "Nepal", primary: "100", fire: "101", notes: ["100 is the police."] },
  th: { name: "Thailand", primary: "191", ambulance: "1669", fire: "199", notes: ["191 is the police.", "Tourist Police (English spoken): 1155."] },
  id: { name: "Indonesia", primary: "110", fire: "113", notes: ["110 is the police.", "112 also works in many areas."] },
  ph: single("Philippines", "911"),
  my: { name: "Malaysia", primary: "999", notes: ["999 reaches police, ambulance and fire services.", "112 also works from mobile phones."] },
  sg: { name: "Singapore", primary: "999", ambulance: "995", fire: "995", notes: ["999 is the police."] },
  vn: { name: "Vietnam", primary: "113", fire: "114", ambulance: "115", notes: ["113 is the police."] },
  il: { name: "Israel", primary: "100", ambulance: "101", fire: "102", notes: ["100 is the police."] },
  ae: { name: "United Arab Emirates", primary: "999", ambulance: "998", fire: "997", notes: ["999 is the police."] },

  // Africa
  za: { name: "South Africa", primary: "10111", ambulance: "10177", notes: ["10111 is the police.", "112 also works from mobile phones."] },
  ke: single("Kenya", "999"),

  // South America
  br: {
    name: "Brazil",
    primary: "190",
    ambulance: "192",
    fire: "193",
    notes: ["190 is the police.", "The fire brigade (193) also carries out rescues."],
  },
  ar: {
    name: "Argentina",
    primary: "101",
    ambulance: "107",
    fire: "100",
    notes: ["101 is the police.", "911 also works in Buenos Aires and many other cities."],
  },
  cl: { name: "Chile", primary: "133", ambulance: "131", fire: "132", notes: ["133 is the police (Carabineros)."] },
  pe: { name: "Peru", primary: "105", ambulance: "106", fire: "116", notes: ["105 is the police."] },
  co: single("Colombia", "123"),
  ec: single("Ecuador", "911"),
};

/** "UK" is not an ISO code but is common; everything else must be ISO alpha-2. */
const ALIASES: Record<string, string> = { uk: "gb" };

/** Lower-case ISO alpha-2 code, or null for missing / malformed / the catalog's "xx" (unknown). */
export function normalizeCountryCode(code: string | null | undefined): string | null {
  if (typeof code !== "string") return null;
  const c = code.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(c) || c === "xx") return null;
  return ALIASES[c] ?? c;
}

const distinct = (n: string | undefined, primary: string): string | null => (n && n !== primary ? n : null);

/**
 * Emergency numbers for a country (ISO alpha-2, any case). Unknown or
 * unlisted countries get primary null and UNKNOWN_COUNTRY_NOTE. Never throws.
 */
export function emergencyNumbersFor(countryCode: string | null | undefined): EmergencyNumbersDto {
  const code = normalizeCountryCode(countryCode);
  const entry = code ? EMERGENCY_NUMBERS[code] : undefined;
  if (!entry) {
    return {
      countryCode: code,
      primary: null,
      police: null,
      ambulance: null,
      fire: null,
      notes: [UNKNOWN_COUNTRY_NOTE, ...GENERAL_NOTES],
      source: EMERGENCY_NUMBERS_SOURCE,
    };
  }
  return {
    countryCode: code,
    primary: entry.primary,
    police: distinct(entry.police, entry.primary),
    ambulance: distinct(entry.ambulance, entry.primary),
    fire: distinct(entry.fire, entry.primary),
    notes: [...(entry.notes ?? []), ...GENERAL_NOTES],
    source: EMERGENCY_NUMBERS_SOURCE,
  };
}
