import { describe, expect, it } from "vitest";
import { normalizePairSource } from "../src/modules/kiosk/pair-source";

describe("normalizePairSource", () => {
  it("leaves an IPv4 address unchanged", () => {
    expect(normalizePairSource("203.0.113.7")).toBe("203.0.113.7");
  });

  it("leaves an opaque non-IP key (the global bucket) unchanged", () => {
    expect(normalizePairSource("*")).toBe("*");
  });

  it("collapses a full 8-hextet IPv6 address to its /64 prefix", () => {
    expect(normalizePairSource("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe(
      "2001:db8:85a3:8d3::/64",
    );
  });

  it("collapses two addresses in the same /64 to the same key", () => {
    const a = normalizePairSource("2001:db8:1234:5678::1");
    const b = normalizePairSource("2001:db8:1234:5678:ffff:ffff:ffff:ffff");
    expect(a).toBe(b);
  });

  it("keeps two addresses in different /64s apart", () => {
    const a = normalizePairSource("2001:db8:1234:5678::1");
    const b = normalizePairSource("2001:db8:1234:5679::1");
    expect(a).not.toBe(b);
  });

  it("normalizes the loopback address", () => {
    expect(normalizePairSource("::1")).toBe("0:0:0:0::/64");
  });

  it("strips a zone id before normalizing", () => {
    expect(normalizePairSource("fe80::1%eth0")).toBe(normalizePairSource("fe80::1"));
  });

  it("keys an IPv4-mapped IPv6 address on its embedded IPv4 address", () => {
    expect(normalizePairSource("::ffff:192.0.2.1")).toBe("192.0.2.1");
  });

  it("tolerates an already-CIDR'd input", () => {
    expect(normalizePairSource("2001:db8:1234:5678::1/64")).toBe("2001:db8:1234:5678::/64");
  });
});
