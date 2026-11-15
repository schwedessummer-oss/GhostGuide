/**
 * Licence mapper: turns a licence as found upstream (an SPDX-style code, a
 * Commons "LicenseShortName", a licence name or a licence URL) into one of
 * our licence codes, and decides whether we may use it.
 *
 * The table below mirrors public.licenses (supabase/migrations/
 * 20261115001000_provenance.sql); an integration test keeps the two in step.
 * The database is still the gate: source_records only accept allowed codes.
 *
 * Anything non-commercial (NC), no-derivatives (ND), proprietary or not
 * recognised is rejected. We never guess a licence: an unrecognised string is
 * "license_unknown", never the nearest match.
 */

export interface LicenceInfo {
  allowed: boolean;
  photoOk: boolean;
}

export const LICENCES: Readonly<Record<string, LicenceInfo>> = {
  "CC0-1.0": { allowed: true, photoOk: true },
  "PDDL-1.0": { allowed: true, photoOk: true },
  "PD-USGov": { allowed: true, photoOk: true },
  "PD-other": { allowed: true, photoOk: true },
  "CC-BY-2.0": { allowed: true, photoOk: true },
  "CC-BY-2.5": { allowed: true, photoOk: true },
  "CC-BY-3.0": { allowed: true, photoOk: true },
  "CC-BY-4.0": { allowed: true, photoOk: true },
  "CC-BY-3.0-AU": { allowed: true, photoOk: true },
  "CC-BY-SA-2.0": { allowed: true, photoOk: true },
  "CC-BY-SA-2.5": { allowed: true, photoOk: true },
  "CC-BY-SA-3.0": { allowed: true, photoOk: true },
  "CC-BY-SA-4.0": { allowed: true, photoOk: true },
  "ODbL-1.0": { allowed: true, photoOk: false },
  "OGL-UK-3.0": { allowed: true, photoOk: false },
  "OGL-CA-2.0": { allowed: true, photoOk: false },
  "Etalab-2.0": { allowed: true, photoOk: false },
  "DL-DE-BY-2.0": { allowed: true, photoOk: false },
  "NLOD-2.0": { allowed: true, photoOk: false },
  "GSI-JP": { allowed: true, photoOk: false },
  "OGDL-TW-1.0": { allowed: true, photoOk: false },
  "KOGL-1": { allowed: true, photoOk: false },
  "GODL-IN": { allowed: true, photoOk: false },
  "CITED-FACT": { allowed: true, photoOk: false },
  // Our own grant for user uploads (photos migration). Never the licence of fetched content.
  "GG-USER-GRANT-1": { allowed: true, photoOk: true },
  "CC-BY-NC-2.0": { allowed: false, photoOk: false },
  "CC-BY-NC-3.0": { allowed: false, photoOk: false },
  "CC-BY-NC-4.0": { allowed: false, photoOk: false },
  "CC-BY-ND-2.0": { allowed: false, photoOk: false },
  "CC-BY-ND-3.0": { allowed: false, photoOk: false },
  "CC-BY-ND-4.0": { allowed: false, photoOk: false },
  "CC-BY-NC-SA-2.0": { allowed: false, photoOk: false },
  "CC-BY-NC-SA-3.0": { allowed: false, photoOk: false },
  "CC-BY-NC-SA-4.0": { allowed: false, photoOk: false },
  "CC-BY-NC-ND-4.0": { allowed: false, photoOk: false },
  PROPRIETARY: { allowed: false, photoOk: false },
  UNKNOWN: { allowed: false, photoOk: false },
};

export type LicenceRejection = "license_not_allowed" | "license_unknown" | "photo_license_not_allowed";

export type LicenceVerdict =
  | { ok: true; code: string; input: string }
  | {
      ok: false;
      /** Our code when the licence was recognised (e.g. CC-BY-NC-4.0), else null. */
      code: string | null;
      reason: LicenceRejection;
      input: string;
    };

/** Codes an upstream licence string can map to (not our user-upload grant). */
const CODE_BY_LOWER = new Map(
  Object.keys(LICENCES)
    .filter((c) => !c.startsWith("GG-USER-GRANT-"))
    .map((c) => [c.toLowerCase(), c]),
);

