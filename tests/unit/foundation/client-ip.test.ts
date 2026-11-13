/**
 * Rate-limit subjects (src/server/request.ts): IPv6 clients are keyed by
 * their /64 so rotating source addresses inside one subscriber prefix does
 * not yield fresh rate-limit buckets; IPv4 stays per address.
 */
import { describe, expect, it } from "vitest";
import { clientIpFrom, rateLimitSubject } from "@/server/request";

describe("rateLimitSubject", () => {
  it("keys IPv6 addresses by their /64, whatever the notation", () => {
    const sameNet = [
      "2001:db8:1:2::1",
      "2001:db8:1:2:ffff:ffff:ffff:ffff",
      "2001:0db8:0001:0002:0000:0000:0000:0042",
      "2001:DB8:1:2:abcd::9",
      "[2001:db8:1:2::5]",
      "[2001:db8:1:2::5]:443",
      "2001:db8:1:2::7%eth0",
      " 2001:db8:1:2:0:0:0:8 ",
    ];
    for (const ip of sameNet) expect(rateLimitSubject(ip)).toBe("2001:db8:1:2::/64");
    expect(rateLimitSubject("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(rateLimitSubject("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitSubject("fe80::1")).toBe("fe80:0:0:0::/64");
    // Embedded IPv4 in the low 32 bits (NAT64) does not change the /64.
    expect(rateLimitSubject("64:ff9b::192.0.2.33")).toBe("64:ff9b:0:0::/64");
  });

  it("reduces IPv4-mapped IPv6 to the IPv4 address and keeps IPv4 per address", () => {
    expect(rateLimitSubject("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(rateLimitSubject("::ffff:c000:207")).toBe("192.0.2.7");
    expect(rateLimitSubject("192.0.2.7")).toBe("192.0.2.7");
    expect(rateLimitSubject("192.0.2.8")).toBe("192.0.2.8");
    expect(rateLimitSubject("192.0.2.7:51234")).toBe("192.0.2.7");
  });

  it("falls back to the trimmed text for anything that is not an address", () => {
    expect(rateLimitSubject("")).toBe("unknown");
    expect(rateLimitSubject("   ")).toBe("unknown");
    expect(rateLimitSubject("not-an-ip")).toBe("not-an-ip");
    expect(rateLimitSubject("1:2:3")).toBe("1:2:3");
    expect(rateLimitSubject("1::2::3")).toBe("1::2::3");
    expect(rateLimitSubject("2001:db8:zzzz::1")).toBe("2001:db8:zzzz::1");
    expect(rateLimitSubject("999.1.1.1")).toBe("999.1.1.1");
    expect(rateLimitSubject("x".repeat(100))).toHaveLength(64);
  });
});

describe("clientIpFrom", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("uses the platform header, then the last X-Forwarded-For hop, as a rate-limit subject", () => {
    expect(clientIpFrom(h({ "x-vercel-forwarded-for": "2001:db8:aa:bb::1, 10.0.0.1" }))).toBe("2001:db8:aa:bb::/64");
    expect(clientIpFrom(h({ "x-real-ip": "2001:db8:aa:bb:1234::99" }))).toBe("2001:db8:aa:bb::/64");
    expect(clientIpFrom(h({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    // The first X-Forwarded-For entry can be forged: the last hop counts.
    expect(clientIpFrom(h({ "x-forwarded-for": "1.1.1.1, 2001:db8:5:6::1" }))).toBe("2001:db8:5:6::/64");
    expect(clientIpFrom(h({}))).toBe("unknown");
  });

  it("gives every address of one /64 the same key, and different /64s different keys", () => {
    const keys = new Set(Array.from({ length: 50 }, (_, i) => clientIpFrom(h({ "x-real-ip": `2001:db8:7:8:${i.toString(16)}::${(i * 7).toString(16)}` }))));
    expect([...keys]).toEqual(["2001:db8:7:8::/64"]);
    expect(clientIpFrom(h({ "x-real-ip": "2001:db8:7:9::1" }))).not.toBe("2001:db8:7:8::/64");
  });
});
