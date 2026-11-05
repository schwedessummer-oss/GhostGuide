/**
 * Output hygiene for untrusted AI text (pure, deterministic).
 *
 *  sanitizeAiText  strips HTML, markdown and URLs, collapses whitespace and
 *                  caps the length (words and characters).
 *  guardAiText     rejects text that contains a number not present in the
 *                  facts the model was given, or a banned claim (safety,
 *                  guarantees, "open", permits, closures, rescue, weather,
 *                  wildlife, history…). Callers fall back to the template.
 */

export const AI_MAX_WORDS = 120;
export const AI_MAX_CHARS = 900;

export function sanitizeAiText(input: string, maxWords = AI_MAX_WORDS, maxChars = AI_MAX_CHARS): string {
  let s = input
    // HTML tags and entities
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    // markdown links/images: keep the visible text only
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    // URLs and bare domains
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/\b[a-z0-9-]+\.(?:com|org|net|gov|io|app|dev|us)\b\S*/gi, " ")
    // code fences / inline code / emphasis / headings / quotes / list bullets / tables
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_~#>|]/g, " ")
    .replace(/^\s*(?:[-+]|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

  let truncated = false;
  const words = s.split(" ").filter(Boolean);
  if (words.length > maxWords) {
    s = words.slice(0, maxWords).join(" ");
    truncated = true;
  }
  if (s.length > maxChars) {
    s = s.slice(0, maxChars);
    truncated = true;
  }
  if (truncated) {
    // End at the last full sentence when there is a reasonable one, else mark the cut.
    const lastStop = Math.max(s.lastIndexOf(". "), s.lastIndexOf("! "), s.lastIndexOf("? "));
    s = lastStop > s.length * 0.4 ? s.slice(0, lastStop + 1) : `${s.replace(/[,;:\s]+$/, "")}…`;
  }
  return s.trim();
}

const TIME_RE = /\b(\d{1,2}):(\d{2})\b/g;
const NUMBER_RE = /\d+(?:\.\d+)?/g;

function normalizeTime(h: string, m: string): string {
  return `${Number(h)}:${m}`;
}

function normalizeNumber(n: string): string {
  return String(Number(n));
}

/** Extract normalized time and number tokens from text ("1,312" → "1312", "08:30" → "8:30"). */
export function extractNumericTokens(text: string): { times: Set<string>; numbers: Set<string> } {
  const cleaned = text.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const times = new Set<string>();
  const withoutTimes = cleaned.replace(TIME_RE, (_m, h: string, mm: string) => {
    times.add(normalizeTime(h, mm));
    return " ";
  });
  const numbers = new Set<string>();
  for (const m of withoutTimes.match(NUMBER_RE) ?? []) numbers.add(normalizeNumber(m));
  // Times also contribute their parts (e.g. "8 h" from "08:00" is NOT added; only exact tokens).
  return { times, numbers };
}

/** Phrases the AI must never assert (it has no authority over these topics). */
export const BANNED_CLAIMS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(?:un)?safe(?:ly|r|st|ty)?\b/i, label: "safety claim" },
  { pattern: /\bguarantee/i, label: "guarantee" },
  { pattern: /\b(?:re)?open(?:s|ed)?\b/i, label: "open/closed status" },
  { pattern: /\bno permits?\b|\bpermit[- ]free\b|\bwithout (?:a )?permit\b|\b(?:isn't|is not|not) required\b/i, label: "permit claim" },
  { pattern: /\bno closures?\b|\b(?:isn't|is not|not) closed\b|\bclosure[- ]free\b/i, label: "closure claim" },
  { pattern: /\brescue\b|\bemergenc|\bSOS\b|\bmonitor(?:s|ed|ing)?\b/i, label: "rescue/monitoring claim" },
  { pattern: /\bweather\b|\bforecast|\bsunny\b|\brain(?:y|s)?\b|\bsnow|\bic[ey]\b|\bstorm/i, label: "weather claim" },
  { pattern: /\bwildlife\b|\bbears?\b|\bcougars?\b|\bsnakes?\b|\bwolves\b/i, label: "wildlife claim" },
  { pattern: /\bhistor(?:y|ic|ical)\b/i, label: "history claim" },
  { pattern: /\bwheelchair|\bfully accessible\b|\baccessible to (?:all|everyone)\b/i, label: "accessibility claim" },
  { pattern: /\b(?:risk|hazard|danger)[- ]free\b|\bno risk\b|\bdanger/i, label: "risk claim" },
  { pattern: /\bsunset\b|\bdaylight\b/i, label: "daylight claim" },
  { pattern: /\bconditions? (?:is|are|look|will)\b/i, label: "conditions claim" },
];

export type GuardResult = { ok: true } | { ok: false; reason: string };

export function guardAiText(text: string, facts: string): GuardResult {
  if (!text.trim()) return { ok: false, reason: "empty output" };
  for (const b of BANNED_CLAIMS) {
    if (b.pattern.test(text)) return { ok: false, reason: `banned ${b.label}` };
  }
  const allowed = extractNumericTokens(facts);
  const found = extractNumericTokens(text);
  for (const t of found.times) {
    if (!allowed.times.has(t)) return { ok: false, reason: `time ${t} not in facts` };
  }
  for (const n of found.numbers) {
    if (!allowed.numbers.has(n)) return { ok: false, reason: `number ${n} not in facts` };
  }
  return { ok: true };
}
