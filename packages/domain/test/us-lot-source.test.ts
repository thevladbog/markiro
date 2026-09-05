import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";

describe("typed TLC web references without network resolution", () => {
  it.each([
    "https://supplier.example.test/Source/A?lot=1",
    "http://supplier.example.test/source",
    "HTTPS://supplier.example.test/Source/A",
    "HtTp://supplier.example.test/Source/A",
    "https://example.test/é",
  ])("accepts a bounded reference %s", (value) => {
    expect(domain.isTlcSourceReferenceUrl(value)).toBe(true);
  });
  it.each([
    "",
    "arbitrary source",
    "https://",
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
