/**
 * Structured logger with redaction. Never log secrets, tokens, emails,
 * phone numbers, coordinates or free-text message bodies. Keys matching the
 * patterns below are replaced with "[redacted]" at any depth.
 */
const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|cookie|api[-_]?key|email|phone|lat|lng|lon|latitude|longitude|coords?|location|access[-_]?code|body|transcript|card|signature)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return redactString(value);
  return value;
}

// UUIDs and ISO dates/timestamps are digit-heavy but not personal data:
// shield them so the phone/coordinate patterns below never mangle them.
const PROTECTED = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/gi;

/** Scrub obvious secrets / PII patterns that slip into strings. */
export function redactString(s: string): string {
  const shielded: string[] = [];
  const masked = s.replace(PROTECTED, (m) => {
    shielded.push(m);
    return `\u0000${shielded.length - 1}\u0000`;
  });
  return masked
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(sk|rk|pk|whsec)_(test|live)?_?[A-Za-z0-9]{8,}\b/g, "[key]")
    .replace(/-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/g, "[coords]")
    // phone numbers: 10–15 digits with optional separators
    .replace(/(?<![\w-])\+?\d(?:[\s().-]{0,2}\d){9,14}(?![\w-])/g, "[phone]")
    .replace(/\u0000(\d+)\u0000/g, (_, i) => shielded[Number(i)])
    .slice(0, 2000);
}

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, event: string, data?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  const line = JSON.stringify({ level, event, at: new Date().toISOString(), ...(data ? (redact(data) as object) : {}) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, data?: Record<string, unknown>) => emit("debug", event, data),
  info: (event: string, data?: Record<string, unknown>) => emit("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => emit("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => emit("error", event, data),
};
