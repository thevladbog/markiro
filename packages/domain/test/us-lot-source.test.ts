import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";

describe("typed TLC web references without network resolution", () => {
  it.each([
    "https://supplier.example.test/Source/A?lot=1",
    "http://supplier.example.test/source",
    "HTTPS://supplier.example.test/Source/A",
    "HtTp://supplier.example.test/Source/A",
    "https://example.test/é",
    "https://例え.テスト/Ä",
    "https://xn--r8jz45g.xn--zckzah/Ä",
    "https://example.test/xn--?source=xn--",
    "https://☃.net/source",
    "https://क्‌ष.test/source",
    "https://xn--11b2ezcs70k.test/source",
    "https://[2001:db8::1]:443/path",
  ])("accepts a bounded reference %s", (value) => {
    expect(domain.isTlcSourceReferenceUrl(value)).toBe(true);
  });
  it.each([
    "",
    "arbitrary source",
    "https://",
    "https://xn--/",
    "https://XN--.example.test/",
    "https://source.xn--/",
    "https://%78n--/",
    "https://xn--a.example/source",
    "https://\u200d.test/source",
    "https://\u200c.test/source",
    "https://a\u200cb.test/source",
    "file:///tmp/source",
    "javascript:alert(1)",
    "https://user:pass@example.test",
    " https://example.test",
    "https://example.test/\nsource",
    "https://example.test/a b",
    "https://example.test/\ud800",
    "https://example.test/" + "a".repeat(1024),
    "https://example.test/" + "é".repeat(510),
  ])("rejects an invalid or oversized source %j", (value) => {
    expect(domain.isTlcSourceReferenceUrl(value)).toBe(false);
  });
  it("bounds bytes without removing content or changing URL identity", () => {
    const value = "https://example.test/" + "a".repeat(1003);
    expect(domain.isTlcSourceReferenceUrl(value)).toBe(true);
    expect(value).toHaveLength(1024);
    expect(domain.isTlcSourceReferenceUrl(`${value}a`)).toBe(false);
  });
});
