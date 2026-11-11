/**
 * Validate a post-sign-in redirect target. Only same-origin paths are
 * allowed. URL parsers silently strip tabs/newlines and treat backslashes
 * as slashes, so "/\t/evil.example" would become "//evil.example"
 * (protocol-relative). We therefore reject control characters and
 * backslashes outright, then resolve against a sentinel origin and require
 * the origin to be unchanged.
 */
const SENTINEL = "http://same-origin.invalid";

export function safeRedirectPath(next: unknown, fallback = "/trips"): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return fallback;
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  try {
    const u = new URL(next, SENTINEL);
    if (u.origin !== SENTINEL) return fallback;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return fallback;
  }
}
