import { describe, expect, it } from "vitest";
import { formatOrderNo } from "../src/pickup/order-number";
describe("formatOrderNo", () => {
  it("zero-pads to 4 digits and uses the 2-digit creation year", () => {
    expect(formatOrderNo(37, new Date("2026-07-23T00:00:00Z"))).toBe("ORD-26-0037");
    expect(formatOrderNo(12345, new Date("2027-01-01T00:00:00Z"))).toBe("ORD-27-12345");
  });
});
