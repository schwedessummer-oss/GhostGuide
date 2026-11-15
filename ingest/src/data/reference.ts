/**
 * Reference lists used to validate inputs without a database. Each mirrors a
 * database table or a rule in DATA_FORMATS.md; integration tests keep the
 * database mirrors in step.
 */

/** ISO 4217 decimals of public.currencies (catalog migration). */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = {
  USD: 2, CAD: 2, MXN: 2, GTQ: 2, CRC: 2, PEN: 2, CLP: 0, ARS: 2, COP: 2, BRL: 2,
  EUR: 2, GBP: 2, CHF: 2, SEK: 2, NOK: 2, ISK: 0, PLN: 2, BGN: 2, TRY: 2,
  TZS: 2, KES: 2, MAD: 2, NAD: 2, ZAR: 2, MWK: 2, UGX: 0,
  NPR: 2, HKD: 2, INR: 2, JPY: 0, TWD: 2, KRW: 0, CNY: 2, MYR: 2, IDR: 2,
  KGS: 2, GEL: 2, JOD: 3, OMR: 3,
  NZD: 2, AUD: 2, PGK: 2,
};

/**
 * Sites never used as a source of curated facts (DATA_FORMATS.md, hard rule 2):
 * proprietary trail apps, review sites, search engines, forums, and
 * Wikipedia/Wikivoyage (they feed background text separately, never facts).
 * Matched against the URL host and its parent domains.
 */
export const BANNED_FACT_HOSTS: readonly string[] = [
  "alltrails.com", "komoot.com", "komoot.de", "gaiagps.com", "wikiloc.com", "strava.com",
  "outdooractive.com", "alpenvereinaktiv.com", "faroutguides.com", "tripadvisor.com", "tripadvisor.co.uk",
  "google.com", "goo.gl", "maps.app.goo.gl", "reddit.com", "trailforks.com", "hikingproject.com",
  "caltopo.com", "onxmaps.com", "instagram.com", "facebook.com", "traillink.com", "wta.org",
  "wikipedia.org", "wikivoyage.org", "yamap.com", "yamareco.com",
];

/** The banned host `url` belongs to, or null. */
export function bannedHost(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const banned of BANNED_FACT_HOSTS) {
    if (host === banned || host.endsWith(`.${banned}`)) return banned;
  }
  // Country variants of Google and TripAdvisor (google.de, tripadvisor.fr, ...).
  if (/(^|\.)(google|tripadvisor)\.[a-z.]{2,6}$/.test(host)) return host.replace(/^.*?((google|tripadvisor)\.)/, "$1");
  return null;
}