/** SPDX ids and other spellings that differ from our codes. */
const ALIASES: Record<string, string> = {
  "ogl-canada-2.0": "OGL-CA-2.0",
  "etalab-2.0": "Etalab-2.0",
  "ogdl-taiwan-1.0": "OGDL-TW-1.0",
  "ogl-uk-3.0": "OGL-UK-3.0",
  "odbl": "ODbL-1.0",
  "cc0": "CC0-1.0",
  "cc-0": "CC0-1.0",
  "cc zero": "CC0-1.0",
  "pd-usgov": "PD-USGov",
};

type Parsed = { code: string | null; restricted: boolean };

/** A recognised Creative Commons licence (by / by-sa / by-nc / ...). */
function creativeCommons(elements: string[], version: string, port: string | null): Parsed {
  const parts = elements.map((e) => e.toLowerCase());
  if (parts[0] !== "by") return { code: null, restricted: false };
  const restricted = parts.includes("nc") || parts.includes("nd");
  let code = `CC-${parts.map((p) => p.toUpperCase()).join("-")}-${version}`;
  if (port) {
    // Ported licences: only the ones in our allow-list (CC BY 3.0 AU) are
    // recognised; other ports stay unknown until reviewed.
    code = `${code}-${port.toUpperCase()}`;
  }
  return { code: LICENCES[code] ? code : null, restricted };
}

const CC_WORDS: Array<[RegExp, string]> = [
  [/non-?commercial/i, "nc"],
  [/no-?deriv(s|atives|ative works)?/i, "nd"],
  [/share-?alike/i, "sa"],
];

function parseUrl(raw: string): Parsed | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const p = u.pathname.toLowerCase().replace(/\/+$/, "");
  if (host === "creativecommons.org") {
    const cc = p.match(/^\/licenses\/(by(?:-(?:nc|nd|sa))*)\/(\d\.\d)(?:\/([a-z]{2}))?(?:\/.*)?$/);
    if (cc) return creativeCommons(cc[1].split("-"), cc[2], cc[3] ?? null);
    if (/^\/publicdomain\/zero\/1\.0(\/.*)?$/.test(p)) return { code: "CC0-1.0", restricted: false };
    if (/^\/publicdomain\/mark\/1\.0(\/.*)?$/.test(p)) return { code: "PD-other", restricted: false };
    return { code: null, restricted: false };
  }
  if (host === "opendatacommons.org") {
    if (p.startsWith("/licenses/odbl")) return { code: "ODbL-1.0", restricted: false };
    if (p.startsWith("/licenses/pddl")) return { code: "PDDL-1.0", restricted: false };
    return { code: null, restricted: false };
  }
  if (host === "nationalarchives.gov.uk" && /\/open-government-licence\/version\/3$/.test(p)) {
    return { code: "OGL-UK-3.0", restricted: false };
  }
  if (host === "open.canada.ca" && /open-government-licen[cs]e-canada$/.test(p)) return { code: "OGL-CA-2.0", restricted: false };
  if (host === "etalab.gouv.fr" && (p.includes("licence-ouverte-open-licence") || /licence-ouverte-v2\.0/.test(p))) {
    return { code: "Etalab-2.0", restricted: false };
  }
  if (host === "govdata.de" && p === "/dl-de/by-2-0") return { code: "DL-DE-BY-2.0", restricted: false };
  if (host === "data.norge.no" && /^\/nlod\/(en|no)\/2\.0$/.test(p)) return { code: "NLOD-2.0", restricted: false };
  if (host === "data.gov.tw" && p === "/license") return { code: "OGDL-TW-1.0", restricted: false };
  if (host === "data.gov.in" && p === "/government-open-data-license-india") return { code: "GODL-IN", restricted: false };
  return { code: null, restricted: false };
}

