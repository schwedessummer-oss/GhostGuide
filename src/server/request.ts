import "server-only";

/**
 * Best-effort client key for rate limits and abuse budgets. Client-supplied
 * headers are untrusted: most proxies APPEND the real client address to an
 * existing X-Forwarded-For, so its FIRST entry can be forged. Prefer headers
 * set by the hosting platform, then the LAST X-Forwarded-For hop (added by
 * our own proxy). On Vercel, x-vercel-forwarded-for / x-real-ip are
 * platform-set.
 *
 * The address is reduced to a rate-limit subject (rateLimitSubject): an
 * IPv6 client is keyed by its /64 prefix, because one subscriber routinely
 * holds a whole /64 and could otherwise get a fresh bucket for every source
 * address. IPv4 addresses stay per address.
 */
export function clientIpFrom(headers: Headers): string {
  const platform = headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip");
  if (platform) return rateLimitSubject(platform.split(",")[0]);
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return rateLimitSubject(hops[hops.length - 1]);
  }
  return "unknown";
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET_RE = /^[0-9a-f]{1,4}$/;

function validIpv4(s: string): boolean {
  const m = s.match(IPV4_RE);
  return !!m && m.slice(1).every((p) => Number(p) <= 255);
}

/**
 * The 8 hextets of an IPv6 address (lowercase hex, no leading zeros), or
 * null when the text is not an IPv6 address. Accepts "::" compression and
 * an embedded IPv4 tail ("::ffff:192.0.2.1", "64:ff9b::192.0.2.1").
 */
function ipv6Hextets(s: string): string[] | null {
  let text = s;
  const tail: string[] = [];
  const lastColon = text.lastIndexOf(":");
  if (lastColon >= 0 && text.slice(lastColon + 1).includes(".")) {
    const v4 = text.slice(lastColon + 1);
    if (!validIpv4(v4)) return null;
    const [a, b, c, d] = v4.split(".").map(Number);
    tail.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
    // "::ffff:" stays "::ffff:" → "::ffff"; "1:2:3:4:5:6:" → "1:2:3:4:5:6"
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const part = (h: string) => (h === "" ? [] : h.split(":"));
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const explicit = head.length + rest.length + tail.length;
  if (halves.length === 1 && explicit !== 8) return null;
  if (halves.length === 2 && explicit > 7) return null;
  if (![...head, ...rest].every((h) => HEXTET_RE.test(h))) return null;
  const zeros = Array.from({ length: 8 - explicit }, () => "0");
  return [...head, ...zeros, ...rest, ...tail].map((h) => parseInt(h, 16).toString(16));
}

/**
 * Rate-limit subject for one client address:
 *   IPv4                  "192.0.2.1" (a ":port" suffix is dropped)
 *   IPv4-mapped IPv6      "::ffff:192.0.2.1" → "192.0.2.1"
 *   IPv6                  its /64, e.g. "2001:db8:0:1::/64" (brackets, port and zone id ignored)
 *   anything else         the trimmed text (at most 64 characters)
 */
export function rateLimitSubject(raw: string): string {
  const text = (typeof raw === "string" ? raw : "").trim();
  if (!text) return "unknown";
  const v4port = text.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?$/);
  if (v4port && validIpv4(v4port[1])) return v4port[1];
  // "[2001:db8::1]:443" → "2001:db8::1"; "fe80::1%eth0" → "fe80::1"
  const unbracketed = text.match(/^\[([^\]]+)\](?::\d{1,5})?$/)?.[1] ?? text;
  const v6 = unbracketed.split("%")[0].toLowerCase();
  if (v6.includes(":")) {
    const h = ipv6Hextets(v6);
    if (h) {
      const mapped = h.slice(0, 5).every((x) => x === "0") && h[5] === "ffff";
      if (mapped) {
        const hi = parseInt(h[6], 16);
        const lo = parseInt(h[7], 16);
        return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
      }
      return `${h.slice(0, 4).join(":")}::/64`;
    }
  }
  return text.slice(0, 64);
}
