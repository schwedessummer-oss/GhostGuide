import { describe, expect, it } from "vitest";
import { errorBodyExcerpt } from "@/server/providers/http";

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("errorBodyExcerpt", () => {
  it("strips tags, scripts and styles and collapses whitespace", () => {
    const html = "<html><head><script>var x = '<b>';</script><style>h1{}</style></head><body>\n<h1>Rate&nbsp;limited</h1>\n<p>Try   later.</p></body></html>";
    expect(errorBodyExcerpt(bytes(html), 200)).toBe("Rate limited Try later.");
  });

  it("is capped at maxChars and empty when disabled or empty", () => {
    expect(errorBodyExcerpt(bytes("x".repeat(500)), 10)).toBe("x".repeat(10));
    expect(errorBodyExcerpt(bytes("hello"), 0)).toBe("");
    expect(errorBodyExcerpt(new ArrayBuffer(0), 50)).toBe("");
  });

  it("keeps plain-text and JSON bodies readable", () => {
    expect(errorBodyExcerpt(bytes('{"error":"too many requests"}'), 100)).toBe('{"error":"too many requests"}');
  });
});