function parseText(raw: string): Parsed {
  const s = raw.trim().replace(/\s+/g, " ");
  const lower = s.toLowerCase();

  const exact = CODE_BY_LOWER.get(lower) ?? ALIASES[lower];
  if (exact === "UNKNOWN") return { code: null, restricted: false };
  if (exact) return { code: exact, restricted: !LICENCES[exact].allowed };

  // "CC BY-SA 4.0", "cc-by-nc-sa-2.0", "CC BY 3.0 AU", "CC-BY-SA-3.0-AT"
  const short = lower.match(/^cc[- ]?(by(?:-(?:nc|nd|sa))*)[- ](\d\.\d)(?:[- ]([a-z]{2}))?$/);
  if (short) return creativeCommons(short[1].split("-"), short[2], short[3] ?? null);

  // "Creative Commons Attribution-ShareAlike 4.0 International"
  const long = s.match(/^creative commons attribution(.*?)(\d\.\d)(?: (international|generic|unported))?$/i);
  if (long) {
    const elements = ["by"];
    for (const [re, el] of CC_WORDS) if (re.test(long[1])) elements.push(el);
    // Canonical CC element order: by, nc, nd, sa.
    const order = ["by", "nc", "nd", "sa"];
    elements.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const rest = long[1].replace(/[-\s]/g, "").replace(/noncommercial|noderivatives|noderivs|noderivativeworks|sharealike/gi, "");
    if (rest !== "") return { code: null, restricted: elements.includes("nc") || elements.includes("nd") };
    return creativeCommons(elements, long[2], null);
  }
  if (/^(cc0|cc-0|cc zero)\b/.test(lower) || /creative commons zero/.test(lower)) return { code: "CC0-1.0", restricted: false };

  if (/^(public domain|pd)\b/.test(lower) || /^pd-/.test(lower)) {
    if (/us ?gov|united states government|federal government|pd-usgov/.test(lower)) return { code: "PD-USGov", restricted: false };
    return { code: "PD-other", restricted: false };
  }
  if (/^(odbl|open database licen[cs]e)\b/.test(lower)) return { code: "ODbL-1.0", restricted: false };
  if (/^open government licen[cs]e\b/.test(lower)) {
    if (/canada/.test(lower)) return { code: "OGL-CA-2.0", restricted: false };
    if (/(v|version )3(\.0)?\b/.test(lower)) return { code: "OGL-UK-3.0", restricted: false };
    return { code: null, restricted: false };
  }
  if (/^licence ouverte\b/.test(lower) && /2\.0/.test(lower)) return { code: "Etalab-2.0", restricted: false };
  if (/^dl-de[/-]by-2[.-]0$/.test(lower)) return { code: "DL-DE-BY-2.0", restricted: false };
  if (/^nlod\b/.test(lower) && /2\.0/.test(lower)) return { code: "NLOD-2.0", restricted: false };
  const kogl = lower.match(/^kogl[- ]?(?:type[- ]?)?([1-4])$/);
  if (kogl) return kogl[1] === "1" ? { code: "KOGL-1", restricted: false } : { code: null, restricted: true };
  if (/all rights reserved|^©|^\(c\)|^copyright\b|proprietary/.test(lower)) return { code: "PROPRIETARY", restricted: true };
  return { code: null, restricted: false };
}

/** Our licence code for `input`, or null when it is not recognised. */
export function normaliseLicence(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const parsed = /^https?:\/\//i.test(raw) ? parseUrl(raw) : parseText(raw);
  return parsed?.code ?? null;
}

/**
 * Decide whether content under `input` may be stored. Photos use the stricter
 * photo list (PLAN §4.2).
 */
export function checkLicence(input: string, opts: { photo?: boolean } = {}): LicenceVerdict {
  const raw = (input ?? "").trim();
  const parsed: Parsed = raw ? ((/^https?:\/\//i.test(raw) ? parseUrl(raw) : parseText(raw)) ?? { code: null, restricted: false }) : { code: null, restricted: false };
  const code = parsed.code === "UNKNOWN" ? null : parsed.code;
  if (parsed.restricted || (code && !LICENCES[code].allowed)) {
    return { ok: false, code, reason: "license_not_allowed", input: raw };
  }
  if (!code) return { ok: false, code: null, reason: "license_unknown", input: raw };
  if (opts.photo && !LICENCES[code].photoOk) return { ok: false, code, reason: "photo_license_not_allowed", input: raw };
  return { ok: true, code, input: raw };
}
