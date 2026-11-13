import "server-only";
import { createHash } from "node:crypto";

/**
 * URL slugs for catalog trails: /trail/<country>/<region>/<slug>.
 *
 * Rules
 *  - Source text: an ASCII `name:en` when the provider has one (readable
 *    URLs for non-Latin names), else the name with common Latin diacritics
 *    transliterated (NFKD + combining marks stripped; ß→ss, æ→ae, ø→o,
 *    ł→l, đ→d, þ→th, œ→oe, ...), else a non-ASCII `name:en`.
 *  - Only [a-z0-9] survive; everything else separates words with "-";
 *    apostrophes are dropped ("Devil's Den" → "devils-den"), "&" → "and".
 *  - Names with nothing transliterable (Japanese, Chinese, Cyrillic, ...)
 *    get "trail-<10 hex chars>", a stable hash of the provider id, so the
 *    slug never changes between refreshes and never invents a name.
 *  - At most 80 characters, cut at a word boundary when one is reasonably
 *    close (the DB allows 120, leaving room for a "-<n>" suffix).
 *  - Uniqueness within (country, region) is the caller's job: pickFreeSlug
 *    appends "-2", "-3", ... (see repository.ts for the race-safe insert).
 *    Old paths of trails that moved (catalog_trail_redirects, redirects.ts)
 *    count as taken, so a path never passes from one trail to another.
 *
 * Region slugs follow the same rules with "unknown" as the fallback, and
 * country codes are ISO 3166-1 alpha-2 lower case with "xx" for unknown.
 * Pure and deterministic.
 */

export const SLUG_MAX_LENGTH = 80;
export const REGION_SLUG_MAX_LENGTH = 80;
export const UNKNOWN_REGION_SLUG = "unknown";
export const UNKNOWN_COUNTRY_CODE = "xx";
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Letters NFKD does not decompose into a base letter + combining mark. */
const SPECIAL_LETTERS: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
  ħ: "h",
  ŧ: "t",
  ŋ: "n",
  ĸ: "k",
  ſ: "s",
  ŀ: "l",
  ƒ: "f",
};
const SPECIAL_RE = new RegExp(`[${Object.keys(SPECIAL_LETTERS).join("")}]`, "g");
const COMBINING_MARKS_RE = /\p{M}+/gu;
const APOSTROPHES_RE = /['’ʼ`´]/g;

/** Lower-case [a-z0-9-] text from any string; "" when nothing survives. */
export function toSlugText(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(SPECIAL_RE, (ch) => SPECIAL_LETTERS[ch] ?? "")
    .replace(COMBINING_MARKS_RE, "")
    .replace(APOSTROPHES_RE, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Cut a slug to `max` characters at a word boundary ("-") when the boundary
 * keeps at least half of the allowed length; otherwise cut hard. Never ends
 * with "-".
 */
export function cutSlug(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const head = slug.slice(0, max);
  if (slug[max] === "-") return head.replace(/-+$/, "");
  const boundary = head.lastIndexOf("-");
  const cut = boundary >= Math.floor(max / 2) ? head.slice(0, boundary) : head;
  return cut.replace(/-+$/, "");
}

const isPrintableAscii = (s: string) => /^[\x20-\x7e]+$/.test(s);

/** Short, stable hex hash (10 chars) of a key, e.g. a provider id. */
export function shortHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 10);
}

/**
 * Base slug for a trail (before any uniqueness suffix).
 *
 * @param name     the trail name as mapped (any script)
 * @param nameEn   the English name when the provider has one
 * @param fallbackKey stable key hashed when no text survives (the provider id)
 */
export function slugify(name: string, nameEn: string | null | undefined, fallbackKey: string): string {
  const en = typeof nameEn === "string" ? nameEn.trim() : "";
  const candidates = [en && isPrintableAscii(en) ? en : "", name, en];
  for (const candidate of candidates) {
    const slug = cutSlug(toSlugText(candidate), SLUG_MAX_LENGTH);
    if (slug) return slug;
  }
  return `trail-${shortHash(String(fallbackKey))}`;
}

/** Region slug ("British Columbia" → "british-columbia"); "unknown" when nothing survives. */
export function regionSlugFor(regionName: string | null | undefined): string {
  return cutSlug(toSlugText(regionName), REGION_SLUG_MAX_LENGTH) || UNKNOWN_REGION_SLUG;
}

/** ISO 3166-1 alpha-2 in lower case, or "xx" when missing/invalid. */
export function countryCodeOrUnknown(code: string | null | undefined): string {
  const c = typeof code === "string" ? code.trim().toLowerCase() : "";
  return /^[a-z]{2}$/.test(c) ? c : UNKNOWN_COUNTRY_CODE;
}

/** base for n = 1, "base-n" otherwise. */
export function slugWithSuffix(base: string, n: number): string {
  return n <= 1 ? base : `${base}-${n}`;
}

/**
 * First free slug among base, base-2, base-3, ... given the slugs already
 * taken in the same (country, region). `maxTries` bounds the search; past it
 * a hash-suffixed slug is returned (still deterministic for the inputs).
 */
export function pickFreeSlug(base: string, taken: ReadonlySet<string>, maxTries = 10_000): string {
  for (let n = 1; n <= maxTries; n++) {
    const candidate = slugWithSuffix(base, n);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${shortHash(`${base}:${taken.size}`)}`;
}
