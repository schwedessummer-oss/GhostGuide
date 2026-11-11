import "server-only";

/**
 * Best-effort client IP for rate-limit keys. Client-supplied headers are
 * untrusted: most proxies APPEND the real client address to an existing
 * X-Forwarded-For, so its FIRST entry can be forged. Prefer headers set by
 * the hosting platform, then the LAST X-Forwarded-For hop (added by our own
 * proxy). On Vercel, x-vercel-forwarded-for / x-real-ip are platform-set.
 */
export function clientIpFrom(headers: Headers): string {
  const platform = headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip");
  if (platform) return platform.split(",")[0].trim().slice(0, 64);
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1].slice(0, 64);
  }
  return "unknown";
}
